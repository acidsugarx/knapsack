/**
 * Core compression pipeline — agent-agnostic tool output compression.
 *
 * Extracted from the Pi-specific `compressionHook` so that every adapter
 * (Pi, Claude Code, OpenCode, MCP) shares the same compression logic.
 *
 * ## Flow
 *
 * 1. Check output cache (CacheAligner + Live-Zone) — skip on hit
 * 2. Detect & redact secrets on original content
 * 3. Redact base64 image data URIs
 * 4. Protect XML tags via placeholders
 * 5. Dispatch to strategy registry (auto-detect by content)
 * 6. Re-detect & redact secrets on compressed body
 * 7. Restore XML tag placeholders
 * 8. Cache original in CCR (~/.knapsack/cache)
 * 9. Record compression stats
 * 10. Check drift against declared anchors
 * 11. Cache the fully processed output for future hits
 *
 * @module core-pipeline
 */

import { cache } from "../pillar1-compression/ccr";
import { redactImages } from "../pillar1-compression/image";
import { outputCache } from "../pillar1-compression/output-cache";
import type { StrategyRegistry } from "../pillar1-compression/plugin";
import { protectTags, restoreTags } from "../pillar1-compression/tag-protector";
import { checkDrift } from "../pillar2-memory/drift";
import { formatCommandOutput } from "./command-formatters";
import { commandTracker } from "./command-tracker";
import type { KnapsackDB } from "./database";
import { extractErrors, formatErrorBlock } from "./error-extractor";
import { sha256 } from "./hash";
import { isReadTool, readTracker } from "./read-tracker";
import { recordCompressionForStats } from "./retrieval-stats";
import { checkSafety } from "./safety-router";
import { detectSecrets, redactSecrets } from "./security";
import type { KnapsackStore } from "./types";

/** Parameters for the core compression pipeline. */
export interface CompressParams {
	/** Raw text content extracted from the tool output */
	text: string;
	/** Name of the tool that produced this output (for stats + routing) */
	toolName: string;
	/** File path the tool operated on (for language detection), if any */
	path?: string;
	/** Shell command that was run (for command delta detection), if any */
	command?: string;
	/** Exit code of the command (0 = success, non-zero = failure) */
	exitCode?: number;
	/** Knapsack database handle */
	db: KnapsackDB;
	/** Knapsack runtime store */
	store: KnapsackStore;
	/** Strategy registry (created once at extension load) */
	registry: StrategyRegistry;
}

/** A single text content block in the compressed output. */
export interface TextBlock {
	readonly type: "text";
	readonly text: string;
}

/** Result of the compression pipeline — content blocks to return to the agent. */
export interface CompressResult {
	/** Modified content blocks (compressed body + footer, or redacted body) */
	content: TextBlock[];
}

/**
 * Compress a tool output through the full knapsack pipeline.
 *
 * Agent-agnostic: takes plain text + metadata, returns content blocks.
 * Each adapter (Pi, Claude Code, OpenCode) is responsible for extracting
 * text from the agent's event format and calling this function.
 *
 * @param params - Compression parameters
 * @returns Compressed content blocks, or `undefined` when the output passes
 * through unchanged (below threshold, no secrets, no compression savings)
 */
export async function compress(params: CompressParams): Promise<CompressResult | undefined> {
	const { text: contentText, toolName, path, db, store, registry } = params;
	if (!contentText) return;

	// ── knapsack_retrieve bypass (centralized — applies to all adapters) ──
	// knapsack_retrieve exists solely to return uncompressed originals.
	// Re-compressing its output defeats its purpose — the caller would see
	// the same compressed summary it was trying to escape from.
	if (toolName === "knapsack_retrieve") return;

	// ── Safety routing (stack traces, keys, SQL, binary → passthrough) ──
	const safety = checkSafety(contentText, toolName);
	if (safety.shouldPassthrough) return;

	// ── Re-read delta check (safe — replaces only identical/diffed re-reads) ──
	if (path && isReadTool(toolName)) {
		const delta = readTracker.check(path, contentText);
		if (delta.type === "unchanged") {
			return { content: [{ type: "text", text: delta.marker }] };
		}
		if (delta.type === "changed") {
			return { content: [{ type: "text", text: `${delta.marker}\n\n${delta.diff}` }] };
		}
		// First read: skip compression — the model needs exact file content for edits.
		// If a file is too large, the model should use grep/find instead of read.
		return;
	}

	// ── Command delta check (same bash command, same output → marker) ──
	if (params.command && toolName.toLowerCase() === "bash") {
		const delta = commandTracker.check(params.command, contentText);
		if (delta.type === "identical") {
			return { content: [{ type: "text", text: delta.marker }] };
		}
	}

	// ── Per-command formatters (git/npm/pytest/cargo → semantic summary) ──
	if (params.command) {
		const formatted = formatCommandOutput({
			output: contentText,
			command: params.command,
			exitCode: params.exitCode,
		});
		if (formatted) {
			const cacheKey2 = sha256(contentText);
			const driftDetections2 = checkDrift(db, contentText, store.projectRoot ?? undefined);
			const driftHint2 =
				driftDetections2.length > 0
					? ` · ⚠️ DRIFT: ${driftDetections2.map((d) => d.anchor.statement).join("; ")}`
					: "";
			const footer2 = `\n\n📦 ${formatted.savingsPercent}% smaller · hash ${formatted.hash} · ${formatted.strategy}${driftHint2}`;

			db.recordCompression({
				toolName,
				originalHash: formatted.hash,
				originalTokens: formatted.originalTokens,
				compressedTokens: formatted.compressedTokens,
				savingsPercent: formatted.savingsPercent,
				strategy: formatted.strategy,
				obsidianNote: undefined,
				sessionId: store.sessionId ?? undefined,
			});
			recordCompressionForStats(db, formatted.strategy);

			outputCache.set(cacheKey2, {
				body: formatted.body,
				strategy: formatted.strategy,
				originalTokens: formatted.originalTokens,
				compressedTokens: formatted.compressedTokens,
				savingsPercent: formatted.savingsPercent,
				originalHash: formatted.hash,
			});

			return {
				content: [
					{ type: "text", text: formatted.body },
					{ type: "text", text: footer2 },
				],
			};
		}
	}

	// ── Tee on failure (non-zero exit → cache full + show extracted errors) ──
	if (params.exitCode !== undefined && params.exitCode !== 0) {
		const failHash = sha256(contentText);
		cache(store.dbPath.replace("/memory.db", ""), store.vaultPath, failHash, contentText);
		const extracted = extractErrors(contentText);
		const body = formatErrorBlock(extracted.errors, extracted.warnings, failHash);

		db.recordCompression({
			toolName,
			originalHash: failHash,
			originalTokens: contentText.length,
			compressedTokens: body.length,
			savingsPercent: Math.round((1 - body.length / Math.max(contentText.length, 1)) * 100),
			strategy: "tee-on-failure",
			obsidianNote: undefined,
			sessionId: store.sessionId ?? undefined,
		});

		return {
			content: [
				{ type: "text", text: body },
				{
					type: "text",
					text: `\n\n📦 tee-on-failure · hash ${failHash} · knapsack_retrieve("${failHash}") for complete error log`,
				},
			],
		};
	}

	// ── Output cache (CacheAligner + Live-Zone) ───────────────
	const cacheKey = sha256(contentText);
	const cached = outputCache.get(cacheKey);
	if (cached) {
		const driftDetections = checkDrift(db, contentText, store.projectRoot ?? undefined);
		const driftHint =
			driftDetections.length > 0
				? ` · ⚠️ DRIFT: ${driftDetections.map((d) => d.anchor.statement).join("; ")}`
				: "";
		const footer = `\n\n📦 ${cached.savingsPercent}% smaller · hash ${cached.originalHash} · summary is sufficient for listing/overview/structure tasks${driftHint}`;

		db.recordCompression({
			toolName,
			originalHash: cached.originalHash,
			originalTokens: cached.originalTokens,
			compressedTokens: cached.compressedTokens,
			savingsPercent: cached.savingsPercent,
			strategy: cached.strategy,
			obsidianNote: undefined,
			sessionId: store.sessionId ?? undefined,
		});

		return {
			content: [
				{ type: "text", text: cached.body },
				{ type: "text", text: footer },
			],
		};
	}

	// ── Secret redaction ──────────────────────────────────────
	const originalSecrets = detectSecrets(contentText);
	let contentForPipeline =
		originalSecrets.length > 0 ? redactSecrets(contentText, originalSecrets) : contentText;

	// ── Image redaction ───────────────────────────────────────
	const { redacted: imageRedacted, count: imageCount } = redactImages(contentForPipeline);
	if (imageCount > 0) contentForPipeline = imageRedacted;

	// ── Tag protection + compression ──────────────────────────
	const { protectedText, tags } = protectTags(contentForPipeline);
	const result = await registry.compress(protectedText, { toolName, path });

	const scanSource = result?.body ?? protectedText;
	const secrets = detectSecrets(scanSource);
	const redactedSource = secrets.length > 0 ? redactSecrets(scanSource, secrets) : scanSource;

	if (!result) {
		if (secrets.length === 0) return;
		let body = redactedSource;
		if (tags.size > 0) body = restoreTags(body, tags);
		return { content: [{ type: "text", text: body }] };
	}

	result.body = redactedSource;
	if (tags.size > 0) {
		result.body = restoreTags(result.body, tags);
	}

	// ── CCR cache + stats + drift ─────────────────────────────
	const ccrHash = cache(
		store.dbPath.replace("/memory.db", ""),
		store.vaultPath,
		result.hash,
		contentForPipeline,
	);

	db.recordCompression({
		toolName,
		originalHash: result.hash,
		originalTokens: result.originalTokens,
		compressedTokens: result.compressedTokens,
		savingsPercent: result.savingsPercent,
		strategy: result.strategy,
		obsidianNote: ccrHash ?? undefined,
		sessionId: store.sessionId ?? undefined,
	});

	recordCompressionForStats(db, result.strategy);

	const driftDetections = checkDrift(db, contentText, store.projectRoot ?? undefined);
	const driftHint =
		driftDetections.length > 0
			? ` · ⚠️ DRIFT: ${driftDetections.map((d) => d.anchor.statement).join("; ")}`
			: "";
	const footer = `\n\n📦 ${result.savingsPercent}% smaller · hash ${result.hash} · summary is sufficient for listing/overview/structure tasks${driftHint}`;

	outputCache.set(cacheKey, {
		body: result.body,
		strategy: result.strategy,
		originalTokens: result.originalTokens,
		compressedTokens: result.compressedTokens,
		savingsPercent: result.savingsPercent,
		originalHash: result.hash,
	});

	return {
		content: [
			{ type: "text", text: result.body },
			{ type: "text", text: footer },
		],
	};
}

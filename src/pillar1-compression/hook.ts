/**
 * Compression hook — intercepts tool_result events and compresses large outputs.
 *
 * ## Flow
 *
 * 1. Extract text content from the tool result
 * 2. Check output cache (CacheAligner + Live-Zone) — skip pipeline on cache hit
 * 3. Detect & redact secrets on original content
 * 4. Protect XML tags via placeholders
 * 5. Dispatch to strategy registry (auto-detect by content → fallback by tool name)
 * 6. Apply compression strategy
 * 7. Re-detect & redact secrets on compressed body
 * 8. Restore XML tag placeholders
 * 9. Cache original in CCR (~/.knapsack/cache)
 * 10. Record compression stats
 * 11. Check drift against declared anchors
 * 12. Cache the fully processed output for future hits
 * 13. Return modified content: compressed body + retrieval hint
 *
 * ## Plugin architecture
 *
 * Strategies are registered in a {@link StrategyRegistry}. The registry
 * handles all routing — content detection and tool-name mapping.
 * Third-party packages can add custom strategies via `registry.register()`.
 *
 * ## Idempotency
 *
 * The compression database uses `original_hash UNIQUE` — recording the same
 * compression twice is a no-op. The Obsidian cache also skips existing files.
 *
 * @module compression-hook
 */

import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { KnapsackDB } from "../core/database";
import { sha256 } from "../core/hash";
import { detectSecrets, redactSecrets } from "../core/security";
import type { KnapsackStore } from "../core/types";
import { checkDrift } from "../pillar2-memory/drift";
import { cache } from "./ccr";
import { redactImages } from "./image";
import { outputCache } from "./output-cache";
import type { StrategyRegistry } from "./plugin";
import { protectTags, restoreTags } from "./tag-protector";

/**
 * Process a tool result event through the compression pipeline.
 *
 * Called from the `tool_result` hook in the main extension.
 * Uses the strategy registry for routing — no hardcoded switch statement.
 *
 * @param event - The tool_result event from Pi
 * @param _ctx - Extension context (reserved for future UI integration)
 * @param db - Knapsack database handle
 * @param store - Knapsack runtime store
 * @param registry - Strategy registry (created once at extension load)
 * @returns Modified tool result or undefined
 */
export async function compressionHook(
	event: ToolResultEvent,
	_ctx: ExtensionContext,
	db: KnapsackDB,
	store: KnapsackStore,
	registry: StrategyRegistry,
): Promise<{ content: Array<{ type: "text"; text: string }> } | undefined> {
	const { toolName } = event;
	const path = typeof event.input?.path === "string" ? event.input.path : undefined;

	// Extract text content from the event
	const contentText = extractTextContent(event.content);
	if (!contentText) return;

	// ── Output cache (CacheAligner + Live-Zone) ───────────────
	// If we've already compressed this exact content, skip the entire
	// pipeline and return the cached body. The footer is rebuilt each
	// time because drift anchors may have changed since caching.
	const cacheKey = sha256(contentText);
	const cached = outputCache.get(cacheKey);
	if (cached) {
		const driftDetections = checkDrift(db, contentText, store.projectRoot ?? undefined);
		const driftHint =
			driftDetections.length > 0
				? ` · ⚠️ DRIFT: ${driftDetections.map((d) => d.anchor.statement).join("; ")}`
				: "";
		const footer = `\n\n📦 ${cached.savingsPercent}% smaller · hash ${cached.originalHash} · summary is sufficient for listing/overview/structure tasks${driftHint}`;

		// Record stats (idempotent — DB uses INSERT OR IGNORE by original_hash)
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

	// Detect secrets on the ORIGINAL content (before tag protection) so a
	// JWT inside <thinking> or <args> is not hidden from the detector by the
	// placeholder swap. We re-run detectSecrets on the final body too — but
	// capturing the original-content findings here means we keep the offsets
	// the redactor needs to slice accurately.
	const originalSecrets = detectSecrets(contentText);
	let contentForPipeline =
		originalSecrets.length > 0 ? redactSecrets(contentText, originalSecrets) : contentText;

	const { redacted: imageRedacted, count: imageCount } = redactImages(contentForPipeline);
	if (imageCount > 0) contentForPipeline = imageRedacted;

	// Compress via registry (auto-routing by content, fallback by tool name).
	// Wrap with tag protection so XML/custom markers the model needs are not
	// sliced apart by the compressor.
	const { protectedText, tags } = protectTags(contentForPipeline);
	const result = await registry.compress(protectedText, { toolName, path });

	// Always scan for high-confidence secrets — even when the output is too
	// small to compress, a JWT or private key must not reach the model verbatim.
	// The CCR cache still gets the original so knapsack_retrieve works.
	const scanSource = result?.body ?? protectedText;
	const secrets = detectSecrets(scanSource);
	const redactedSource = secrets.length > 0 ? redactSecrets(scanSource, secrets) : scanSource;

	if (!result) {
		// No compression applied. Return only if we redacted something;
		// otherwise leave the tool_result untouched. Restore any tag
		// placeholders so they don't leak into the model's view.
		if (secrets.length === 0) return;
		let body = redactedSource;
		if (tags.size > 0) body = restoreTags(body, tags);
		return {
			content: [{ type: "text", text: body }],
		};
	}

	result.body = redactedSource;
	if (tags.size > 0) {
		result.body = restoreTags(result.body, tags);
	}

	// Cache original locally (CCR) — ~/.knapsack/cache, not vault
	const ccrHash = cache(
		store.dbPath.replace("/memory.db", ""),
		store.vaultPath,
		result.hash,
		// Cache the secret-redacted form so a future knapsack_retrieve cannot
		// surface a JWT/private key that the model never saw in the first place.
		contentForPipeline,
	);

	// Record in stats database
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

	// Auto-check drift on the output content
	const driftDetections = checkDrift(db, contentText, store.projectRoot ?? undefined);

	const driftHint =
		driftDetections.length > 0
			? ` · ⚠️ DRIFT: ${driftDetections.map((d) => d.anchor.statement).join("; ")}`
			: "";
	const footer = `

📦 ${result.savingsPercent}% smaller · hash ${result.hash} · summary is sufficient for listing/overview/structure tasks${driftHint}`;

	// Cache the fully processed output for future cache hits (CacheAligner +
	// Live-Zone). Only the body and stats are cached; the footer is rebuilt
	// each time because drift anchors may change between turns.
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

/**
 * Extract plain text content from a tool result's content array.
 *
 * Tool results in Pi can have content as a string or as an array of
 * content blocks (text, image, etc.). This handles both cases.
 *
 * @param content - Tool result content from the event
 * @returns Concatenated text content, or null if no text found
 */
function extractTextContent(content: unknown): string | null {
	if (typeof content === "string") return content;

	if (Array.isArray(content)) {
		const parts = content
			.filter(
				(block): block is { type: "text"; text: string } =>
					typeof block === "object" &&
					block !== null &&
					"type" in block &&
					block.type === "text" &&
					typeof (block as { text: unknown }).text === "string",
			)
			.map((block) => block.text);

		return parts.length > 0 ? parts.join("\n") : null;
	}

	return null;
}

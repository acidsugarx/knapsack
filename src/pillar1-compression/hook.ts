/**
 * Compression hook — intercepts tool_result events and compresses large outputs.
 *
 * ## Flow
 *
 * 1. Extract text content from the tool result
 * 2. Check if output exceeds token threshold
 * 3. Dispatch to strategy registry (auto-detect by content → fallback by tool name)
 * 4. Apply compression strategy
 * 5. Cache original in Obsidian vault (CCR)
 * 6. Record compression stats
 * 7. Return modified content: compressed body + retrieval hint
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
import type { KnapsackStore } from "../core/types";
import { cache } from "./ccr";
import type { StrategyRegistry } from "./plugin";

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

	// Extract text content from the event
	const contentText = extractTextContent(event.content);
	if (!contentText) return;

	// Compress via registry (auto-routing by content, fallback by tool name)
	const result = registry.compress(contentText, toolName);
	if (!result) return;

	// Cache original in Obsidian vault (CCR)
	const obsidianNote = cache(store.vaultPath, result.hash, contentText, {
		toolName,
		originalTokens: result.originalTokens,
		compressedTokens: result.compressedTokens,
		savingsPercent: result.savingsPercent,
		sessionId: store.sessionId,
	});

	// Record in stats database
	db.recordCompression({
		toolName,
		originalHash: result.hash,
		originalTokens: result.originalTokens,
		compressedTokens: result.compressedTokens,
		savingsPercent: result.savingsPercent,
		strategy: result.strategy,
		obsidianNote: obsidianNote ?? undefined,
		sessionId: store.sessionId ?? undefined,
	});

	// Auto-check drift on the output content
	const { checkDrift } = await import("../pillar2-memory/drift");
	const driftDetections = checkDrift(db, contentText, store.projectRoot ?? undefined);

	// Build retrieval hint with vault link if available
	const vaultHint = obsidianNote ? ` · vault: [[${obsidianNote}]]` : "";
	const driftHint =
		driftDetections.length > 0
			? ` · ⚠️ DRIFT: ${driftDetections.map((d) => d.anchor.statement).join("; ")}`
			: "";
	const footer = `\n\n📦 ${result.savingsPercent}% tokens saved (${result.originalTokens}→${result.compressedTokens})${vaultHint}${driftHint} · \`knapsack_retrieve("${result.hash}")\` for full output`;

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

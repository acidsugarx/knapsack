/**
 * Compression hook — intercepts tool_result events and compresses large outputs.
 *
 * ## Flow
 *
 * 1. Check if this tool type has a compression strategy
 * 2. Estimate token count of the output
 * 3. Skip if below threshold (small outputs don't benefit from compression)
 * 4. Apply the appropriate compression strategy (bash, grep, find)
 * 5. Cache the original in Obsidian vault (CCR)
 * 6. Record the compression in the stats database
 * 7. Return modified content: compressed body + retrieval hint
 *
 * ## Idempotency
 *
 * The compression database uses `original_hash UNIQUE` — recording the same
 * compression twice is a no-op. The Obsidian cache also skips existing files.
 *
 * @module compression-hook
 */

import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { KnapsackDB } from "../../core/database";
import { estimateTokens } from "../../core/tokens";
import type { KnapsackStore } from "../../core/types";
import { cache } from "../ccr";
import { compressBash } from "../strategies/bash";
import { compressFind } from "../strategies/find";
import { compressGrep } from "../strategies/grep";
import { shouldCompress, TOOL_STRATEGY } from "../thresholds";

/**
 * Number of characters to extract from tool output for token estimation.
 * Sampling the first N chars is faster than processing the entire output
 * and gives a sufficiently accurate estimate for threshold decisions.
 */
const ESTIMATE_SAMPLE_SIZE = 10000;

/**
 * Dispatch compression based on tool type, cache the original in Obsidian,
 * and return the compressed output to the model.
 *
 * Called from `tool_result` hook in the main extension.
 *
 * @param event - The tool_result event from Pi
 * @param _ctx - Extension context (unused currently, reserved for future UI integration)
 * @param db - Knapsack database handle
 * @param store - Knapsack runtime store (vault path, session ID, etc.)
 * @returns Modified tool result with compressed content, or undefined to leave unchanged
 */
export async function compressionHook(
	event: ToolResultEvent,
	_ctx: ExtensionContext,
	db: KnapsackDB,
	store: KnapsackStore,
): Promise<{ content: Array<{ type: "text"; text: string }> } | undefined> {
	const { toolName } = event;
	const strategy = TOOL_STRATEGY[toolName];
	if (!strategy) return;

	// Extract text content from the event
	const contentText = extractTextContent(event.content);
	if (!contentText) return;

	// Estimate tokens from a sample to avoid processing huge outputs unnecessarily
	const sample = contentText.slice(0, ESTIMATE_SAMPLE_SIZE);
	const estimatedTokens = estimateTokens(sample);

	if (!shouldCompress(toolName, estimatedTokens)) return;

	// Apply compression strategy
	let result;
	switch (strategy) {
		case "bash":
			result = compressBash(contentText);
			break;
		case "grep":
			result = compressGrep(contentText);
			break;
		case "find":
			result = compressFind(contentText);
			break;
		default:
			return;
	}

	// If compression didn't actually save tokens, skip
	if (result.savingsPercent <= 0) return;

	// Cache original in Obsidian
	const obsidianNote = cache(store.vaultPath, result.hash, contentText, {
		toolName,
		originalTokens: result.originalTokens,
		compressedTokens: result.compressedTokens,
		savingsPercent: result.savingsPercent,
		sessionId: store.sessionId,
	});

	// Record in stats DB
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

	// Build the retrieval hint
	const vaultHint = obsidianNote ? ` · vault: [[${obsidianNote}]]` : "";
	const footer = `\n\n📦 ${result.savingsPercent}% tokens saved (${result.originalTokens}→${result.compressedTokens})${vaultHint} · \`knapsack_retrieve("${result.hash}")\` for full output`;

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

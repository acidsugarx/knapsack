/**
 * Observation hook — learns from agent turns and saves memory automatically.
 *
 * ## When it fires
 *
 * `turn_end` — after each agent turn completes (LLM response + tool calls executed).
 *
 * ## What it observes
 *
 * 1. **Failed tool calls** — if a tool returned an error, save as a gotcha
 *    so the model doesn't repeat the same mistake.
 * 2. **Successful patterns** — if a tool succeeded after a previous failure,
 *    correlate and save as a fact.
 * 3. **User corrections** — if the user message contains correction language
 *    ("no, use X instead of Y"), save as a preference or convention.
 *
 * ## Idempotency
 *
 * Observations use content hashes for deduplication. Running the same
 * observation twice produces the same memory entry (UPSERT).
 *
 * @module observe
 */

import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore } from "../core/types";

/**
 * Maximum number of auto-saved memories per turn.
 * Prevents flooding the memory store during loops.
 */
const MAX_OBSERVATIONS_PER_TURN = 3;

/**
 * Observe a completed agent turn and automatically save learnings.
 *
 * Currently observes failed tool calls and saves them as gotchas.
 * Future versions will add pattern correlation and user-correction detection.
 *
 * @param event - turn_end event with tool results
 * @param db - Knapsack database handle
 * @param store - Knapsack runtime store
 */
export async function observeHook(
	event: TurnEndEvent,
	db: KnapsackDB,
	store: KnapsackStore,
): Promise<void> {
	const observations: Array<{ content: string; type: "gotcha" | "fact" }> = [];

	// ── Observe failed tool calls ──────────────────────────
	for (const result of event.toolResults ?? []) {
		if (isToolError(result)) {
			const toolName = result.toolName ?? "unknown";
			const errorMsg = extractErrorMessage(result);
			if (errorMsg) {
				observations.push({
					content: `${toolName} failed: ${normaliseErrorMessage(errorMsg).slice(0, 200)}`,
					type: "gotcha",
				});
			}
		}

		if (observations.length >= MAX_OBSERVATIONS_PER_TURN) break;
	}

	// ── Save observations ──────────────────────────────────
	for (const obs of observations) {
		db.saveMemory({
			content: obs.content,
			type: obs.type,
			scope: "project",
			project: store.projectRoot ?? undefined,
			importance: obs.type === "gotcha" ? 0.7 : 0.5,
			sourceSession: store.sessionId ?? undefined,
		});
	}
}

/**
 * Check if a tool result represents an error.
 *
 * @param result - Tool result from turn_end event
 * @returns true if the tool execution was an error
 */
function isToolError(result: unknown): boolean {
	if (typeof result === "object" && result !== null) {
		const r = result as Record<string, unknown>;
		if (r.isError === true) return true;
		if (typeof r.error === "string" && r.error.length > 0) return true;
	}
	return false;
}

/**
 * Normalise volatile bits of an error message so two errors with the same
 * root cause dedup via the content_hash UPSERT (and consolidate via
 * saveMemory's Jaccard merge). Strips timestamps, line numbers in stack
 * traces, process IDs, and ephemeral request IDs.
 */
function normaliseErrorMessage(msg: string): string {
	return msg
		// ISO 8601 timestamps
		.replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<ts>")
		// "at HH:MM:SS" wall-clock fragments
		.replace(/\b\d{2}:\d{2}:\d{2}\b/g, "<time>")
		// pid / ppid / tid numbers
		.replace(/\b(?:pid|ppid|tid|request[_-]?id)[:=]\s*\d+/gi, "$1=<id>")
		// `at file.ts:line:col` stack frames — keep the file, drop the line/col
		.replace(/\bat\s+(\S+):(\d+):(\d+)/g, "at $1:<line>")
		.replace(/\bat\s+(\S+):(\d+)/g, "at $1:<line>")
		// bare large numbers (ports, allocation sizes) — keep short ones, e.g. status codes
		.replace(/\b\d{5,}\b/g, "<num>");
}

/**
 * Extract a human-readable error message from a tool result.
 *
 * @param result - Tool result that is known to be an error
 * @returns Error message string, or null if not extractable
 */
function extractErrorMessage(result: unknown): string | null {
	if (typeof result === "object" && result !== null) {
		const r = result as Record<string, unknown>;
		if (typeof r.error === "string") return r.error;
		if (typeof r.content === "string") return r.content.slice(0, 300);
		if (Array.isArray(r.content)) {
			const text = r.content
				.filter((b): b is { text: string } => b?.type === "text")
				.map((b) => b.text)
				.join(" ");
			if (text) return text.slice(0, 300);
		}
		// Try to get the first string value
		for (const v of Object.values(r)) {
			if (typeof v === "string" && v.length > 0) return v.slice(0, 300);
		}
	}
	return null;
}

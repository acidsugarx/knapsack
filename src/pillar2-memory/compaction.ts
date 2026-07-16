/**
 * Compaction hook — saves a session summary to memory before context reset.
 *
 * ## When it fires
 *
 * `session_before_compact` — right before Pi compacts the context window.
 * This is triggered automatically when context exceeds the threshold, or
 * manually via `/compact`.
 *
 * ## What it does
 *
 * 1. Receives the compaction preparation data (messages to summarize, etc.)
 * 2. Saves a compact session state summary to memory
 * 3. This summary survives the compaction and is injected on next session start
 *
 * ## Why this matters
 *
 * Without this, compaction effectively "forgets" everything that happened
 * before the cut point. By persisting a summary to Knapsack memory, the
 * model retains awareness of:
 * - What was being worked on
 * - Key decisions made
 * - Files that were modified
 * - Open questions and next steps
 *
 * @module compaction
 */

import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { KnapsackDB } from "../../core/database";
import type { KnapsackStore } from "../../core/types";

/**
 * Handle the session_before_compact event — persist session state to memory.
 *
 * Creates a "decision"-type memory entry summarizing the session state
 * before compaction occurs.
 *
 * @param event - session_before_compact event from Pi
 * @param db - Knapsack database handle
 * @param store - Knapsack runtime store
 * @returns undefined (does not modify the compaction behavior)
 */
export function compactionHook(
	event: SessionBeforeCompactEvent,
	db: KnapsackDB,
	store: KnapsackStore,
): void {
	const { preparation, reason } = event;

	// Build a compact summary of what's being compacted
	const messageCount = preparation.messagesToSummarize?.length ?? 0;
	const tokenCount = preparation.tokensBefore ?? 0;

	const summary = [
		`Session compacted (${reason})`,
		`Messages summarized: ${messageCount}`,
		`Tokens before compaction: ${tokenCount}`,
		preparation.previousSummary
			? `Previous summary was carried forward`
			: null,
	]
		.filter(Boolean)
		.join(" · ");

	db.saveMemory({
		content: summary,
		type: "fact",
		scope: "session",
		importance: 0.6,
		sourceSession: store.sessionId ?? undefined,
	});
}

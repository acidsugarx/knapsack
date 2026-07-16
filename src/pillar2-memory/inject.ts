/**
 * Memory injection hook — prepends relevant project memories before each agent turn.
 *
 * ## When it fires
 *
 * `before_agent_start` — after user submits a prompt but before the agent loop begins.
 * This is the last chance to modify the system prompt before the LLM sees it.
 *
 * ## What it does
 *
 * 1. Searches memory for entries relevant to the project
 * 2. Selects the most important recent memories (top 5 by importance × recency)
 * 3. Appends them to the system prompt as a "Knapsack Memory" section
 * 4. The model sees this context at the start of every turn
 *
 * ## Token budget
 *
 * The injected memory section is kept compact — at most ~500 tokens worth of
 * memories. This ensures the injection doesn't itself become a token problem.
 *
 * @module memory-inject
 */

import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore, MemoryEntry } from "../core/types";

/**
 * Maximum number of memory entries to inject.
 * More than this and the injection cost outweighs the benefit.
 */
const MAX_INJECTED_MEMORIES = 5;

/**
 * Inject relevant memories into the system prompt before the agent starts.
 *
 * @param event - before_agent_start event with mutable systemPrompt
 * @param db - Knapsack database handle
 * @param store - Knapsack runtime store
 * @returns Modified system prompt, or undefined if no memories to inject
 */
export function memoryInjectHook(
	_event: BeforeAgentStartEvent,
	db: KnapsackDB,
	store: KnapsackStore,
): string | undefined {
	// Get recent project memories
	const memories = db.getRecentMemory(MAX_INJECTED_MEMORIES * 2, store.projectRoot ?? undefined);

	if (memories.length === 0) return;

	// Select top memories by importance × recency
	const relevant = selectBestMemories(memories, MAX_INJECTED_MEMORIES);

	if (relevant.length === 0) return;

	// Format as a compact section
	return formatMemoryBlock(relevant);
}

/**
 * Select the best memories by scoring importance × recency.
 *
 * We want memories that are both important (high importance score)
 * AND recent (last accessed recently). The product gives a balance.
 *
 * @param memories - Candidate memories (pre-filtered by project scope)
 * @param limit - Maximum number to return
 * @returns Top-scoring memories, sorted by score descending
 */
function selectBestMemories(memories: MemoryEntry[], limit: number): MemoryEntry[] {
	const now = Date.now();

	const scored = memories.map((m) => {
		// Recency: 1.0 for < 1 hour ago, decaying to 0.1 after 30 days
		const ageMs = now - m.recency;
		const recencyScore = Math.max(0.1, 1.0 - ageMs / (30 * 24 * 60 * 60 * 1000));

		return {
			memory: m,
			score: m.importance * recencyScore,
		};
	});

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((s) => s.memory);
}

/**
 * Format a list of memory entries as a compact system prompt section.
 *
 * The format is designed to be:
 * - Scannable by the LLM (emoji + type label + content)
 * - Token-efficient (no verbose framing)
 * - Non-intrusive (clearly separated from the main prompt)
 *
 * @param memories - Memory entries to format
 * @returns Markdown-formatted memory block
 */
function formatMemoryBlock(memories: MemoryEntry[]): string {
	const emoji: Record<string, string> = {
		decision: "🔒",
		fact: "📋",
		gotcha: "⚠️",
		convention: "📐",
		preference: "💭",
		command: "⚡",
		constraint: "🚫",
		hypothesis: "🧪",
	};

	const lines = [
		"<!-- KNAPSACK_MEMORY_START -->",
		"## 🎒 Knapsack Memory",
		"",
		"Relevant knowledge from previous sessions:",
		"",
	];

	for (const m of memories) {
		const icon = emoji[m.type] ?? "📌";
		lines.push(`- ${icon} **${m.type}**: ${m.content}`);
	}

	lines.push("", "<!-- KNAPSACK_MEMORY_END -->");

	return lines.join("\n");
}

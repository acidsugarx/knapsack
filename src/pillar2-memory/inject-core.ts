/**
 * Shared memory injection core — search + rank + format, agent-agnostic.
 *
 * Extracted from the Pi-specific `memoryInjectHook` (pillar2-memory/inject.ts)
 * and the adapter-facing `injectMemory` (core/memory.ts). Both wrappers call
 * this shared core and layer their own lifecycle hooks (decay detector,
 * Pi event typing) on top.
 *
 * @module inject-core
 */

import type { KnapsackDB } from "../core/database";
import type { KnapsackStore, MemoryEntry } from "../core/types";
import { STOP_WORDS, scoreAndRank } from "./scoring";

/** Maximum memories injected per turn. */
const MAX_INJECTED_MEMORIES = 5;
/** Maximum candidate pool before scoring. */
const MAX_CANDIDATES = 15;

/**
 * Search memories relevant to a user prompt and rank them for injection.
 *
 * Does NOT record decay-detector state — that is the wrapper's concern.
 *
 * @param prompt - The user's prompt text (may be empty — recent-fallback path)
 * @param db - Open KnapsackDB handle
 * @param store - Runtime store (project root + session id)
 * @returns Ranked top-K memory entries and a formatted prompt block, or
 * `undefined` when no memories match.
 */
export async function injectMemoryCore(
	prompt: string,
	db: KnapsackDB,
	store: KnapsackStore,
): Promise<{ relevant: MemoryEntry[]; formatted: string } | undefined> {
	const terms = extractSearchTerms(prompt);
	const project = store.projectRoot ?? undefined;

	const candidates = new Map<string, MemoryEntry>();

	if (terms.length > 0) {
		for (const term of terms.slice(0, 3)) {
			const results = db.searchMemory(term, 5, undefined, project);
			for (const m of results) candidates.set(m.id, m);
		}
	}

	const recent = db.getRecentMemory(MAX_CANDIDATES, project, store.sessionId ?? undefined);
	for (const m of recent) candidates.set(m.id, m);

	if (candidates.size === 0) return;

	const ranked = await scoreAndRank(
		terms.join(" "),
		Array.from(candidates.values()),
		Array.from(candidates.values()),
		MAX_INJECTED_MEMORIES,
	);

	const relevant = ranked.map((r) => r.entry);
	if (relevant.length === 0) return;

	return { relevant, formatted: formatMemoryBlock(relevant) };
}

/**
 * Extract meaningful search terms from a user prompt, filtering stop words
 * and short tokens.
 *
 * @param prompt - Raw user prompt text
 * @returns Array of search terms (lowercase, deduplicated, max 5)
 */
export function extractSearchTerms(prompt: string): string[] {
	if (!prompt?.trim()) return [];

	const words = prompt
		.toLowerCase()
		.split(/[\s,.;:!?()[\]{}"'`@#$%^&*+=<>|\\/~-]+/)
		.filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

	return [...new Set(words)].slice(0, 5);
}

/**
 * Format memory entries as an XML-tagged block for system-prompt injection.
 *
 * @param memories - Memory entries to format
 * @returns Formatted string with `<!-- KNAPSACK_MEMORY_START -->` / `<!-- END -->` markers
 */
export function formatMemoryBlock(memories: MemoryEntry[]): string {
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

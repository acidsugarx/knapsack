/**
 * Core memory injection — agent-agnostic memory search + format.
 *
 * Extracted from the Pi-specific `memoryInjectHook` so that every adapter
 * can inject task-relevant memories before each agent turn.
 *
 * @module core-memory
 */

import { STOP_WORDS, scoreAndRank } from "../pillar2-memory/scoring";
import type { KnapsackDB } from "./database";
import { decayDetector } from "./decay-detector";
import type { KnapsackStore, MemoryEntry } from "./types";

const MAX_INJECTED_MEMORIES = 5;
const MAX_CANDIDATES = 15;

/**
 * Search memories relevant to a user prompt and format them as a
 * system-prompt injection block.
 *
 * Agent-agnostic: takes a plain prompt string, returns a formatted block
 * to append to the system prompt.
 *
 * @param prompt - The user's prompt text
 * @param db - Open KnapsackDB handle
 * @param store - Runtime store (project root + session id)
 * @returns Formatted memory block string, or `undefined` when no memories match
 */
export async function injectMemory(
	prompt: string,
	db: KnapsackDB,
	store: KnapsackStore,
): Promise<string | undefined> {
	const terms = extractSearchTerms(prompt);
	const project = store.projectRoot ?? undefined;

	const candidates = new Map<string, MemoryEntry>();

	if (terms.length > 0) {
		for (const term of terms.slice(0, 3)) {
			const results = db.searchMemory(term, 5, undefined, project);
			for (const m of results) {
				candidates.set(m.id, m);
			}
		}
	}

	const recent = db.getRecentMemory(MAX_CANDIDATES, project, store.sessionId ?? undefined);
	for (const m of recent) {
		candidates.set(m.id, m);
	}

	if (candidates.size === 0) return;

	const ranked = await scoreAndRank(
		terms.join(" "),
		Array.from(candidates.values()),
		Array.from(candidates.values()),
		MAX_INJECTED_MEMORIES,
	);

	const relevant = ranked.map((r) => r.entry);
	if (relevant.length === 0) return;

	decayDetector.advanceTurn();
	for (const m of relevant) {
		decayDetector.recordInjection(m.id);
	}

	const allHighImportance = db
		.getAllMemories(store.projectRoot ?? undefined)
		.filter((m) => m.importance >= 0.7);
	const decayed = decayDetector.getDecayedMemories(allHighImportance);
	for (const m of decayed) {
		decayDetector.recordInjection(m.id);
	}
	const refreshBlock = decayDetector.formatRefreshBlock(decayed);

	const memoryBlock = formatMemoryBlock(relevant);
	if (refreshBlock) {
		return `${memoryBlock}\n\n${refreshBlock}`;
	}
	return memoryBlock;
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

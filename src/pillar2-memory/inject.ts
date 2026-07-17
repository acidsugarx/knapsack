/**
 * Memory injection hook — searches and injects task-relevant memories before each agent turn.
 *
 * Uses the shared `scoreAndRank` from scoring.ts for consistent ranking
 * between injection and knapsack_search.
 *
 * @module memory-inject
 */

import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore } from "../core/types";
import { STOP_WORDS, scoreAndRank } from "./scoring";

const MAX_INJECTED_MEMORIES = 5;
const MAX_CANDIDATES = 15;

/**
 * before_agent_start hook — search memories relevant to the user prompt and
 * format them as a system-prompt injection block. Uses the shared
 * `scoreAndRank` from scoring.ts for consistent ranking between injection
 * and `knapsack_search`.
 *
 * @param event - Pi's BeforeAgentStartEvent carrying the user prompt.
 * @param db - Open KnapsackDB handle.
 * @param store - Runtime store (project root + session id).
 * @returns A formatted memory block string to append to the system prompt,
 * or undefined when no memories match.
 */
export async function memoryInjectHook(
	event: BeforeAgentStartEvent,
	db: KnapsackDB,
	store: KnapsackStore,
): Promise<string | undefined> {
	const terms = extractSearchTerms(event.prompt);
	const project = store.projectRoot ?? undefined;

	const candidates = new Map<string, import("../core/types").MemoryEntry>();

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

	return formatMemoryBlock(relevant);
}

function extractSearchTerms(prompt: string): string[] {
	if (!prompt?.trim()) return [];

	const words = prompt
		.toLowerCase()
		.split(/[\s,.;:!?()[\]{}"'`@#$%^&*+=<>|\\/~-]+/)
		.filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

	return [...new Set(words)].slice(0, 5);
}

function formatMemoryBlock(memories: import("../core/types").MemoryEntry[]): string {
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

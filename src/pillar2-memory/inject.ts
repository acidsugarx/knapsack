/**
 * Memory injection hook — searches and injects task-relevant memories before each agent turn.
 *
 * ## Relevance over recency
 *
 * Instead of just showing recent memories (which may be irrelevant to the current
 * task), this hook searches memory by keywords extracted from the user's prompt.
 * This means:
 *
 * - Working on "postgres" → sees memories about Postgres, not about Helm
 * - Working on "compression" → sees gotchas about tree-sitter, not about SQLite
 * - Global memories about Node 26 are shown when the task involves Node
 *
 * ## Scoring
 *
 * Memories are scored by:
 * 1. Keyword match (memories containing prompt terms score higher)
 * 2. Importance (critical gotchas score higher than preferences)
 * 3. Recency (recently accessed memories get a boost)
 *
 * @module memory-inject
 */

import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore, MemoryEntry } from "../core/types";

/**
 * Maximum number of memory entries to inject per turn.
 */
const MAX_INJECTED_MEMORIES = 5;

/**
 * Maximum search results to consider (we select top-N from these).
 */
const MAX_CANDIDATES = 15;

/**
 * Inject task-relevant memories into the system prompt.
 *
 * Searches memory by keywords from the user's prompt, combines with recent
 * project memories, scores by relevance × importance × recency.
 *
 * @param event - before_agent_start event (has prompt text)
 * @param db - Knapsack database handle
 * @param store - Knapsack runtime store
 * @returns Formatted memory block string, or undefined if no relevant memories
 */
export function memoryInjectHook(
	event: BeforeAgentStartEvent,
	db: KnapsackDB,
	store: KnapsackStore,
): string | undefined {
	// Extract search terms from the user's prompt
	const terms = extractSearchTerms(event.prompt);
	const project = store.projectRoot ?? undefined;

	// Collect candidates: search hits + recent project memories
	const candidates = new Map<string, MemoryEntry>();

	// 1. Search memory with prompt keywords
	if (terms.length > 0) {
		for (const term of terms.slice(0, 3)) {
			// Search each term, get up to 5 results per term
			const results = db.searchMemory(term, 5, undefined, project);
			for (const m of results) {
				candidates.set(m.id, m);
			}
		}
	}

	// 2. Add recent project + global memories as fallback
	const recent = db.getRecentMemory(MAX_CANDIDATES, project, store.sessionId ?? undefined);
	for (const m of recent) {
		candidates.set(m.id, m);
	}

	if (candidates.size === 0) return;

	// Score and select best
	const relevant = selectBestMemories(
		Array.from(candidates.values()),
		MAX_INJECTED_MEMORIES,
		terms,
	);

	if (relevant.length === 0) return;

	return formatMemoryBlock(relevant);
}

/**
 * Extract meaningful search terms from a user prompt.
 *
 * Filters out common stop words, keeps nouns and technical terms.
 * Returns up to 5 terms for search queries.
 *
 * @param prompt - User's prompt text
 * @returns Array of search terms (lowercase, unique)
 */
function extractSearchTerms(prompt: string): string[] {
	if (!prompt?.trim()) return [];

	const stopWords = new Set([
		"the",
		"a",
		"an",
		"is",
		"are",
		"was",
		"were",
		"be",
		"been",
		"i",
		"me",
		"my",
		"we",
		"our",
		"you",
		"your",
		"he",
		"she",
		"it",
		"this",
		"that",
		"these",
		"those",
		"to",
		"of",
		"in",
		"for",
		"on",
		"with",
		"at",
		"by",
		"from",
		"as",
		"into",
		"about",
		"like",
		"and",
		"but",
		"or",
		"not",
		"no",
		"so",
		"if",
		"then",
		"than",
		"can",
		"will",
		"just",
		"now",
		"also",
		"very",
		"too",
		"only",
		"please",
		"need",
		"want",
		"would",
		"could",
		"should",
		"do",
		"does",
		"how",
		"what",
		"when",
		"where",
		"which",
		"who",
		"why",
	]);

	// Split by non-word characters, filter stop words and short terms
	const words = prompt
		.toLowerCase()
		.split(/[\s,.;:!?()[\]{}"'`@#$%^&*+=<>|\\/~-]+/)
		.filter((w) => w.length >= 3 && !stopWords.has(w));

	// Deduplicate, take first 5
	return [...new Set(words)].slice(0, 5);
}

/**
 * Select the best memories by scoring relevance × importance × recency.
 *
 * @param memories - Candidate memories (deduplicated)
 * @param limit - Maximum number to return
 * @param terms - Search terms from user prompt (for relevance scoring)
 * @returns Top-scoring memories, sorted by score descending
 */
function selectBestMemories(
	memories: MemoryEntry[],
	limit: number,
	terms: string[],
): MemoryEntry[] {
	const now = Date.now();

	const scored = memories.map((m) => {
		// Relevance: how many search terms appear in the memory content
		const contentLower = m.content.toLowerCase();
		const matchCount = terms.filter((t) => contentLower.includes(t)).length;
		const relevanceScore = terms.length > 0 ? matchCount / Math.max(terms.length, 1) : 0.5; // No terms = neutral score

		// Recency: 1.0 for < 1 hour, decays to 0.1 after 30 days
		const ageMs = now - m.recency;
		const recencyScore = Math.max(0.1, 1.0 - ageMs / (30 * 24 * 60 * 60 * 1000));

		// Composite: relevance × importance × recency
		const score = relevanceScore * m.importance * recencyScore;

		return { memory: m, score };
	});

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((s) => s.memory);
}

/**
 * Format a list of memory entries as a compact system prompt section.
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

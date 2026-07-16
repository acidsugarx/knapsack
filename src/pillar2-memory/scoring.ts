/**
 * Semantic memory search with BM25-inspired scoring.
 *
 * Uses sigmoid normalization for stable relevance scoring regardless
 * of database size. Shared STOP_WORDS list used by both tokenize()
 * and inject.ts extractSearchTerms().
 *
 * @module search-scoring
 */

import type { MemoryEntry } from "../core/types";

/**
 * Shared stop words list — used by tokenize() and inject.ts.
 */
export const STOP_WORDS = new Set([
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
	"use",
	"using",
	"used",
	"when",
	"what",
	"how",
	"why",
	"which",
	"who",
	"please",
	"need",
	"want",
	"would",
	"could",
	"should",
	"do",
	"does",
]);

export interface ScoredMemory {
	entry: MemoryEntry;
	relevance: number;
	importance: number;
	recency: number;
	score: number;
}

export function scoreAndRank(
	query: string,
	entries: MemoryEntry[],
	allEntries: MemoryEntry[],
	limit = 10,
): ScoredMemory[] {
	const queryTerms = tokenize(query);
	if (queryTerms.length === 0) return [];

	const idf = computeIDF(queryTerms, allEntries);

	const scored = entries.map((entry) => {
		const contentTerms = tokenize(entry.content);

		let relevance = 0;
		for (const term of queryTerms) {
			const termIDF = idf.get(term) ?? 0;
			const tf = contentTerms.filter((t) => t === term).length;
			if (tf > 0 && termIDF > 0) {
				relevance += termIDF * (tf / (tf + 1.2));
			}
		}

		const normalizedRelevance = relevance > 0 ? relevance / (relevance + 1.5) : 0;

		const ageMs = Date.now() - entry.recency;
		const recency = Math.max(0.1, 1.0 - ageMs / (30 * 24 * 60 * 60 * 1000));

		const score = 0.5 * normalizedRelevance + 0.3 * entry.importance + 0.2 * recency;

		return {
			entry,
			relevance: Math.round(normalizedRelevance * 100) / 100,
			importance: entry.importance,
			recency: Math.round(recency * 100) / 100,
			score: Math.round(score * 100) / 100,
		};
	});

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit);
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[\s,.;:!?()[\]{}"'`@#$%^&*+=<>|\\/~-]+/)
		.filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

function computeIDF(terms: string[], allEntries: MemoryEntry[]): Map<string, number> {
	const N = allEntries.length;
	if (N === 0) return new Map();

	const idf = new Map<string, number>();

	for (const term of terms) {
		let df = 0;
		for (const entry of allEntries) {
			if (entry.content.toLowerCase().includes(term)) {
				df++;
			}
		}
		const score = Math.log((N - df + 0.5) / (df + 0.5) + 1);
		idf.set(term, score);
	}

	return idf;
}

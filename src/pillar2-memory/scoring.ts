/**
 * Hybrid memory search — BM25 + optional embeddings fusion.
 *
 * ## Scoring
 *
 * When embeddings are available (@xenova/transformers installed):
 *   score = 0.35×BM25 + 0.35×cosine_sim + 0.2×importance + 0.1×recency
 *
 * When embeddings unavailable (graceful degradation):
 *   score = 0.5×BM25_saturation + 0.3×importance + 0.2×recency
 *
 * The embedding weight gives semantic matches ("deployment strategy"
 * finds "CI/CD pipeline") while BM25 keeps exact keyword matches
 * ("sessionId" finds entries with "sessionId", not "session").
 *
 * @module search-scoring
 */

import type { MemoryEntry } from "../core/types";
import { cosineSimilarity, deserializeEmbedding, embed, isAvailable } from "./embeddings";

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

/**
 * Score and rank memories by hybrid BM25 + embedding relevance.
 *
 * @param query - User's search query
 * @param entries - Candidate memory entries to score
 * @param allEntries - All entries in the database (for IDF calculation)
 * @param limit - Maximum results to return
 * @returns Ranked list of scored memories
 */
export async function scoreAndRank(
	query: string,
	entries: MemoryEntry[],
	allEntries: MemoryEntry[],
	limit = 10,
): Promise<ScoredMemory[]> {
	const queryTerms = tokenize(query);
	if (queryTerms.length === 0 && !isAvailable()) return [];

	const idf = computeIDF(queryTerms, allEntries);

	// Generate query embedding if available
	let queryEmbedding: Float32Array | null = null;
	if (isAvailable()) {
		queryEmbedding = await embed(query);
	}

	const scored = entries.map((entry) => {
		// ── BM25 relevance ──
		const contentTerms = tokenize(entry.content);
		let bm25Relevance = 0;
		for (const term of queryTerms) {
			const termIDF = idf.get(term) ?? 0;
			const tf = contentTerms.filter((t) => t === term).length;
			if (tf > 0 && termIDF > 0) {
				bm25Relevance += termIDF * (tf / (tf + 1.2));
			}
		}
		const bm25Score = bm25Relevance > 0 ? bm25Relevance / (bm25Relevance + 1.5) : 0;

		// ── Embedding cosine similarity ──
		let embeddingScore = 0;
		if (queryEmbedding && entry.embedding) {
			const entryVec = deserializeEmbedding(entry.embedding);
			if (entryVec) {
				embeddingScore = Math.max(0, cosineSimilarity(queryEmbedding, entryVec));
			}
		}

		// ── Recency ──
		const ageMs = Date.now() - entry.recency;
		const recency = Math.max(0.1, 1.0 - ageMs / (30 * 24 * 60 * 60 * 1000));

		// ── Composite score ──
		let score: number;
		if (queryEmbedding) {
			// Hybrid: BM25 + embeddings
			score = 0.35 * bm25Score + 0.35 * embeddingScore + 0.2 * entry.importance + 0.1 * recency;
		} else {
			// BM25 only
			score = 0.5 * bm25Score + 0.3 * entry.importance + 0.2 * recency;
		}

		return {
			entry,
			relevance: Math.round(Math.max(bm25Score, embeddingScore) * 100) / 100,
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

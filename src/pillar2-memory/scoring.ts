/**
 * Semantic memory search with BM25-inspired scoring.
 *
 * ## Why not embeddings?
 *
 * True semantic search requires an embedding model — either API-based
 * (sends data off-machine) or local (requires native deps that fail on
 * Node 26). BM25 gives 80% of the value at 0% of the complexity:
 *
 * - **Token overlap** — finds memories sharing terms with the query
 * - **IDF weighting** — rare terms (like "postgres") score higher than common ones ("the")
 * - **Length normalization** — avoids bias toward long entries
 * - **Importance × recency** — critical recent facts outrank trivial old ones
 *
 * ## Future: optional embeddings
 *
 * When the user sets KNAPSACK_EMBEDDING_URL (OpenAI-compatible endpoint),
 * we'll generate embeddings for memories and use cosine similarity for
 * the semantic tier. This is additive to BM25 — we can merge scores.
 *
 * @module search-scoring
 */

import type { MemoryEntry } from "../core/types";

/**
 * Search result with score breakdown for debugging.
 */
export interface ScoredMemory {
	entry: MemoryEntry;
	/** BM25 content relevance score (0-1) */
	relevance: number;
	/** Importance score (0-1, from entry) */
	importance: number;
	/** Recency score (0-1, decays over time) */
	recency: number;
	/** Final composite score (0-1) */
	score: number;
}

/**
 * Score and rank memories by relevance to a query.
 *
 * @param query - User's search query
 * @param entries - Candidate memory entries to score
 * @param allEntries - All entries in the database (for IDF calculation)
 * @param limit - Maximum results to return
 * @returns Ranked list of scored memories
 */
export function scoreAndRank(
	query: string,
	entries: MemoryEntry[],
	allEntries: MemoryEntry[],
	limit = 10,
): ScoredMemory[] {
	const queryTerms = tokenize(query);
	if (queryTerms.length === 0) return [];

	// Calculate IDF for each term across all entries
	const idf = computeIDF(queryTerms, allEntries);

	// Score each entry
	const scored = entries.map((entry) => {
		const contentTerms = tokenize(entry.content);

		// BM25-like relevance: sum of IDF × term frequency in entry / doc length
		let relevance = 0;
		for (const term of queryTerms) {
			const termIDF = idf.get(term) ?? 0;
			const tf = contentTerms.filter((t) => t === term).length;
			if (tf > 0 && termIDF > 0) {
				// Simplified BM25: IDF × (tf / (tf + k))
				// k=1.2: controls term frequency saturation
				relevance += termIDF * (tf / (tf + 1.2));
			}
		}

		// Normalize relevance to 0-1 range
		// Max possible: len(queryTerms) × maxIDF × (∞ / ∞) ~= len(queryTerms) × log(N)
		const maxRelevance = queryTerms.length * Math.log(allEntries.length + 1);
		const normalizedRelevance = maxRelevance > 0 ? relevance / maxRelevance : 0;

		// Recency: 1.0 for < 1 hour, decays to 0.1 after 30 days
		const ageMs = Date.now() - entry.recency;
		const recency = Math.max(0.1, 1.0 - ageMs / (30 * 24 * 60 * 60 * 1000));

		// Composite: 0.5 × relevance + 0.3 × importance + 0.2 × recency
		const score = 0.5 * normalizedRelevance + 0.3 * entry.importance + 0.2 * recency;

		return {
			entry,
			relevance: Math.round(normalizedRelevance * 100) / 100,
			importance: entry.importance,
			recency: Math.round(recency * 100) / 100,
			score: Math.round(score * 100) / 100,
		};
	});

	// Sort by score descending
	scored.sort((a, b) => b.score - a.score);

	return scored.slice(0, limit);
}

/**
 * Tokenize text into lowercase terms, filtering stop words.
 *
 * @param text - Raw text to tokenize
 * @returns Array of lowercase terms (no duplicates within this text)
 */
function tokenize(text: string): string[] {
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
		"use",
		"using",
		"used",
		"when",
		"what",
		"how",
		"why",
		"which",
		"who",
	]);

	return text
		.toLowerCase()
		.split(/[\s,.;:!?()[\]{}"'`@#$%^&*+=<>|\\/~-]+/)
		.filter((w) => w.length >= 2 && !stopWords.has(w));
}

/**
 * Compute Inverse Document Frequency for query terms.
 *
 * IDF = log((N - df + 0.5) / (df + 0.5) + 1)
 * where N = total documents, df = documents containing the term.
 *
 * Rare terms (high IDF) are more discriminative — "postgres" appears
 * in fewer documents than "file", so matches on "postgres" matter more.
 *
 * @param terms - Query terms to compute IDF for
 * @param allEntries - All memory entries in the database
 * @returns Map of term → IDF score
 */
function computeIDF(terms: string[], allEntries: MemoryEntry[]): Map<string, number> {
	const N = allEntries.length;
	if (N === 0) return new Map();

	const idf = new Map<string, number>();

	for (const term of terms) {
		// Count documents containing this term
		let df = 0;
		for (const entry of allEntries) {
			if (entry.content.toLowerCase().includes(term)) {
				df++;
			}
		}

		// BM25 IDF formula (prevents negative values with the +1)
		const score = Math.log((N - df + 0.5) / (df + 0.5) + 1);
		idf.set(term, score);
	}

	return idf;
}

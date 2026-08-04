/**
 * Hybrid memory search — BM25 + optional embeddings fusion via Reciprocal Rank
 * Fusion (RRF), with MMR diversity, Ebbinghaus decay, and type-field boosting.
 *
 * ## Scoring (research-backed, see DESIGN-memory-v2.md)
 *
 * 1. BM25 and embedding similarities are computed per-entry.
 * 2. Entries are ranked separately by BM25 and embedding to produce two
 *    rank lists; RRF (k=60) fuses them into a single score.
 *    RRF = 1/(60 + bm25Rank) + 1/(60 + embedRank).
 * 3. A small tiebreaker term (importance + Ebbinghaus recency + frecency)
 *    is added to prevent ties among identical-score entries.
 * 4. Type-field boost (constraint ×1.5, decision ×1.3) multiplies the
 *    BM25 contribution before ranking, so typed entries rank higher for
 *    the same content.
 * 5. When injecting (limit ≤ 15), MMR λ=0.7 diversity rerank selects
 *    the final set from the top-N candidates.
 *
 * When embeddings are absent: BM25-only ranking, no RRF fusion.
 *
 * @module search-scoring
 */

import type { MemoryEntry } from "../core/types";
import { cosineSimilarity, deserializeEmbedding, embed, isAvailable } from "./embeddings";

/** Common English stop words excluded from BM25 tokenisation to reduce noise. */
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

/** Scored memory entry — the output of {@link scoreAndRank} with breakdown by signal. */
export interface ScoredMemory {
	entry: MemoryEntry;
	relevance: number;
	importance: number;
	recency: number;
	score: number;
}

/**
 * Score and rank memories by hybrid BM25 + embedding relevance via RRF.
 *
 * When embeddings are available, produces two independent rank lists (BM25
 * and cosine similarity), fuses them with Reciprocal Rank Fusion (k=60),
 * and optionally applies MMR diversity rerank for small injection limits.
 *
 * When embeddings are absent, ranks by BM25 alone with a small
 * importance + Ebbinghaus + frecency tiebreaker.
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
	if (queryTerms.length === 0) {
		if (!isAvailable()) return [];
		// Embeddings available — rank by recency + importance; no BM25 signal from empty query.
		const scored = entries.map((e) => ({
			entry: e,
			relevance: 0,
			importance: e.importance,
			recency: ebbinghaus(e),
			score: 0.4 * e.importance + 0.6 * ebbinghaus(e),
		}));
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit);
	}

	const idf = computeIDF(queryTerms, allEntries);

	// Generate query embedding if available
	let queryEmbedding: Float32Array | null = null;
	if (isAvailable()) {
		queryEmbedding = await embed(query);
	}

	// Detect uppercase signal for smart-case boost (fff-style)
	const hasUpper = /[A-Z]/.test(query);
	let upperTokens: string[] = [];
	if (hasUpper) {
		upperTokens = query
			.split(/[\s,.;:!?()[\]{}"'`@#$%^&*+=<>|\\/~-]+/)
			.filter((t) => /[A-Z]/.test(t));
	}

	// ── Per-entry raw scores ──
	const raw = entries.map((entry) => {
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

		let smartCaseBoost = 1;
		if (hasUpper && bm25Score > 0) {
			if (upperTokens.some((t) => entry.content.includes(t))) smartCaseBoost = 1.15;
		}

		const typeBoost = entry.type === "constraint" ? 1.5 : entry.type === "decision" ? 1.3 : 1.0;

		let embeddingScore = 0;
		if (queryEmbedding && entry.embedding) {
			const vec = deserializeEmbedding(entry.embedding);
			if (vec) embeddingScore = Math.max(0, cosineSimilarity(queryEmbedding, vec));
		}

		return {
			entry,
			bm25: bm25Score * smartCaseBoost * typeBoost,
			embed: embeddingScore,
			recency: ebbinghaus(entry),
			frecency: Math.min(1, Math.log2(1 + entry.accessCount) / 5),
			caseBoost: smartCaseBoost > 1,
		};
	});

	// ── RRF fusion ──
	const K = 60;
	// Assign BM25 ranks (ties receive fractional 0.5 penalty)
	const bm25Sorted = raw.map((r, i) => ({ i, score: r.bm25 })).sort((a, b) => b.score - a.score);
	const bm25Ranks = new Map<number, number>();
	for (let rank = 0; rank < bm25Sorted.length; rank++) {
		const entry = bm25Sorted[rank]!;
		if (entry.score === 0) {
			bm25Ranks.set(entry.i, entries.length);
		} else {
			const prev = rank > 0 ? bm25Sorted[rank - 1] : null;
			const effectiveRank = prev && prev.score === entry.score ? bm25Ranks.get(prev.i)! : rank;
			bm25Ranks.set(entry.i, effectiveRank);
		}
	}

	// Assign embedding ranks
	const embedRanks = new Map<number, number>();
	if (queryEmbedding) {
		const embSorted = raw.map((r, i) => ({ i, score: r.embed })).sort((a, b) => b.score - a.score);
		for (let rank = 0; rank < embSorted.length; rank++) {
			embedRanks.set(embSorted[rank]!.i, rank);
		}
	}

	// Fuse: RRF + tiebreaker + case bonus
	const scored: ScoredMemory[] = raw.map((r, i) => {
		const bm25Rank = bm25Ranks.get(i) ?? entries.length;
		const embedRank = embedRanks.get(i);
		const caseBonus = r.caseBoost ? 0.005 : 0;
		const confidence = r.entry.confidence ?? 0.7;
		const supersededPenalty = r.entry.supersededBy ? 0.2 : 0;
		let score: number;
		if (embedRank !== undefined) {
			score =
				(1 / (K + bm25Rank) +
					1 / (K + embedRank) +
					0.02 * r.entry.importance +
					0.02 * r.recency +
					0.01 * r.frecency +
					caseBonus -
					supersededPenalty) *
				confidence;
		} else {
			score =
				(1 / (K + bm25Rank) +
					0.04 * r.entry.importance +
					0.03 * r.recency +
					0.02 * r.frecency +
					caseBonus -
					supersededPenalty) *
				confidence;
		}
		return {
			entry: r.entry,
			relevance: Math.round(Math.max(r.bm25, r.embed) * 100) / 100,
			importance: r.entry.importance,
			recency: Math.round(r.recency * 100) / 100,
			score: Math.round(score * 10000) / 10000,
		};
	});

	scored.sort((a, b) => b.score - a.score);

	// ── MMR diversity rerank (for injection: small limits from larger pools) ──
	if (limit <= 15 && scored.length > limit) {
		return mmrSelect(scored, limit, queryEmbedding);
	}

	return scored.slice(0, limit);
}

/** Tokenise text into lowercase terms, filtering stop words and short tokens. */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[\s,.;:!?()[\]{}"'`@#$%^&*+=<>|\\/~-]+/)
		.filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * Compute BM25 IDF scores for query terms across all memory entries.
 *
 * Tokenises each entry (same {@link tokenize} function used for queries)
 * so IDF counts exact token matches rather than substring containment.
 * Fixes the bug where "SQL" would match "sqlite" and inflate df.
 */
function computeIDF(terms: string[], allEntries: MemoryEntry[]): Map<string, number> {
	const N = allEntries.length;
	if (N === 0) return new Map();

	const entryTokens = allEntries.map((e) => new Set(tokenize(e.content)));

	const idf = new Map<string, number>();

	for (const term of terms) {
		let df = 0;
		for (const tokens of entryTokens) {
			if (tokens.has(term)) df++;
		}
		const score = Math.log((N - df + 0.5) / (df + 0.5) + 1);
		idf.set(term, score);
	}

	return idf;
}

/**
 * Ebbinghaus exponential recency score.
 *
 * `R = e^(-t_hours / S)` where `S` is the entry's memory strength
 * (discrete integer, defaults to 1 — incremented on retrieval hits
 * once the `strength` column is added to the schema in Phase 2).
 *
 * Replaces the previous linear 30-day decay: `max(0.1, 1 - ageMs / 30d)`.
 * Evidence: MemoryBank (arXiv 2305.10250), DESIGN §1c.
 */
function ebbinghaus(entry: MemoryEntry, now = Date.now()): number {
	const tHours = Math.max(0, (now - entry.recency) / (60 * 60 * 1000));
	const S = Math.max(1, entry.strength ?? 1);
	return Math.exp(-tHours / S);
}

/**
 * Maximal Marginal Relevance diversity rerank.
 *
 * Selects `k` diverse items from a scored list via the MMR algorithm
 * (Carbonell & Goldstein, SIGIR 1998): λ * relevance(candidate) −
 * (1−λ) * max_{j∈selected} similarity(candidate, j).
 *
 * Uses cosine similarity over stored embeddings when available, falling
 * back to Jaccard token overlap.
 */
function mmrSelect(
	scored: ScoredMemory[],
	k: number,
	queryEmbedding: Float32Array | null,
	lambda = 0.7,
): ScoredMemory[] {
	if (scored.length <= k) return scored;

	const selected: ScoredMemory[] = [];
	const remaining = [...scored];

	// Pick the highest-scoring entry first
	selected.push(remaining.shift()!);

	while (selected.length < k && remaining.length > 0) {
		let bestIdx = 0;
		let bestScore = -Infinity;

		for (let i = 0; i < remaining.length; i++) {
			const candidate = remaining[i]!;

			// Max similarity to any selected entry
			let maxSim = 0;
			if (queryEmbedding && candidate.entry.embedding) {
				const candVec = deserializeEmbedding(candidate.entry.embedding);
				if (candVec) {
					for (const s of selected) {
						if (s.entry.embedding) {
							const sVec = deserializeEmbedding(s.entry.embedding);
							if (sVec) {
								const sim = Math.max(0, cosineSimilarity(candVec, sVec));
								if (sim > maxSim) maxSim = sim;
							}
						}
					}
				}
			} else {
				// Fallback: Jaccard token overlap
				const candTokens = new Set(tokenize(candidate.entry.content));
				for (const s of selected) {
					const sTokens = new Set(tokenize(s.entry.content));
					let intersect = 0;
					for (const t of candTokens) if (sTokens.has(t)) intersect++;
					const sim = intersect / (candTokens.size + sTokens.size - intersect || 1);
					if (sim > maxSim) maxSim = sim;
				}
			}

			const mmrScore = lambda * candidate.score - (1 - lambda) * maxSim;
			if (mmrScore > bestScore) {
				bestScore = mmrScore;
				bestIdx = i;
			}
		}

		const best = remaining.splice(bestIdx, 1)[0]!;
		selected.push(best);
	}

	return selected;
}

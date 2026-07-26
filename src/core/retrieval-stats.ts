/**
 * Retrieval pressure learning — tracks which compressed outputs get
 * retrieved and adjusts compression aggressiveness per strategy.
 *
 * ## How it works
 *
 * When `knapsack_retrieve(hash)` is called, we look up which strategy
 * compressed that hash and increment a per-strategy retrieval counter.
 * Over time, strategies with high retrieval rates (>15%) get more
 * conservative compression (more samples kept, lower threshold).
 * Strategies with zero retrievals after 30+ compressions get more
 * aggressive compression (fewer samples, higher threshold).
 *
 * ## Storage
 *
 * Stats are stored in the `meta` table as a JSON blob under the key
 * `retrieval_stats`. This avoids schema migrations.
 *
 * @module retrieval-stats
 */

import type { KnapsackDB } from "./database";

/** Per-strategy retrieval statistics. */
export interface StrategyRetrievalStats {
	/** Number of knapsack_retrieve calls for this strategy */
	retrievals: number;
	/** Number of compressions recorded for this strategy */
	compressions: number;
}

/** All retrieval stats keyed by strategy name. */
export type RetrievalStatsMap = Record<string, StrategyRetrievalStats>;

/** Retrieval rate above which compression becomes more conservative. */
const HIGH_RETRIEVAL_THRESHOLD = 0.15;

/** Minimum compressions before adjusting aggressiveness. */
const MIN_COMPRESSIONS_FOR_ADJUSTMENT = 30;

/** Default sample count for strategies. */
const DEFAULT_MAX_SAMPLES = 3;

/** Conservative sample count for high-retrieval strategies. */
const CONSERVATIVE_MAX_SAMPLES = 5;

/** Aggressive sample count for zero-retrieval strategies. */
const AGGRESSIVE_MAX_SAMPLES = 1;

/** Default threshold multiplier (1.0 = no change). */
const DEFAULT_THRESHOLD_MULTIPLIER = 1.0;

/** Conservative threshold multiplier (lower threshold = compress more often). */
const CONSERVATIVE_THRESHOLD_MULTIPLIER = 0.8;

/** Aggressive threshold multiplier (higher threshold = compress less often). */
const AGGRESSIVE_THRESHOLD_MULTIPLIER = 1.2;

/** Meta key for storing retrieval stats in the database. */
const META_KEY = "retrieval_stats";

/**
 * Load retrieval stats from the database.
 *
 * @param db - Knapsack database handle
 * @returns Stats map keyed by strategy name, or empty object if none stored
 */
export function loadRetrievalStats(db: KnapsackDB): RetrievalStatsMap {
	const raw = db.getMeta(META_KEY);
	if (!raw) return {};
	try {
		return JSON.parse(raw) as RetrievalStatsMap;
	} catch {
		return {};
	}
}

/**
 * Save retrieval stats to the database.
 *
 * @param db - Knapsack database handle
 * @param stats - Stats map to persist
 */
export function saveRetrievalStats(db: KnapsackDB, stats: RetrievalStatsMap): void {
	db.setMeta(META_KEY, JSON.stringify(stats));
}

/**
 * Record a retrieval event for a given strategy.
 *
 * Called when `knapsack_retrieve(hash)` is invoked. Looks up the strategy
 * from the compression table and increments its retrieval counter.
 *
 * @param db - Knapsack database handle
 * @param hash - Content hash that was retrieved
 */
export function recordRetrieval(db: KnapsackDB, hash: string): void {
	const entry = db.getCompressionByHash(hash);
	if (!entry) return;

	const stats = loadRetrievalStats(db);
	const key = entry.strategy;
	if (!stats[key]) {
		stats[key] = { retrievals: 0, compressions: 0 };
	}
	stats[key].retrievals++;
	saveRetrievalStats(db, stats);
}

/**
 * Record a compression event for a given strategy.
 *
 * Called when the pipeline compresses a tool output. Increments the
 * compression counter for that strategy.
 *
 * @param db - Knapsack database handle
 * @param strategy - Strategy name (e.g. "bash", "json", "find")
 */
export function recordCompressionForStats(db: KnapsackDB, strategy: string): void {
	const stats = loadRetrievalStats(db);
	if (!stats[strategy]) {
		stats[strategy] = { retrievals: 0, compressions: 0 };
	}
	stats[strategy].compressions++;
	saveRetrievalStats(db, stats);
}

/**
 * Get the retrieval rate for a strategy.
 *
 * @param stats - Stats map
 * @param strategy - Strategy name
 * @returns Retrieval rate (0.0 - 1.0), or 0 if no compressions recorded
 */
export function getRetrievalRate(stats: RetrievalStatsMap, strategy: string): number {
	const s = stats[strategy];
	if (!s || s.compressions === 0) return 0;
	return s.retrievals / s.compressions;
}

/**
 * Get the recommended max samples for a strategy based on retrieval pressure.
 *
 * High-retrieval strategies get more samples (conservative).
 * Zero-retrieval strategies get fewer samples (aggressive).
 *
 * @param stats - Stats map
 * @param strategy - Strategy name
 * @returns Recommended MAX_SAMPLES value (1, 3, or 5)
 */
export function getAdaptiveMaxSamples(stats: RetrievalStatsMap, strategy: string): number {
	const s = stats[strategy];
	if (!s || s.compressions < MIN_COMPRESSIONS_FOR_ADJUSTMENT) {
		return DEFAULT_MAX_SAMPLES;
	}

	const rate = getRetrievalRate(stats, strategy);
	if (rate >= HIGH_RETRIEVAL_THRESHOLD) {
		return CONSERVATIVE_MAX_SAMPLES;
	}
	if (rate === 0) {
		return AGGRESSIVE_MAX_SAMPLES;
	}
	return DEFAULT_MAX_SAMPLES;
}

/**
 * Get the recommended threshold multiplier for a strategy.
 *
 * High-retrieval strategies get a lower threshold (compress less often).
 * Zero-retrieval strategies get a higher threshold (compress more selectively).
 *
 * @param stats - Stats map
 * @param strategy - Strategy name
 * @returns Threshold multiplier (0.8, 1.0, or 1.2)
 */
export function getAdaptiveThresholdMultiplier(stats: RetrievalStatsMap, strategy: string): number {
	const s = stats[strategy];
	if (!s || s.compressions < MIN_COMPRESSIONS_FOR_ADJUSTMENT) {
		return DEFAULT_THRESHOLD_MULTIPLIER;
	}

	const rate = getRetrievalRate(stats, strategy);
	if (rate >= HIGH_RETRIEVAL_THRESHOLD) {
		return CONSERVATIVE_THRESHOLD_MULTIPLIER;
	}
	if (rate === 0) {
		return AGGRESSIVE_THRESHOLD_MULTIPLIER;
	}
	return DEFAULT_THRESHOLD_MULTIPLIER;
}

/**
 * Get a human-readable summary of retrieval stats for all strategies.
 *
 * @param stats - Stats map
 * @returns Formatted string showing per-strategy retrievals, compressions, and rate
 */
export function formatRetrievalStats(stats: RetrievalStatsMap): string {
	const lines: string[] = ["Retrieval pressure:"];
	for (const [strategy, s] of Object.entries(stats)) {
		const rate = s.compressions > 0 ? ((s.retrievals / s.compressions) * 100).toFixed(1) : "0.0";
		lines.push(`  ${strategy}: ${s.retrievals}/${s.compressions} retrieved (${rate}%)`);
	}
	return lines.join("\n");
}

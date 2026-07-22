/**
 * Output cache — stores fully processed compression outputs by content hash.
 *
 * ## Purpose
 *
 * Combines two optimizations from the Headroom comparison (P0 CacheAligner +
 * P1 Live-Zone):
 * - **CacheAligner**: deterministic output for identical input. The compression
 *   pipeline is already deterministic (SHA256-based hashing, fixed strategies),
 *   but this cache makes it explicit and skips the work entirely on repeat hits.
 * - **Live-Zone compression**: skip re-compression of unchanged content across
 *   turns. In long sessions the same tool output may appear in context multiple times;
 *   without this cache, each occurrence re-runs the full strategy pipeline.
 *
 * ## How it works
 *
 * `compressionHook` computes the SHA256 of the original content before any
 * processing. If that hash is in the cache, the hook returns the cached body +
 * footer without running strategies, tag protection, or secret redaction again.
 * The CCR cache ({@link cache}) stores the *original* for retrieval; this cache
 * stores the *compressed output* for reuse.
 *
 * ## Eviction
 *
 * LRU with a configurable max size (default 256 entries). `get()` promotes the
 * entry to most-recently-used. When the cache is full and a new entry is added,
 * the least-recently-used entry is evicted.
 *
 * @module output-cache
 */

/**
 * A fully processed compression output, ready to return to Pi without re-running
 * any post-transforms.
 *
 * The footer is NOT cached — it is rebuilt on each cache hit because drift
 * anchors may change between turns.
 */
export interface CachedCompression {
	/** Post-transform body (secret-redacted, tag-restored) */
	readonly body: string;
	/** Strategy name for stats recording */
	readonly strategy: string;
	/** Original token count for stats recording */
	readonly originalTokens: number;
	/** Compressed token count for stats recording */
	readonly compressedTokens: number;
	/** Savings percentage for stats recording */
	readonly savingsPercent: number;
	/** Original content hash for stats recording */
	readonly originalHash: string;
}

/** Cache statistics for `/knapsack-status` and debugging. */
export interface OutputCacheStats {
	/** Number of cache hits (content was already cached, compression skipped) */
	readonly hits: number;
	/** Number of cache misses (content was not cached, compression ran) */
	readonly misses: number;
	/** Current number of entries in the cache */
	readonly size: number;
	/** Maximum number of entries before LRU eviction kicks in */
	readonly maxSize: number;
}

/** Default maximum number of entries before LRU eviction. */
const DEFAULT_MAX_ENTRIES = 256;

/**
 * LRU cache for compression outputs.
 *
 * Keyed by the SHA256 hash of the original (pre-processing) content. Values are
 * the fully processed output (body + footer + stats fields) that can be returned
 * to Pi directly without re-running any transforms.
 *
 * @example
 * ```typescript
 * const cache = new OutputCache();
 * const hash = sha256(originalContent);
 *
 * const cached = cache.get(hash);
 * if (cached) {
 *   // Skip compression — return cached output
 *   return { content: [{ type: "text", text: cached.body }, { type: "text", text: cached.footer }] };
 * }
 *
 * // ... run compression pipeline ...
 * cache.set(hash, { body, footer, strategy, originalTokens, compressedTokens, savingsPercent, originalHash: hash });
 * ```
 */
export class OutputCache {
	private readonly cache = new Map<string, CachedCompression>();
	private readonly maxSize: number;
	private hits = 0;
	private misses = 0;

	/**
	 * @param maxSize - Maximum entries before LRU eviction. Defaults to 256.
	 */
	constructor(maxSize: number = DEFAULT_MAX_ENTRIES) {
		this.maxSize = maxSize;
	}

	/**
	 * Look up a cached compression output by content hash.
	 *
	 * Promotes the entry to most-recently-used on hit. Increments hit/miss
	 * counters for stats reporting.
	 *
	 * @param hash - SHA256 hash of the original content
	 * @returns The cached compression output, or `undefined` if not present
	 */
	get(hash: string): CachedCompression | undefined {
		const entry = this.cache.get(hash);
		if (entry === undefined) {
			this.misses++;
			return undefined;
		}
		// Promote to most-recently-used: Map preserves insertion order, so
		// delete + re-set moves the entry to the end (most recently used).
		this.cache.delete(hash);
		this.cache.set(hash, entry);
		this.hits++;
		return entry;
	}

	/**
	 * Store a compression output in the cache.
	 *
	 * If the hash already exists, the entry is updated and promoted. If the
	 * cache is full, the least-recently-used entry is evicted first.
	 *
	 * @param hash - SHA256 hash of the original content
	 * @param entry - The fully processed compression output to cache
	 */
	set(hash: string, entry: CachedCompression): void {
		if (this.cache.has(hash)) {
			this.cache.delete(hash);
		} else if (this.cache.size >= this.maxSize) {
			// Evict least-recently-used (first key in Map iteration order).
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) {
				this.cache.delete(oldest);
			}
		}
		this.cache.set(hash, entry);
	}

	/**
	 * Remove all entries and reset hit/miss counters.
	 *
	 * Called between tests to ensure isolation.
	 */
	clear(): void {
		this.cache.clear();
		this.hits = 0;
		this.misses = 0;
	}

	/** Current number of entries in the cache. */
	get size(): number {
		return this.cache.size;
	}

	/**
	 * Return cache statistics for monitoring and `/knapsack-status`.
	 *
	 * @returns Hit/miss counts, current size, and max size
	 */
	stats(): OutputCacheStats {
		return {
			hits: this.hits,
			misses: this.misses,
			size: this.cache.size,
			maxSize: this.maxSize,
		};
	}
}

/**
 * Default singleton cache instance used by {@link compressionHook}.
 *
 * Tests should call `outputCache.clear()` in `beforeEach` to ensure isolation.
 */
export const outputCache = new OutputCache();

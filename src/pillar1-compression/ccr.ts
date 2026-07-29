/**
 * Compress-Cache-Retrieve (CCR) — Knapsack's reversible compression layer.
 *
 * ## Storage
 *
 * Originals cached as plain files in `~/.knapsack/cache/{hash}` (NOT in the
 * Obsidian vault). The vault is for human-readable notes; CCR cache is
 * machine-managed and should not pollute the Obsidian graph.
 *
 * ## Idempotency
 *
 * `cache()` checks file existence before writing. Calling it twice with the
 * same hash is a no-op.
 *
 * @module ccr
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HASH_PATTERN = /^[a-f0-9]{1,64}$/;

/**
 * Optional filters for sliceable CCR retrieval.
 *
 * When multiple options are provided, grep is applied first, then
 * range/slice operators (lines, head, tail) are applied to the result.
 */
export interface RetrieveOptions {
	/** Case-insensitive regex — return only lines matching this pattern */
	grep?: string;
	/** Line range in "N-M" format (1-indexed, inclusive) */
	lines?: string;
	/** Return first N lines */
	head?: number;
	/** Return last N lines */
	tail?: number;
}

/** Validate that a hash matches the expected hex pattern before using it as a filename. */
function isValidHash(hash: string): boolean {
	return HASH_PATTERN.test(hash);
}

/**
 * Resolve the cache directory: ~/.knapsack/cache
 * Falls back to vaultPath/knapsack/cache for backward compatibility.
 */
function getCacheDir(knapsackHome: string | null, vaultPath: string | null): string {
	if (knapsackHome) return join(knapsackHome, "cache");
	if (vaultPath) return join(vaultPath, "knapsack", "compress");
	return join(process.env.HOME ?? "~", ".knapsack", "cache");
}

/**
 * Store an original (uncompressed) tool output in the local cache.
 *
 * Files are stored at `~/.knapsack/cache/{hash}` as plain text — no
 * frontmatter, no markdown wrapping. Fast to write, fast to read.
 *
 * @param knapsackHome - Path to ~/.knapsack (preferred cache location)
 * @param vaultPath - Vault path (fallback for backward compat, not recommended)
 * @param hash - SHA256 content hash (used as filename)
 * @param original - The full, uncompressed tool output
 * @returns The hash if stored, or null if no path available
 */
export function cache(
	knapsackHome: string | null,
	vaultPath: string | null,
	hash: string,
	original: string,
): string | null {
	const dir = getCacheDir(knapsackHome, vaultPath);
	mkdirSync(dir, { recursive: true });

	const filePath = join(dir, hash);

	if (existsSync(filePath)) return hash;

	writeFileSync(filePath, original, "utf-8");
	return hash;
}

/**
 * Retrieve a cached original from the local cache, optionally filtered.
 *
 * Checks ~/.knapsack/cache first, then falls back to vault/knapsack/compress
 * for backward compatibility with old cached files.
 *
 * When options are provided, the full original is read from cache and then
 * filtered in-memory (grep → lines/head/tail). The result is prefixed with
 * a header describing the filter and matched/unmatched counts.
 *
 * @param knapsackHome - Path to ~/.knapsack (preferred cache location)
 * @param vaultPath - Vault path (fallback)
 * @param hash - SHA256 content hash
 * @param options - Optional filters (grep, lines range, head, tail)
 * @returns The original (or filtered slice), or null if not found
 */
export function retrieve(
	knapsackHome: string | null,
	vaultPath: string | null,
	hash: string,
	options?: RetrieveOptions,
): string | null {
	if (!isValidHash(hash)) return null;

	const full = readCached(knapsackHome, vaultPath, hash);
	if (full === null) return null;

	if (!options || !hasFilters(options)) return full;

	return applyFilters(full, hash, options);
}

/**
 * Read the raw cached content (no filtering).
 *
 * @param knapsackHome - Path to ~/.knapsack
 * @param vaultPath - Vault path (fallback)
 * @param hash - SHA256 content hash
 * @returns Raw cached content or null
 */
function readCached(
	knapsackHome: string | null,
	vaultPath: string | null,
	hash: string,
): string | null {
	if (knapsackHome) {
		const filePath = join(knapsackHome, "cache", hash);
		if (existsSync(filePath)) {
			return readFileSync(filePath, "utf-8");
		}
	}

	if (vaultPath) {
		const oldPath = join(vaultPath, "knapsack", "compress", `${hash}.md`);
		if (existsSync(oldPath)) {
			const content = readFileSync(oldPath, "utf-8");
			const fenceMatch = content.match(/```knapsack-ccr\n([\s\S]*?)\n```/);
			if (fenceMatch?.[1]) return fenceMatch[1];
			return content;
		}
	}

	return null;
}

/**
 * Check whether any slice/filter option is present.
 */
function hasFilters(opts: RetrieveOptions): boolean {
	return (
		opts.grep !== undefined ||
		opts.lines !== undefined ||
		opts.head !== undefined ||
		opts.tail !== undefined
	);
}

/**
 * Apply slice/filter options to cached content.
 *
 * Order: grep first (line filter), then lines/head/tail (range).
 *
 * @param content - Full cached content
 * @param hash - Original hash (for header)
 * @param opts - Filter options
 * @returns Filtered content with header
 */
function applyFilters(content: string, hash: string, opts: RetrieveOptions): string {
	const allLines = content.split("\n");
	let lines = allLines;
	let filterDesc = "";

	if (opts.grep !== undefined) {
		const pattern = new RegExp(opts.grep, "i");
		lines = allLines.filter((l) => pattern.test(l));
		filterDesc = `grep="${opts.grep}", ${lines.length}/${allLines.length} lines`;
	}

	if (opts.lines !== undefined) {
		const range = parseLineRange(opts.lines, lines.length);
		if (range) {
			lines = lines.slice(range.start, range.end);
			const desc = `lines=${opts.lines}`;
			filterDesc = filterDesc ? `${filterDesc}, ${desc}` : desc;
		}
	}

	if (opts.head !== undefined && opts.head > 0) {
		lines = lines.slice(0, opts.head);
		const desc = `head=${opts.head}`;
		filterDesc = filterDesc ? `${filterDesc}, ${desc}` : desc;
	}

	if (opts.tail !== undefined && opts.tail > 0) {
		const start = Math.max(0, lines.length - opts.tail);
		lines = lines.slice(start);
		const desc = `tail=${opts.tail}`;
		filterDesc = filterDesc ? `${filterDesc}, ${desc}` : desc;
	}

	const header = `── RETRIEVED (${filterDesc}, hash ${hash}) ──`;
	return `${header}\n${lines.join("\n")}`;
}

/**
 * Parse a "N-M" line range string into 0-indexed start/end.
 *
 * @param rangeStr - Range string like "5-10"
 * @param totalLines - Total number of lines available
 * @returns 0-indexed slice bounds, or null if invalid
 */
function parseLineRange(
	rangeStr: string,
	totalLines: number,
): { start: number; end: number } | null {
	const match = rangeStr.match(/^(\d+)-(\d+)$/);
	if (!match) return null;

	const start = Number(match[1]) - 1; // 1-indexed → 0-indexed
	const end = Number(match[2]);

	if (start < 0 || end < 1 || start >= end) return null;

	return { start, end: Math.min(end, totalLines) };
}

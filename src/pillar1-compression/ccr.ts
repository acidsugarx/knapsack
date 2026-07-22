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
 * Retrieve a cached original from the local cache.
 *
 * Checks ~/.knapsack/cache first, then falls back to vault/knapsack/compress
 * for backward compatibility with old cached files.
 *
 * @param knapsackHome - Path to ~/.knapsack (preferred cache location)
 * @param vaultPath - Vault path (fallback)
 * @param hash - SHA256 content hash
 * @returns The original uncompressed output, or null if not found
 */
export function retrieve(
	knapsackHome: string | null,
	vaultPath: string | null,
	hash: string,
): string | null {
	if (!isValidHash(hash)) return null;

	// Try primary cache location first
	if (knapsackHome) {
		const filePath = join(knapsackHome, "cache", hash);
		if (existsSync(filePath)) {
			return readFileSync(filePath, "utf-8");
		}
	}

	// Fall back to old vault location for backward compat
	if (vaultPath) {
		const oldPath = join(vaultPath, "knapsack", "compress", `${hash}.md`);
		if (existsSync(oldPath)) {
			const content = readFileSync(oldPath, "utf-8");
			// Old format: extract from ```knapsack-ccr fence
			const fenceMatch = content.match(/```knapsack-ccr\n([\s\S]*?)\n```/);
			if (fenceMatch?.[1]) return fenceMatch[1];
			return content;
		}
	}

	return null;
}

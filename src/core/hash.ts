/**
 * Knapsack — core crypto utilities for content-based idempotency.
 *
 * All Knapsack operations use SHA256 content hashes as idempotency keys.
 * Same input → same hash → safe to retry any operation.
 *
 * @module hash
 * @packageDocumentation
 */

import { createHash } from "node:crypto";

/**
 * Short SHA256 hash (first 16 hex chars) for idempotency keys.
 *
 * 16 chars = 64 bits of collision resistance. Sufficient for
 * content-based deduplication where the consequence of a collision
 * is a skipped save (not data loss).
 *
 * @param input - Content to hash (typically concatenation of content + type)
 * @returns First 16 hex characters of SHA256 digest
 *
 * @example
 * ```typescript
 * const hash = sha256("important decision" + "decision");
 * // → "a1b2c3d4e5f6a7b8"
 * ```
 */
export function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Full SHA256 hash (64 hex chars) for cases requiring higher collision resistance.
 *
 * Use this when the hash is exposed externally (e.g., CCR retrieval keys in Obsidian)
 * where collision resistance matters more than token efficiency.
 *
 * @param input - Content to hash
 * @returns Full 64-character SHA256 hex digest
 */
export function sha256Full(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

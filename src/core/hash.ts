import { createHash } from "node:crypto";

/**
 * SHA256 hash for content-based idempotency.
 * All Knapsack operations use content hashes as idempotency keys —
 * same input always produces same hash, so operations are safe to retry.
 */
export function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function sha256Full(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

/**
 * Adaptive sizing via information-saturation detection.
 *
 * Replaces fixed caps like "keep 15 dirs / 5 files per dir" with a count
 * derived from the items themselves: how many do we need before new items
 * stop adding unique information?
 *
 * ## Algorithm (Kneedle, ported concept from Headroom adaptive_sizer)
 *
 * 1. Walk items in importance order. Maintain a running set of unique
 *    word bigrams seen so far.
 * 2. Build a normalized coverage curve `y[k] = |unique bigrams in first k+1
 *    items| / total` against `x[k] = k / (n-1)`.
 * 3. The knee is the index maximising perpendicular distance from the
 *    diagonal line connecting the curve's endpoints (the standard Kneedle
 *    criterion).
 * 4. Return the knee index. If no knee clears the 0.05 sensitivity
 *    threshold (curve nearly linear — items add information uniformly),
 *    return the full count: nothing safe to drop.
 *
 * ## Fast paths
 *
 * - `items.length <= 8` — keep all (overhead of the algorithm would exceed
 *   the savings).
 * - Near-total simhash redundancy (`uniqueCount <= 3`) — keep that count.
 *
 * @module adaptive-sizer
 */

/** Per-item bigrams from whitespace-split lowercased words. */
function bigrams(item: string): string[] {
	const words = item
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 0);
	if (words.length < 2) return words.length === 1 ? [words[0] ?? ""] : [];
	const out: string[] = [];
	for (let i = 0; i < words.length - 1; i++) {
		out.push(`${words[i] ?? ""} ${words[i + 1] ?? ""}`);
	}
	return out;
}

/** Sensitivity threshold for the Kneedle distance (Headroom parity: 0.05). */
const KNEELE_MIN_DISTANCE = 0.05;

/**
 * Compute the optimal number of items to keep from a sequence, by detecting
 * where adding more items stops contributing new information.
 *
 * @param items - Items in importance order (e.g. highest match count first)
 * @param bias - Multiplier on the knee index (>1 = keep more, <1 = compress more aggressively)
 * @returns Recommended keep count; always `>= 1` when items is non-empty
 */
export function optimalK(items: string[], bias = 1.0): number {
	const n = items.length;
	if (n === 0) return 0;
	if (n <= 8) return n;

	// Build cumulative unique-bigram coverage curve.
	const seen = new Set<string>();
	const curve: number[] = [];
	for (const item of items) {
		for (const b of bigrams(item)) seen.add(b);
		curve.push(seen.size);
	}

	// Near-total redundancy fast path.
	if (seen.size <= 3) return Math.max(1, seen.size);

	const maxX = n - 1;
	const maxY = curve[curve.length - 1] ?? 1;
	if (maxX === 0 || maxY === 0) return n;

	let knee = 0;
	let maxDist = 0;
	for (let i = 0; i < curve.length; i++) {
		const x = i / maxX;
		const y = (curve[i] ?? 0) / maxY;
		// Perpendicular distance from the diagonal y=x, normalised.
		const dist = Math.abs(y - x) / Math.SQRT2;
		if (dist > maxDist) {
			maxDist = dist;
			knee = i;
		}
	}

	if (maxDist < KNEELE_MIN_DISTANCE) return n;

	const biased = Math.floor(knee * bias);
	return Math.max(1, Math.min(n, biased));
}

/**
 * Convenience: pick how many items to keep, never exceeding a hard ceiling.
 *
 * The ceiling protects pathological inputs (10 000 unique items) where the
 * knee algorithm legitimately says "keep everything".
 */
export function optimalKCapped(items: string[], ceiling: number, bias = 1.0): number {
	return Math.min(optimalK(items, bias), ceiling);
}

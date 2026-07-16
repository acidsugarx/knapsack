/**
 * Knapsack — token estimation utilities.
 *
 * Uses character-based heuristics (fast, no tokenizer dependency).
 * Conservative estimate: characters / 3.5 for English text, / 2.5 for code.
 * In practice, most models tokenize ~4 chars/token for English, ~3 for code.
 * We use the conservative bound to avoid underestimating and missing compression opportunities.
 *
 * @module tokens
 * @packageDocumentation
 */

/**
 * Estimate token count for general text using conservative heuristic.
 *
 * Characters / 3.5 — slightly more pessimistic than the typical ~4 chars/token
 * for English text. This ensures we're more likely to compress than to miss
 * opportunities due to underestimation.
 *
 * @param text - Text to estimate tokens for
 * @returns Estimated token count (rounded up)
 *
 * @example
 * ```typescript
 * estimateTokens("hello world"); // → 4
 * estimateTokens(longBuildOutput); // → 12000
 * ```
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 3.5);
}

/**
 * Estimate token count for source code using code-specific heuristic.
 *
 * Code uses more punctuation and shorter identifiers than prose,
 * so the ratio is lower (~2.5 chars/token vs ~3.5 for prose).
 *
 * @param text - Source code to estimate tokens for
 * @returns Estimated token count (rounded up)
 */
export function estimateTokensCode(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 2.5);
}

/**
 * Format token count for human-readable display.
 *
 * @param n - Token count
 * @returns "1.2k" for 1200, "45" for 45
 *
 * @example
 * ```typescript
 * formatTokens(1234); // → "1.2k"
 * formatTokens(45);   // → "45"
 * ```
 */
export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	return `${(n / 1000).toFixed(1)}k`;
}

/**
 * Calculate token savings percentage.
 *
 * @param original - Original token count before compression
 * @param compressed - Token count after compression
 * @returns Integer percentage (0-100)
 *
 * @example
 * ```typescript
 * savingsPercent(10000, 2500); // → 75
 * savingsPercent(0, 0);        // → 0
 * ```
 */
export function savingsPercent(original: number, compressed: number): number {
	if (original === 0) return 0;
	return Math.round(((original - compressed) / original) * 100);
}

/**
 * Token estimation utilities.
 *
 * Uses character-based heuristics (fast, no tokenizer dependency).
 * Conservative estimate: characters / 3.5 for English text, / 2.5 for code.
 * In practice, most models tokenize ~4 chars/token for English, ~3 for code.
 * We use the conservative bound to avoid underestimating and missing compression opportunities.
 */

export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 3.5);
}

export function estimateTokensCode(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 2.5);
}

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	return `${(n / 1000).toFixed(1)}k`;
}

export function savingsPercent(original: number, compressed: number): number {
	if (original === 0) return 0;
	return Math.round(((original - compressed) / original) * 100);
}

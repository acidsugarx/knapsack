/**
 * Compression thresholds — minimum token counts before compression kicks in.
 *
 * Below these thresholds, the overhead of compression (both CPU and the
 * added "📦" metadata in the output) outweighs the token savings.
 *
 * Thresholds are conservative: we'd rather leave small outputs untouched
 * than risk hiding information the model needs.
 */
export const THRESHOLDS: Record<string, { minTokens: number }> = {
	bash: { minTokens: 1500 },
	read: { minTokens: 2000 },
	grep: { minTokens: 1000 },
	find: { minTokens: 500 },
};

/**
 * Content type routing — maps tool names to compression strategies.
 *
 * Each tool name maps to the appropriate compression strategy.
 * Tools not listed here pass through uncompressed.
 */
export const TOOL_STRATEGY: Record<string, string> = {
	bash: "bash",
	grep: "grep",
	find: "find",
};

/**
 * Check if a tool output should be compressed based on token count.
 *
 * @param toolName - Name of the tool that produced the output
 * @param tokenCount - Estimated token count of the output
 * @returns true if compression should be applied
 */
export function shouldCompress(toolName: string, tokenCount: number): boolean {
	const threshold = THRESHOLDS[toolName];
	if (!threshold) return false;
	return tokenCount >= threshold.minTokens;
}

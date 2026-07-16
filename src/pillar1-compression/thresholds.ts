/**
 * Compression thresholds — minimum token counts before compression kicks in.
 *
 * Below these thresholds, the overhead of compression (both CPU and the
 * added "📦" metadata in the output) outweighs the token savings.
 *
 * Thresholds are conservative: we'd rather leave small outputs untouched
 * than risk hiding information the model needs.
 */
/**
 * Compression thresholds — minimum token counts before compression kicks in.
 *
 * Below these thresholds, the overhead of compression (both CPU and the
 * added "📦" metadata in the output) outweighs the token savings.
 *
 * Thresholds are conservative: we'd rather leave small outputs untouched
 * than risk hiding information the model needs.
 *
 * To add custom tool thresholds, use KNAPSACK_THRESHOLDS env var:
 *   KNAPSACK_THRESHOLDS=ffgrep:1000,my_tool:500
 */
export const THRESHOLDS: Record<string, { minTokens: number }> = {
	bash: { minTokens: 1500 },
	read: { minTokens: 2000 },
	grep: { minTokens: 1000 },
	ffgrep: { minTokens: 1000 },
	find: { minTokens: 500 },
	fffind: { minTokens: 500 },
};

/**
 * Content type routing — maps tool names to compression strategies.
 *
 * Each tool name maps to the appropriate compression strategy.
 * Tools not listed here pass through uncompressed.
 *
 * To add custom tool mappings, use KNAPSACK_TOOL_MAP env var:
 *   KNAPSACK_TOOL_MAP=ffgrep=grep,fffind=find,my_tool=text
 */
export const TOOL_STRATEGY: Record<string, string> = {
	bash: "bash",
	grep: "grep",
	ffgrep: "grep",
	find: "find",
	fffind: "find",
};

/**
 * Check if a tool output should be compressed based on token count.
 *
 * Supports KNAPSACK_TOOL_MAP and KNAPSACK_THRESHOLDS env vars for custom tools.
 *
 * @param toolName - Name of the tool that produced the output
 * @param tokenCount - Estimated token count of the output
 * @returns true if compression should be applied
 */
export function shouldCompress(toolName: string, tokenCount: number): boolean {
	const threshold = getThreshold(toolName);
	if (!threshold) return false;
	return tokenCount >= threshold.minTokens;
}

/**
 * Get the compression strategy for a tool, including custom mappings.
 *
 * Resolution order:
 * 1. Built-in TOOL_STRATEGY mapping
 * 2. KNAPSACK_TOOL_MAP env var (format: tool=strategy,tool2=strategy)
 * 3. undefined — pass through uncompressed
 *
 * @param toolName - Name of the tool
 * @returns Strategy name or undefined
 */
export function getStrategy(toolName: string): string | undefined {
	// Built-in mapping
	if (TOOL_STRATEGY[toolName]) return TOOL_STRATEGY[toolName];

	// Custom env var mapping: KNAPSACK_TOOL_MAP=ffgrep=grep,customtool=text
	const customMap = parseEnvMap(process.env.KNAPSACK_TOOL_MAP);
	if (customMap[toolName]) return customMap[toolName];

	return undefined;
}

/**
 * Get the threshold for a tool, including custom thresholds.
 */
function getThreshold(toolName: string): { minTokens: number } | undefined {
	if (THRESHOLDS[toolName]) return THRESHOLDS[toolName];

	// Custom env var: KNAPSACK_THRESHOLDS=customtool:1000,other:500
	const customThresholds = parseEnvThresholds(process.env.KNAPSACK_THRESHOLDS);
	if (customThresholds[toolName]) return { minTokens: customThresholds[toolName]! };

	return undefined;
}

/**
 * Parse KNAPSACK_TOOL_MAP env var: "ffgrep=grep,my_tool=text"
 */
function parseEnvMap(env: string | undefined): Record<string, string> {
	if (!env) return {};
	const map: Record<string, string> = {};
	for (const pair of env.split(",")) {
		const [tool, strategy] = pair.split("=");
		if (tool?.trim() && strategy?.trim()) {
			map[tool.trim()] = strategy.trim();
		}
	}
	return map;
}

/**
 * Parse KNAPSACK_THRESHOLDS env var: "customtool:1000,other:500"
 */
function parseEnvThresholds(env: string | undefined): Record<string, number> {
	if (!env) return {};
	const map: Record<string, number> = {};
	for (const pair of env.split(",")) {
		const [tool, threshold] = pair.split(":");
		if (tool?.trim() && threshold?.trim()) {
			const n = parseInt(threshold.trim(), 10);
			if (!Number.isNaN(n)) map[tool.trim()] = n;
		}
	}
	return map;
}

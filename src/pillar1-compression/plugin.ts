/**
 * Knapsack compression strategy plugin interface.
 *
 * ## Extension architecture
 *
 * Knapsack strategies follow a plugin pattern inspired by ESLint rules,
 * Webpack loaders, and Babel plugins. Each strategy:
 *
 * 1. Implements the {@link CompressionStrategy} interface
 * 2. Registers itself via `registerStrategy()`
 * 3. Optionally provides a content detector for auto-routing
 *
 * Third-party packages can add strategies by installing as a pi dependency
 * and calling `registerStrategy()` in an extension.
 *
 * ## Interfaces
 *
 * | Interface | Purpose |
 * |-----------|---------|
 * | `CompressionStrategy` | A named compression algorithm |
 * | `ContentDetector` | Auto-detect if output matches this strategy |
 * | `StrategyRegistry` | Manages registered strategies and routing |
 *
 * @module plugin-architecture
 * @packageDocumentation
 */

import { estimateTokens } from "../core/tokens";
import type { CompressionResult } from "../core/types";

// ── Strategy interface ──────────────────────────────────

/**
 * A compression strategy that transforms tool output.
 *
 * Each strategy handles one content type (bash, code, grep, json, etc.).
 * Strategies are stateless — the same function is called for every output.
 *
 * @example
 * ```typescript
 * const bashStrategy: CompressionStrategy = {
 *   name: "bash",
 *   label: "Bash Output",
 *   contentTypes: ["bash"],
 *   threshold: 1500,
 *   compress(output) {
 *     return compressBash(output);
 *   },
 * };
 *
 * registry.register(bashStrategy);
 * ```
 */
export interface CompressionStrategy {
	/** Unique identifier — used for routing and stats */
	name: string;
	/** Human-readable label for debugging and stats */
	label: string;
	/** Content types this strategy handles (for auto-routing) */
	contentTypes: string[];
	/** Minimum token count before this strategy activates */
	threshold: number;
	/**
	 * Compress tool output.
	 *
	 * @param output - Raw tool output text
	 * @param context - Optional metadata about the output (tool name, etc.)
	 * @returns Compression result or null if output should pass through
	 */
	compress(output: string, context?: CompressionContext): CompressionResult | null;
}

/**
 * Metadata passed to compression strategies for context-aware decisions.
 */
export interface CompressionContext {
	/** Name of the tool that produced this output */
	toolName?: string;
	/** Language hint for code compression (e.g., "typescript", "python") */
	language?: string;
	/** Exit code for bash output */
	exitCode?: number;
}

// ── Content detector interface ──────────────────────────

/**
 * Auto-detects content type from output structure.
 *
 * Used for content-based routing: when a strategy registers a detector,
 * the registry calls it before falling back to tool-name mapping.
 *
 * @example
 * ```typescript
 * const grepDetector: ContentDetector = {
 *   name: "grep",
 *   detect(output) {
 *     // Check if first lines match file:line:content pattern
 *     return output.split("\n").filter(l => /^.+?:\d+:/.test(l)).length > 5;
 *   },
 * };
 * ```
 */
export interface ContentDetector {
	/** Strategy name this detector maps to */
	name: string;
	/**
	 * Check if the output matches this content type.
	 *
	 * @param output - First 5000 chars of tool output
	 * @returns true if this detector claims the output
	 */
	detect(output: string): boolean;
}

// ── Strategy registry ───────────────────────────────────

/**
 * Central registry of all compression strategies.
 *
 * The hook calls `registry.compress(output, toolName)` which:
 * 1. Tries content detectors (auto-routing)
 * 2. Falls back to tool-name mapping
 * 3. Returns compressed result or null (pass through)
 */
export interface StrategyRegistry {
	/** Register a compression strategy */
	register(strategy: CompressionStrategy): void;
	/** Register a content detector for auto-routing */
	registerDetector(detector: ContentDetector): void;
	/** Get a strategy by name */
	get(name: string): CompressionStrategy | undefined;
	/** List all registered strategy names */
	list(): string[];
	/**
	 * Compress output using the best matching strategy.
	 * Returns null if no strategy applies or output is below threshold.
	 */
	compress(output: string, toolName?: string): CompressionResult | null;
}

// ── Factory ─────────────────────────────────────────────

/**
 * Create a new strategy registry.
 *
 * The registry is the single source of truth for compression routing.
 * Strategies and detectors are registered during extension load,
 * and the hook calls `registry.compress()` for each tool result.
 *
 * @returns An empty StrategyRegistry
 */
export function createRegistry(): StrategyRegistry {
	const strategies = new Map<string, CompressionStrategy>();
	const detectors: ContentDetector[] = [];
	const toolMapping = new Map<string, string>();

	const registry: StrategyRegistry = {
		register(strategy) {
			strategies.set(strategy.name, strategy);
			// Auto-populate tool mapping from contentTypes
			for (const ct of strategy.contentTypes) {
				if (!toolMapping.has(ct)) {
					toolMapping.set(ct, strategy.name);
				}
			}
		},

		registerDetector(detector) {
			detectors.push(detector);
		},

		get(name) {
			return strategies.get(name);
		},

		list() {
			return Array.from(strategies.keys());
		},

		compress(output, toolName) {
			if (!output.trim()) return null;

			const outputTokens = estimateTokens(output);

			// 1. Try content detectors (auto-routing)
			for (const detector of detectors) {
				if (detector.detect(output)) {
					const strategy = strategies.get(detector.name);
					if (strategy && outputTokens >= strategy.threshold) {
						const result = strategy.compress(output, { toolName });
						if (result && result.savingsPercent > 0) return result;
					}
				}
			}

			// 2. Fall back to tool-name mapping
			const strategyName = toolName ? toolMapping.get(toolName) : undefined;
			if (strategyName) {
				const strategy = strategies.get(strategyName);
				if (strategy && outputTokens >= strategy.threshold) {
					const result = strategy.compress(output, { toolName });
					if (result && result.savingsPercent > 0) return result;
				}
			}

			return null;
		},
	};

	return registry;
}

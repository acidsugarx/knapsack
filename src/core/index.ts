/**
 * @knapsack/core — agent-agnostic core logic for token reduction and persistent memory.
 *
 * This barrel exports all pure-core modules that have zero dependencies on
 * any specific coding agent's API. Adapters (Pi, Claude Code, OpenCode, MCP)
 * import from here and wire agent-specific hooks to these functions.
 *
 * @module knapsack-core
 * @packageDocumentation
 */

// ── Obsidian bridge ──────────────────────────────────────
export {
	discoverVault,
	formatVaultHits,
	searchVault,
	searchVaultWithFrontmatter,
} from "../bridge/obsidian";
export { writeNote } from "../bridge/obsidian-notes";
// ── CCR (Compress-Cache-Retrieve) ────────────────────────
export { cache, retrieve } from "../pillar1-compression/ccr";
// ── Compression strategies ───────────────────────────────
export { createDefaultRegistry } from "../pillar1-compression/default-registry";
// ── Content detection ────────────────────────────────────
export { detectContentType } from "../pillar1-compression/detect";
// ── Image redaction ──────────────────────────────────────
export { type ImageRedactionResult, redactImages } from "../pillar1-compression/image";
// ── Output cache ─────────────────────────────────────────
export {
	type CachedCompression,
	OutputCache,
	type OutputCacheStats,
	outputCache,
} from "../pillar1-compression/output-cache";
export {
	type CompressionContext,
	type CompressionStrategy,
	createRegistry,
	type StrategyRegistry,
} from "../pillar1-compression/plugin";

// ── Tag protector ────────────────────────────────────────
export { hasProtectedTags, protectTags, restoreTags } from "../pillar1-compression/tag-protector";
// ── Drift detection ──────────────────────────────────────
export { checkDrift, formatDriftReport } from "../pillar2-memory/drift";
// ── System prompt ────────────────────────────────────────
export { knapsackPromptGuidance } from "../system-prompt";
// ── Database ─────────────────────────────────────────────
export { createDB, type KnapsackDB } from "./database";
// ── Hashing ──────────────────────────────────────────────
export { sha256, sha256Full } from "./hash";
// ── Memory ───────────────────────────────────────────────
export { extractSearchTerms, formatMemoryBlock, injectMemory } from "./memory";
// ── Compression pipeline ─────────────────────────────────
export { type CompressParams, type CompressResult, compress, type TextBlock } from "./pipeline";
// ── Project root ─────────────────────────────────────────
export { getProjectRoot } from "./project";
// ── Security ─────────────────────────────────────────────
export { detectSecrets, redactSecrets } from "./security";
// ── Token estimation ─────────────────────────────────────
export { estimateTokens, estimateTokensCode, formatTokens, savingsPercent } from "./tokens";
// ── Types ────────────────────────────────────────────────
/** Re-exported types for adapter authors. See individual modules for detailed docs. */
export type {
	CompressionResult,
	KnapsackStore,
	MemoryEntry,
	MemoryScopeValue,
	MemoryTypeValue,
} from "./types";

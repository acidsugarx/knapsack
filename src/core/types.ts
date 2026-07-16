/**
 * Knapsack — TypeBox schemas, TypeScript interfaces, and shared types.
 *
 * ## Naming conventions
 *
 * - `XxxParams` — TypeBox schema for tool parameters (validated at runtime)
 * - `XxxValue` — string literal union type (e.g., MemoryTypeValue)
 * - `XxxEntry` — database row interface (matches SQLite schema)
 *
 * @module types
 * @packageDocumentation
 */

import { Type } from "typebox";

// ── Memory types ──────────────────────────────────────

/** TypeBox schema for memory entry type validation */
export const MemoryType = Type.Union([
	Type.Literal("decision"),
	Type.Literal("fact"),
	Type.Literal("gotcha"),
	Type.Literal("convention"),
	Type.Literal("preference"),
	Type.Literal("command"),
	Type.Literal("constraint"),
	Type.Literal("hypothesis"),
]);

/** TypeBox schema for memory scope validation */
export const MemoryScope = Type.Union([
	Type.Literal("global"),
	Type.Literal("project"),
	Type.Literal("session"),
]);

/**
 * A memory entry as stored in SQLite.
 *
 * All entries are content-addressable via `contentHash` — saving the same
 * content + type twice is an UPSERT, not a duplicate.
 */
export interface MemoryEntry {
	id: string;
	content: string;
	type: MemoryTypeValue;
	scope: MemoryScopeValue;
	project: string | null;
	importance: number;
	recency: number;
	createdAt: string;
	updatedAt: string;
	contentHash: string;
	sourceSession: string | null;
	accessCount: number;
	lastAccessed: string | null;
}

/**
 * Memory type categories.
 *
 * | Type       | Use case                                      | Example |
 * |------------|-----------------------------------------------|---------|
 * | decision   | Architectural choices, tradeoffs              | "Use SQLite, not PostgreSQL" |
 * | fact       | Objective information, file locations         | "The API key lives in .env.local" |
 * | gotcha     | Pitfalls, bugs, things that don't work        | "Don't import from X — circular dep" |
 * | convention | Team/project standards                        | "All commits use conventional commits" |
 * | preference | User preferences, workflow choices            | "Show diffs before writing files" |
 * | command    | Useful commands and how to run them           | "Build: `uv run build`" |
 * | constraint | Hard constraints that must be respected       | "Never commit .env files" |
 * | hypothesis | Working theories to validate                  | "If we replace Redis, latency may drop" |
 */
export type MemoryTypeValue =
	| "decision"
	| "fact"
	| "gotcha"
	| "convention"
	| "preference"
	| "command"
	| "constraint"
	| "hypothesis";

/** Memory scope levels */
export type MemoryScopeValue = "global" | "project" | "session";

// ── Compression types ─────────────────────────────────

/** A compression record as stored in SQLite */
export interface CompressionEntry {
	id: string;
	toolName: string;
	originalHash: string;
	originalTokens: number;
	compressedTokens: number;
	savingsPercent: number;
	strategy: string;
	obsidianNote: string | null;
	createdAt: string;
	sessionId: string | null;
}

/** Result of a compression operation — passed back to the hook */
export interface CompressionResult {
	body: string;
	hash: string;
	originalTokens: number;
	compressedTokens: number;
	savingsPercent: number;
	strategy: string;
}

/** A named section in compressed output (e.g., "ERRORS", "WARNINGS") */
export interface CompressedSection {
	title: string;
	content: string | null;
}

// ── Tool parameter schemas ────────────────────────────

/** Parameters for knapsack_retrieve — recover original from CCR cache */
export const KnapsackRetrieveParams = Type.Object({
	hash: Type.String({ description: "Hash key from a previous compression" }),
});

/** Parameters for knapsack_search — keyword search across memory */
export const KnapsackSearchParams = Type.Object({
	query: Type.String({ description: "Search query for memory" }),
	limit: Type.Optional(Type.Number({ default: 10, description: "Max results (default: 10)" })),
	type: Type.Optional(Type.Array(Type.String(), { description: "Filter by memory type" })),
});

/** Parameters for knapsack_save — persist a fact/decision/gotcha */
export const KnapsackSaveParams = Type.Object({
	content: Type.String({ description: "What to remember" }),
	type: Type.String({
		description:
			"Memory type: decision, fact, gotcha, convention, preference, command, constraint, hypothesis",
	}),
	importance: Type.Optional(
		Type.Number({
			default: 0.5,
			minimum: 0,
			maximum: 1,
			description: "Importance 0..1 (default: 0.5)",
		}),
	),
	scope: Type.Optional(
		Type.String({
			default: "project",
			description: "Scope: global, project, or session",
		}),
	),
});

/** Parameters for knapsack_forget — delete a memory entry */
export const KnapsackForgetParams = Type.Object({
	id: Type.String({ description: "Memory entry ID to delete" }),
});

/** Parameters for knapsack_obsidian — search Obsidian vault */
export const KnapsackGrepParams = Type.Object({
	query: Type.String({ description: "Search query for Obsidian vault" }),
	limit: Type.Optional(Type.Number({ default: 10, description: "Max results" })),
});

// ── Knapsack state ─────────────────────────────────────

/**
 * Runtime store — holds session-scoped state shared across hooks.
 * Created on session_start, destroyed on session_shutdown.
 */
export interface KnapsackStore {
	/** Path to the SQLite database file */
	dbPath: string;
	/** Git root of the current project, or null if not in a repo */
	projectRoot: string | null;
	/** Pi session ID for scoping session-level memory */
	sessionId: string | null;
	/** Path to the Obsidian vault, or null if unavailable */
	vaultPath: string | null;
}

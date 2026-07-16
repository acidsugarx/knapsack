import { Type } from "typebox";

// ── Memory types ──────────────────────────────────────

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

export const MemoryScope = Type.Union([
	Type.Literal("global"),
	Type.Literal("project"),
	Type.Literal("session"),
]);

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

export type MemoryTypeValue =
	| "decision"
	| "fact"
	| "gotcha"
	| "convention"
	| "preference"
	| "command"
	| "constraint"
	| "hypothesis";

export type MemoryScopeValue = "global" | "project" | "session";

// ── Compression types ─────────────────────────────────

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

export interface CompressionResult {
	body: string;
	hash: string;
	originalTokens: number;
	compressedTokens: number;
	savingsPercent: number;
	strategy: string;
}

export interface CompressedSection {
	title: string;
	content: string | null;
}

// ── Tool parameter schemas ────────────────────────────

export const KnapsackRetrieveParams = Type.Object({
	hash: Type.String({ description: "Hash key from a previous compression" }),
});

export const KnapsackSearchParams = Type.Object({
	query: Type.String({ description: "Search query for memory" }),
	limit: Type.Optional(Type.Number({ default: 10, description: "Max results (default: 10)" })),
	type: Type.Optional(Type.Array(Type.String(), { description: "Filter by memory type" })),
});

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

export const KnapsackForgetParams = Type.Object({
	id: Type.String({ description: "Memory entry ID to delete" }),
});

export const KnapsackGrepParams = Type.Object({
	query: Type.String({ description: "Search query for Obsidian vault" }),
	limit: Type.Optional(Type.Number({ default: 10, description: "Max results" })),
});

// ── Knapsack state ─────────────────────────────────────

export interface KnapsackStore {
	dbPath: string;
	projectRoot: string | null;
	sessionId: string | null;
	vaultPath: string | null;
}

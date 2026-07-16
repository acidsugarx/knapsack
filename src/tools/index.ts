/**
 * Tool registration — registers Knapsack's custom tools with Pi.
 *
 * All tools are registered during extension load and are immediately
 * available to the LLM via the usual tool-calling mechanism.
 *
 * Tools follow the Pi custom tool contract:
 * - `name`: snake_case identifier
 * - `description`: tells the LLM when to use this tool
 * - `parameters`: TypeBox schema for validation
 * - `execute`: async function returning `{ content, details }`
 * - `promptSnippet`: one-line description for the system prompt tool list
 * - `promptGuidelines`: bullets appended to the Guidelines section
 *
 * @module tools
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { searchVault } from "../bridge/obsidian";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore } from "../core/types";
import { retrieve } from "../pillar1-compression/ccr";

/**
 * Register all Knapsack tools with Pi.
 *
 * Uses lazy accessor functions for db and store so tools are always
 * working with the current session's database handle.
 *
 * @param pi - Pi ExtensionAPI
 * @param getDB - Lazy accessor for the current database handle
 * @param getStore - Lazy accessor for the current runtime store
 */
export function registerTools(
	pi: ExtensionAPI,
	getDB: () => KnapsackDB | null,
	getStore: () => KnapsackStore | null,
): void {
	// ── knapsack_retrieve ──────────────────────────────────
	pi.registerTool({
		name: "knapsack_retrieve",
		label: "Knapsack Retrieve",
		description:
			"Retrieve the full original output of a previously compressed tool result. " +
			"Use this when you need more detail than the compressed version provides. " +
			"The hash comes from the compression footer in the tool output.",
		promptSnippet: "Retrieve full original of a compressed tool output by its hash",
		promptGuidelines: [
			"Call knapsack_retrieve when the compressed output doesn't have enough detail to make a decision. " +
				"The hash is shown in the compression footer of any compressed tool output.",
		],
		parameters: Type.Object({
			hash: Type.String({
				description: "Content hash from the compression footer (e.g., a1b2c3d4e5f6)",
			}),
		}),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		async execute(_toolCallId, params): Promise<any> {
			const store = getStore();
			if (!store) {
				return {
					content: [
						{ type: "text" as const, text: "Knapsack is not initialized. Start a session first." },
					],
					details: {},
				};
			}

			const original = retrieve(store.vaultPath, params.hash);
			if (!original) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No cached original found for hash "${params.hash}". The cache may have expired or the hash is incorrect.`,
						},
					],
					details: { hash: params.hash, found: false },
				};
			}

			return {
				content: [{ type: "text" as const, text: original }],
				details: {
					hash: params.hash,
					found: true,
					size: original.length,
				},
			};
		},
	});

	// ── knapsack_search ────────────────────────────────────
	pi.registerTool({
		name: "knapsack_search",
		label: "Knapsack Search",
		description:
			"Search Knapsack's persistent memory using FTS5 keyword search. " +
			"Matches by exact keywords in saved facts, decisions, gotchas, conventions, and preferences. " +
			"Use short, specific terms for best results. Semantic/embedding search is planned for v0.2.",
		promptSnippet: "Keyword-search persistent memory (FTS5 — use short specific terms)",
		promptGuidelines: [
			"Call knapsack_search at the start of a new task to check for relevant memories. " +
				"Search for the topic, technology, file name, or error message you're working with.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "What to search for (topic, technology, error message, etc.)",
			}),
			limit: Type.Optional(Type.Number({ default: 10, description: "Max results (default: 10)" })),
			type: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Filter by memory type: decision, fact, gotcha, convention, preference, command, constraint, hypothesis",
				}),
			),
		}),
		async execute(_toolCallId, params): Promise<any> {
			const db = getDB();
			if (!db) {
				return {
					content: [{ type: "text" as const, text: "Knapsack is not initialized." }],
					details: {},
				};
			}

			const results = db.searchMemory(params.query, params.limit ?? 10, params.type);

			if (results.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No memories found for "${params.query}".`,
						},
					],
					details: { query: params.query, results: 0 },
				};
			}

			const emoji: Record<string, string> = {
				decision: "🔒",
				fact: "📋",
				gotcha: "⚠️",
				convention: "📐",
				preference: "💭",
				command: "⚡",
				constraint: "🚫",
				hypothesis: "🧪",
			};

			const lines = results.map(
				(r) => `${emoji[r.type] ?? "📌"} **[${r.type}]** ${r.content} \`(${r.id})\``,
			);

			return {
				content: [
					{
						type: "text" as const,
						text: `Found ${results.length} memories:\n\n${lines.join("\n")}`,
					},
				],
				details: { query: params.query, results: results.length },
			};
		},
	});

	// ── knapsack_save ──────────────────────────────────────
	pi.registerTool({
		name: "knapsack_save",
		label: "Knapsack Save",
		description:
			"Save a fact, decision, gotcha, convention, or preference to Knapsack's persistent memory. " +
			"This memory will be available in future sessions. Use after making important decisions, " +
			"discovering gotchas, or when the user tells you to remember something.",
		promptSnippet: "Save a fact, decision, gotcha, or preference to persistent memory",
		promptGuidelines: [
			"Call knapsack_save after making an important decision, discovering a gotcha, or when the user says 'remember this'. " +
				"Choose the right type: decision for architectural choices, gotcha for pitfalls, convention for team standards, " +
				"preference for user preferences, fact for objective information.",
		],
		parameters: Type.Object({
			content: Type.String({ description: "What to remember (be specific and concise)" }),
			type: Type.String({
				description:
					"Memory type: decision, fact, gotcha, convention, preference, command, constraint, hypothesis",
			}),
			importance: Type.Optional(
				Type.Number({
					default: 0.5,
					minimum: 0,
					maximum: 1,
					description: "How important is this? 0.0 = trivial, 1.0 = critical (default: 0.5)",
				}),
			),
			scope: Type.Optional(
				Type.String({
					default: "project",
					description:
						"Scope: 'project' (this project only), 'global' (all projects), or 'session'",
				}),
			),
		}),
		async execute(_toolCallId, params): Promise<any> {
			const db = getDB();
			const store = getStore();
			if (!db || !store) {
				return {
					content: [{ type: "text" as const, text: "Knapsack is not initialized." }],
					details: {},
				};
			}

			const validTypes = [
				"decision",
				"fact",
				"gotcha",
				"convention",
				"preference",
				"command",
				"constraint",
				"hypothesis",
			];

			if (!validTypes.includes(params.type)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Invalid type "${params.type}". Must be one of: ${validTypes.join(", ")}`,
						},
					],
					details: {},
				};
			}

			const entry = db.saveMemory({
				content: params.content,
				type: params.type as
					| "decision"
					| "fact"
					| "gotcha"
					| "convention"
					| "preference"
					| "command"
					| "constraint"
					| "hypothesis",
				scope: (params.scope as "global" | "project" | "session") ?? "project",
				importance: params.importance ?? 0.5,
				project: store.projectRoot ?? undefined,
				sourceSession: store.sessionId ?? undefined,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `✅ Saved: [${entry.type}] ${entry.content}\n\`id: ${entry.id}\``,
					},
				],
				details: { id: entry.id, type: entry.type },
			};
		},
	});

	// ── knapsack_stats ─────────────────────────────────────
	pi.registerTool({
		name: "knapsack_stats",
		label: "Knapsack Stats",
		description:
			"Show Knapsack compression and memory statistics — tokens saved, compressions performed, memory entries stored.",
		promptSnippet: "Show compression and memory statistics",
		promptGuidelines: [
			"Call knapsack_stats when the user asks about token savings, compression stats, or memory usage.",
		],
		parameters: Type.Object({}),
		async execute(): Promise<any> {
			const db = getDB();
			const store = getStore();
			if (!db || !store) {
				return {
					content: [{ type: "text" as const, text: "Knapsack is not initialized." }],
					details: {},
				};
			}

			const sessionStats = db.getSessionCompressionStats(store.sessionId ?? "");
			const allTime = db.getAllTimeStats();

			const lines = [
				"## 🎒 Knapsack Stats",
				"",
				"### This session",
				`Compressions: ${sessionStats.count}`,
				`Tokens saved: ${sessionStats.totalOriginalTokens - sessionStats.totalCompressedTokens} (${sessionStats.totalSavingsPercent}%)`,
				"",
				"### All-time",
				`Compressions: ${allTime.compressionCount}`,
				`Memory entries: ${allTime.memoryCount}`,
				`Total tokens saved: ${allTime.totalOriginalTokens - allTime.totalCompressedTokens} (${allTime.totalSavingsPercent}%)`,
				store.vaultPath ? `\nObsidian vault: ${store.vaultPath}` : "",
			];

			return {
				content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }],
				details: { session: sessionStats, allTime },
			};
		},
	});

	// ── knapsack_forget ────────────────────────────────────
	pi.registerTool({
		name: "knapsack_forget",
		label: "Knapsack Forget",
		description: "Delete a memory entry by its ID. Use when a memory is outdated or incorrect.",
		promptSnippet: "Delete a memory entry by ID",
		promptGuidelines: [
			"Call knapsack_forget when a previously saved memory is no longer relevant or was incorrect.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Memory entry ID to delete" }),
		}),
		async execute(_toolCallId, params): Promise<any> {
			const db = getDB();
			if (!db) {
				return {
					content: [{ type: "text" as const, text: "Knapsack is not initialized." }],
					details: {},
				};
			}

			const deleted = db.deleteMemory(params.id);
			return {
				content: [
					{
						type: "text" as const,
						text: deleted ? `✅ Deleted memory ${params.id}` : `❌ Memory ${params.id} not found`,
					},
				],
				details: { id: params.id, deleted },
			};
		},
	});

	// ── knapsack_obsidian ──────────────────────────────────
	pi.registerTool({
		name: "knapsack_obsidian",
		label: "Knapsack Obsidian",
		description:
			"Search across your Obsidian vault for relevant notes. " +
			"Use this to tap into your personal knowledge base — notes, research, " +
			"decisions, and documentation stored in Obsidian.",
		promptSnippet: "Search Obsidian vault for relevant notes",
		promptGuidelines: [
			"Call knapsack_obsidian to search your Obsidian knowledge base for relevant information " +
				"before making decisions. This connects your agent to your second brain.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query for Obsidian vault" }),
			limit: Type.Optional(Type.Number({ default: 20, description: "Max results (default: 20)" })),
		}),
		async execute(_toolCallId, params): Promise<any> {
			const store = getStore();
			if (!store?.vaultPath) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No Obsidian vault found. Make sure Obsidian is installed and has at least one vault configured.",
						},
					],
					details: {},
				};
			}

			const results = searchVault(store.vaultPath, params.query, params.limit ?? 20);

			if (!results || results.length === 0) {
				// Count total markdown files in vault for context
				let vaultFileCount = 0;
				try {
					const { execSync } = await import("node:child_process");
					const count = execSync(`find "${store.vaultPath}" -name "*.md" 2>/dev/null | wc -l`, {
						encoding: "utf-8",
						timeout: 3000,
					}).trim();
					vaultFileCount = parseInt(count, 10) || 0;
				} catch {
					// Can't count — skip
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `No results for "${params.query}" in Obsidian vault (searched ${vaultFileCount || "?"} markdown files). Try different keywords or check vault path.`,
						},
					],
					details: { query: params.query, results: 0, vaultFiles: vaultFileCount },
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Found ${results.length} notes in Obsidian:\n\n${results.slice(0, 20).join("\n")}`,
					},
				],
				details: { query: params.query, results: results.length },
			};
		},
	});

	// ── knapsack_note ─────────────────────────────────────
	pi.registerTool({
		name: "knapsack_note",
		label: "Knapsack Note",
		description:
			"Write or append to an Obsidian note. Notes live in vault root, no frontmatter. " +
			"Use [[wikilinks]] inline for connections. If note exists, content is appended.",
		promptSnippet: "Write or update a note in Obsidian vault",
		promptGuidelines: [
			"Use knapsack_note to save things you learn. " +
				"Write [[wikilinks]] inline to connect ideas. Keep notes atomic.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Note title (becomes filename)" }),
			content: Type.String({
				description: "Markdown content. Use [[wikilinks]] for connections.",
			}),
		}),
		async execute(_toolCallId, params): Promise<any> {
			const store = getStore();
			if (!store?.vaultPath) {
				return {
					content: [{ type: "text" as const, text: "No Obsidian vault found." }],
					details: {},
				};
			}

			const { writeNote } = await import("../bridge/obsidian-notes");
			const notePath = writeNote(store.vaultPath, params.title, params.content);

			return {
				content: [
					{
						type: "text" as const,
						text: notePath ? `✅ [[${notePath.replace(".md", "")}]]` : "Failed to write note.",
					},
				],
				details: { path: notePath },
			};
		},
	});
}

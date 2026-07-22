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

import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatVaultHits, searchVault, searchVaultWithFrontmatter } from "../bridge/obsidian";
import { writeNote } from "../bridge/obsidian-notes";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore } from "../core/types";
import { retrieve } from "../pillar1-compression/ccr";
import { checkDrift, formatDriftReport } from "../pillar2-memory/drift";
import { embed, isAvailable, serializeEmbedding } from "../pillar2-memory/embeddings";
import { scoreAndRank } from "../pillar2-memory/scoring";

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
			"Retrieve the full original of a previously compressed tool output, by its hash. " +
			"Call ONLY when the compressed output is missing information critical to your next step — " +
			"for summaries, counts, structure overviews, and listings the compressed output is sufficient. " +
			"Most tasks do not need this.",
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

			const original = retrieve(
				store.dbPath.replace("/memory.db", ""),
				store.vaultPath,
				params.hash,
			);
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
			"Search Knapsack's persistent memory using BM25 keyword scoring (token overlap + IDF). " +
			"Matches by shared terms - 'postgres pool' finds entries about Postgres connection pooling. " +
			"Results ranked by relevance × importance × recency.",
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
			const store = getStore();
			if (!db || !store) {
				return {
					content: [{ type: "text" as const, text: "Knapsack is not initialized." }],
					details: {},
				};
			}

			// Get candidates via FTS5/LIKE
			const candidates = db.searchMemory(
				params.query,
				20,
				params.type,
				store.projectRoot ?? undefined,
			);

			// Also search Obsidian vault if available
			let vaultResults: string[] = [];
			if (store.vaultPath) {
				vaultResults = searchVault(store.vaultPath, params.query, 5) ?? [];
			}

			if (candidates.length === 0 && vaultResults.length === 0) {
				return {
					content: [{ type: "text" as const, text: `No memories found for "${params.query}".` }],
					details: { query: params.query, results: 0 },
				};
			}

			// BM25 score and rank
			const allEntries = db.getAllMemories(store.projectRoot ?? undefined);
			const ranked = await scoreAndRank(params.query, candidates, allEntries, params.limit ?? 10);

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

			const lines = ranked.map(
				(r) =>
					`${emoji[r.entry.type] ?? "📌"} **[${r.entry.type}]** ${r.entry.content} \`(score:${r.score})\``,
			);

			if (vaultResults.length > 0) {
				lines.push("", "**Obsidian vault:**", ...vaultResults.slice(0, 5));
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Found ${ranked.length} memories + ${vaultResults.length} vault notes:\n\n${lines.join("\n")}`,
					},
				],
				details: {
					query: params.query,
					memoryResults: ranked.length,
					vaultResults: vaultResults.length,
				},
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

			// Generate embedding if available
			let embedding: string | null = null;
			try {
				if (isAvailable()) {
					const vec = await embed(params.content);
					if (vec) embedding = serializeEmbedding(vec);
				}
			} catch {
				// Embeddings not available — skip
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
				embedding,
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

			const hits = searchVaultWithFrontmatter(store.vaultPath, params.query, params.limit ?? 20);

			if (!hits || hits.length === 0) {
				// Count total markdown files in vault for context
				let vaultFileCount = 0;
				try {
					const count = execFileSync("find", [store.vaultPath, "-name", "*.md"], {
						encoding: "utf-8",
						timeout: 3000,
					})
						.trim()
						.split("\n")
						.filter(Boolean).length;
					vaultFileCount = count;
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
						text: `Found ${hits.length} notes in Obsidian:\n\n${formatVaultHits(hits)}`,
					},
				],
				details: { query: params.query, results: hits.length },
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

	// ── knapsack_anchor ──────────────────────────────────
	pi.registerTool({
		name: "knapsack_anchor",
		label: "Knapsack Anchor",
		description:
			"Declare a decision anchor with violation signals. Knapsack will monitor " +
			"future tool outputs and flag drift if the signals appear. " +
			"Example: statement='Use sql.js not better-sqlite3' signals=['better-sqlite3','node-gyp'].",
		parameters: Type.Object({
			statement: Type.String({
				description: "The decision statement (e.g., 'Use sql.js, not better-sqlite3')",
			}),
			signals: Type.Array(Type.String(), {
				description: "Keywords that indicate drift if found in code or output",
			}),
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

			const content = `[anchor] ${params.statement} | signals: ${params.signals.join(", ")}`;
			const entry = db.saveMemory({
				content,
				type: "constraint",
				scope: "project",
				project: store.projectRoot ?? undefined,
				importance: 0.9,
				sourceSession: store.sessionId ?? undefined,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `✅ Anchor declared: ${params.statement}\nMonitoring for: ${params.signals.join(", ")}`,
					},
				],
				details: { id: entry.id, signals: params.signals },
			};
		},
	});

	// ── knapsack_drift ────────────────────────────────────
	pi.registerTool({
		name: "knapsack_drift",
		label: "Knapsack Drift",
		description:
			"Check for decision drift — scans recent tool outputs for violation signals " +
			"from declared anchors. Returns list of anchors with matched signals.",
		parameters: Type.Object({
			content: Type.Optional(
				Type.String({
					description:
						"Optional text to scan for anchor violations. When omitted, the tool returns the current anchor list without scanning.",
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

			const detections = checkDrift(db, params.content ?? "", store.projectRoot ?? undefined);
			const report = formatDriftReport(detections);

			return {
				content: [{ type: "text" as const, text: report }],
				details: { driftCount: detections.length },
			};
		},
	});
}

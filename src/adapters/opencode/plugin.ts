/**
 * Knapsack OpenCode adapter — plugin for OpenCode's hook system.
 *
 * ## How it works
 *
 * OpenCode plugins are TypeScript modules that export a `Plugin` function
 * returning hooks. This plugin wires:
 *
 * - `tool.execute.after` → knapsack compression pipeline
 * - `experimental.chat.system.transform` → memory injection
 * - `experimental.session.compacting` → compaction hook
 * - `tool` → custom tools (search, save, retrieve, etc.)
 *
 * ## Installation
 *
 * Add to `opencode.json`:
 * ```json
 * {
 *   "plugin": {
 *     "knapsack": "npm:knapsack-pi"
 *   }
 * }
 * ```
 *
 * Or for local development:
 * ```json
 * {
 *   "plugin": {
 *     "knapsack": "./src/adapters/opencode/plugin.ts"
 *   }
 * }
 * ```
 *
 * @module knapsack-opencode-adapter
 */

import { mkdirSync } from "node:fs";
import { discoverVault, searchVault } from "../../bridge/obsidian";
import { writeNote } from "../../bridge/obsidian-notes";
import type { KnapsackDB } from "../../core/database";
import { createDB } from "../../core/database";
import { injectMemory } from "../../core/memory";
import { compress } from "../../core/pipeline";
import { getProjectRoot } from "../../core/project";
import { retrieve } from "../../pillar1-compression/ccr";
import { createDefaultRegistry } from "../../pillar1-compression/default-registry";
import { outputCache } from "../../pillar1-compression/output-cache";
import { checkDrift, formatDriftReport } from "../../pillar2-memory/drift";
import { initEmbeddings } from "../../pillar2-memory/embeddings";
import { scoreAndRank } from "../../pillar2-memory/scoring";
import { knapsackPromptGuidance } from "../../system-prompt";

let db: KnapsackDB | null = null;
let registry: ReturnType<typeof createDefaultRegistry> | null = null;
let store: {
	dbPath: string;
	projectRoot: string | null;
	sessionId: string | null;
	vaultPath: string | null;
} | null = null;

async function ensureInit(sessionID?: string): Promise<void> {
	if (db && registry && store) {
		if (sessionID) store.sessionId = sessionID;
		return;
	}

	const home = process.env.KNAPSACK_HOME ?? `${process.env.HOME ?? "~"}/.knapsack`;
	const dbPath = `${home}/memory.db`;
	mkdirSync(home, { recursive: true });

	db = await createDB(dbPath);
	await initEmbeddings();
	registry = createDefaultRegistry();
	store = {
		dbPath,
		projectRoot: getProjectRoot(process.cwd()),
		sessionId: sessionID ?? null,
		vaultPath: discoverVault(),
	};
}

/**
 * OpenCode plugin entry point — wires knapsack hooks to OpenCode's event system.
 *
 * @param _ctx - OpenCode plugin context (project, client, directory, etc.)
 * @returns Hooks object with tool.execute.after, system.transform, compacting, and custom tools
 */
export default async function knapsackOpenCodePlugin(_ctx: unknown) {
	return {
		"tool.execute.after": async (
			input: { tool: string; sessionID: string; callID: string; args: Record<string, unknown> },
			output: { title: string; output: string; metadata: unknown },
		) => {
			await ensureInit(input.sessionID);
			if (!db || !store || !registry) return;

			const result = await compress({
				text: output.output,
				toolName: input.tool,
				path: typeof input.args?.path === "string" ? input.args.path : undefined,
				db,
				store,
				registry,
			});

			if (result) {
				output.output = result.content.map((b) => b.text).join("");
			}
		},

		"experimental.chat.system.transform": async (
			_input: { sessionID?: string },
			output: { system: string[] },
		) => {
			await ensureInit(_input.sessionID);
			if (!db || !store) return;

			output.system.push(knapsackPromptGuidance());

			const memoryBlock = await injectMemory("", db, store);
			if (memoryBlock) {
				output.system.push(memoryBlock);
			}
		},

		"experimental.session.compacting": async (
			input: { sessionID: string },
			output: { context: string[]; prompt?: string },
		) => {
			await ensureInit(input.sessionID);
			if (!db || !store) return;

			const allTime = db.getAllTimeStats();
			output.context.push(
				`Knapsack: ${allTime.compressionCount} compressions, ${allTime.memoryCount} memories, ${allTime.totalSavingsPercent}% tokens saved.`,
			);
		},

		event: async (input: { event: { type: string; properties?: unknown } }) => {
			if (input.event.type === "session.created") {
				await ensureInit();
			}
		},

		tool: {
			knapsack_search: {
				description: "Search Knapsack's persistent memory and Obsidian vault",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "What to search for" },
						limit: { type: "number", description: "Max results (default: 10)" },
					},
					required: ["query"],
				},
				async execute(args: { query: string; limit?: number }) {
					await ensureInit();
					if (!db || !store) return "Knapsack not initialized.";
					const candidates = db.searchMemory(
						args.query,
						20,
						undefined,
						store.projectRoot ?? undefined,
					);
					let vaultResults: string[] = [];
					if (store.vaultPath) vaultResults = searchVault(store.vaultPath, args.query, 5) ?? [];
					if (candidates.length === 0 && vaultResults.length === 0)
						return `No memories found for "${args.query}".`;
					const allEntries = db.getAllMemories(store.projectRoot ?? undefined);
					const ranked = await scoreAndRank(args.query, candidates, allEntries, args.limit ?? 10);
					const lines = ranked.map(
						(r) => `[${r.entry.type}] ${r.entry.content} (score:${r.score})`,
					);
					if (vaultResults.length > 0)
						lines.push("", "Obsidian vault:", ...vaultResults.slice(0, 5));
					return `Found ${ranked.length} memories + ${vaultResults.length} vault notes:\n\n${lines.join("\n")}`;
				},
			},

			knapsack_save: {
				description: "Save a fact, decision, gotcha, or preference to persistent memory",
				parameters: {
					type: "object",
					properties: {
						content: { type: "string", description: "What to remember" },
						type: {
							type: "string",
							description:
								"decision, fact, gotcha, convention, preference, command, constraint, hypothesis",
						},
						importance: { type: "number", description: "0.0-1.0 (default: 0.5)" },
					},
					required: ["content", "type"],
				},
				async execute(args: { content: string; type: string; importance?: number }) {
					await ensureInit();
					if (!db || !store) return "Knapsack not initialized.";
					const entry = db.saveMemory({
						content: args.content,
						type: args.type as never,
						scope: "project",
						project: store.projectRoot ?? undefined,
						importance: args.importance ?? 0.5,
						sourceSession: store.sessionId ?? undefined,
					});
					return `✅ Saved: [${entry.type}] ${entry.content}\nid: ${entry.id}`;
				},
			},

			knapsack_retrieve: {
				description: "Retrieve the full original of a compressed tool output by hash",
				parameters: {
					type: "object",
					properties: {
						hash: { type: "string", description: "Content hash from compression footer" },
					},
					required: ["hash"],
				},
				async execute(args: { hash: string }) {
					await ensureInit();
					if (!store) return "Knapsack not initialized.";
					const original = retrieve(
						store.dbPath.replace("/memory.db", ""),
						store.vaultPath,
						args.hash,
					);
					return original ?? `No cached original found for hash "${args.hash}".`;
				},
			},

			knapsack_stats: {
				description: "Show Knapsack compression and memory statistics",
				parameters: { type: "object", properties: {} },
				async execute() {
					await ensureInit();
					if (!db || !store) return "Knapsack not initialized.";
					const allTime = db.getAllTimeStats();
					const cacheStats = outputCache.stats();
					return [
						`Compressions: ${allTime.compressionCount}`,
						`Memories: ${allTime.memoryCount}`,
						`Tokens saved: ${allTime.totalOriginalTokens - allTime.totalCompressedTokens} (${allTime.totalSavingsPercent}%)`,
						`Cache: ${cacheStats.hits} hits · ${cacheStats.misses} misses`,
						store.vaultPath ? `Vault: ${store.vaultPath}` : "",
					]
						.filter(Boolean)
						.join("\n");
				},
			},

			knapsack_drift: {
				description: "Check for decision drift against declared anchors",
				parameters: {
					type: "object",
					properties: {
						content: {
							type: "string",
							description: "Text to scan (optional — omit to list anchors)",
						},
					},
				},
				async execute(args: { content?: string }) {
					await ensureInit();
					if (!db || !store) return "Knapsack not initialized.";
					const detections = checkDrift(db, args.content ?? "", store.projectRoot ?? undefined);
					return formatDriftReport(detections);
				},
			},

			knapsack_note: {
				description: "Write or append to an Obsidian note",
				parameters: {
					type: "object",
					properties: {
						title: { type: "string", description: "Note title" },
						content: { type: "string", description: "Markdown content" },
					},
					required: ["title", "content"],
				},
				async execute(args: { title: string; content: string }) {
					await ensureInit();
					if (!store?.vaultPath) return "No Obsidian vault found.";
					const notePath = writeNote(store.vaultPath, args.title, args.content);
					return notePath ? `✅ [[${notePath.replace(".md", "")}]]` : "Failed to write note.";
				},
			},
		},
	};
}

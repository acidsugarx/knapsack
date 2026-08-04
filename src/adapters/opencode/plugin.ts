/**
 * Knapsack OpenCode adapter — plugin for OpenCode's hook system.
 *
 * @module knapsack-opencode-adapter
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Plugin, tool } from "@opencode-ai/plugin";
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
import { dreamGather, dreamOrient, dreamPrune } from "../../pillar2-memory/dream";
import { checkDrift, formatDriftReport } from "../../pillar2-memory/drift";
import { initEmbeddings } from "../../pillar2-memory/embeddings";
import { ingestSource } from "../../pillar2-memory/ingest";
import { deterministicLint } from "../../pillar2-memory/lint";
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
 * OpenCode plugin entry point.
 * @param _ctx - OpenCode plugin context
 * @returns Hooks object with compression, memory, and custom tools
 */
export default (async (_ctx: unknown) => {
	return {
		"tool.execute.after": async (
			input: { tool: string; sessionID: string; callID: string; args: Record<string, unknown> },
			output: { title: string; output: string; metadata: unknown },
		) => {
			// knapsack_retrieve exists solely to return uncompressed originals.
			// Re-compressing its output defeats its purpose.
			if (input.tool === "knapsack_retrieve") return;
			await ensureInit(input.sessionID);
			if (!db || !store || !registry) return;
			const result = await compress({
				text: output.output,
				toolName: input.tool,
				path: typeof input.args?.path === "string" ? input.args.path : undefined,
				command: typeof input.args?.command === "string" ? input.args.command : undefined,
				db,
				store,
				registry,
			});
			if (result) output.output = result.content.map((b) => b.text).join("");
		},

		"experimental.chat.system.transform": async (
			_input: { sessionID?: string },
			output: { system: string[] },
		) => {
			await ensureInit(_input.sessionID);
			if (!db || !store) return;
			output.system.push(knapsackPromptGuidance());
			const memoryBlock = await injectMemory("", db, store);
			if (memoryBlock) output.system.push(memoryBlock);
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
			if (input.event.type === "session.created") await ensureInit();
		},

		tool: {
			knapsack_search: tool({
				description: "Search Knapsack's persistent memory and Obsidian vault by keywords",
				args: {
					query: tool.schema.string().describe("What to search for"),
					limit: tool.schema.number().optional().describe("Max results (default: 10)"),
				},
				async execute(args) {
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
			}),

			knapsack_save: tool({
				description: "Save a fact, decision, gotcha, or preference to persistent memory",
				args: {
					content: tool.schema.string().describe("What to remember"),
					type: tool.schema
						.enum([
							"decision",
							"fact",
							"gotcha",
							"convention",
							"preference",
							"command",
							"constraint",
							"hypothesis",
						])
						.describe("Memory type"),
					importance: tool.schema
						.number()
						.min(0)
						.max(1)
						.optional()
						.describe("0.0-1.0 (default: 0.5)"),
				},
				async execute(args) {
					await ensureInit();
					if (!db || !store) return "Knapsack not initialized.";
					const entry = db.saveMemory({
						content: args.content,
						type: args.type as never,
						scope: "project",
						project: store.projectRoot ?? undefined,
						importance: Number(args.importance) || 0.5,
						sourceSession: store.sessionId ?? undefined,
					});
					return `✅ Saved: [${entry.type}] ${entry.content}\nid: ${entry.id}`;
				},
			}),

			knapsack_retrieve: tool({
				description: "Retrieve the full original of a compressed tool output by hash",
				args: {
					hash: tool.schema.string().describe("Content hash from compression footer"),
				},
				async execute(args) {
					await ensureInit();
					if (!store) return "Knapsack not initialized.";
					const original = retrieve(
						store.dbPath.replace("/memory.db", ""),
						store.vaultPath,
						args.hash,
					);
					return original ?? `No cached original found for hash "${args.hash}".`;
				},
			}),

			knapsack_stats: tool({
				description: "Show Knapsack compression and memory statistics",
				args: {},
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
			}),

			knapsack_drift: tool({
				description: "Check for decision drift against declared anchors",
				args: {
					content: tool.schema
						.string()
						.optional()
						.describe("Text to scan (optional — omit to list anchors)"),
				},
				async execute(args) {
					await ensureInit();
					if (!db || !store) return "Knapsack not initialized.";
					const detections = checkDrift(db, args.content ?? "", store.projectRoot ?? undefined);
					return formatDriftReport(detections);
				},
			}),

			knapsack_note: tool({
				description: "Write or append to an Obsidian note",
				args: {
					title: tool.schema.string().describe("Note title"),
					content: tool.schema.string().describe("Markdown content"),
				},
				async execute(args) {
					await ensureInit();
					if (!store?.vaultPath) return "No Obsidian vault found.";
					const notePath = writeNote(store.vaultPath, args.title, args.content);
					return notePath ? `✅ [[${notePath.replace(".md", "")}]]` : "Failed to write note.";
				},
			}),
			knapsack_dream: tool({
				description:
					"Run a dream consolidation phase — promotes pending buffer entries to live memory",
				args: {
					phase: tool.schema
						.enum(["orient", "gather", "prune"])
						.describe("orient, gather, or prune"),
				},
				async execute(args) {
					await ensureInit();
					if (!db || !store) return "Knapsack not initialized.";
					if (args.phase === "orient") return `Pending: ${dreamOrient(db, store).pendingBuffer}`;
					if (args.phase === "gather") return `Entries: ${dreamGather(db, store, 20).length}`;
					return `Candidates: ${dreamPrune(db, store).length}`;
				},
			}),
			knapsack_lint: tool({
				description: "Run deterministic memory health check",
				args: {},
				async execute() {
					await ensureInit();
					if (!db || !store) return "Knapsack not initialized.";
					const wikiDir = join(dirname(store.dbPath), "wiki");
					const result = deterministicLint(wikiDir, db, store);
					return `Health: ${result.healthScore}/100 · ${result.findings.length} findings across ${result.totalPages} pages`;
				},
			}),
			knapsack_ingest: tool({
				description: "Ingest an external file into raw store + buffer",
				args: { source: tool.schema.string().describe("File path") },
				async execute(args) {
					await ensureInit();
					if (!db || !store) return "Knapsack not initialized.";
					try {
						const result = ingestSource(db, store, args.source);
						return `Ingested ${result.bytesRead} bytes · hash ${result.rawHash}`;
					} catch (e) {
						return `Failed: ${e instanceof Error ? e.message : String(e)}`;
					}
				},
			}),
		},
	};
}) as Plugin;

/**
 * Knapsack MCP server — exposes knapsack tools to any MCP-compatible client.
 *
 * Works with Claude Code, OpenCode, Cursor, Continue, Cline, and any other
 * agent that supports MCP servers.
 *
 * ## Tools provided
 *
 * | Tool | Purpose |
 * |------|---------|
 * | `knapsack_search` | Search persistent memory + Obsidian vault |
 * | `knapsack_save` | Save a fact, decision, gotcha, or preference |
 * | `knapsack_retrieve` | Fetch original of a compressed tool output by hash |
 * | `knapsack_forget` | Delete a memory entry by ID |
 * | `knapsack_stats` | Show compression and memory statistics |
 * | `knapsack_anchor` | Declare a decision anchor with violation signals |
 * | `knapsack_drift` | Check for decision drift |
 * | `knapsack_note` | Write or append to an Obsidian note |
 *
 * ## Usage
 *
 * ```bash
 * # Run as a standalone MCP server (stdio transport)
 * npx tsx src/adapters/mcp/index.ts
 * ```
 *
 * Or configure in an agent's MCP settings:
 * ```json
 * {
 *   "mcpServers": {
 *     "knapsack": {
 *       "command": "npx",
 *       "args": ["tsx", "src/adapters/mcp/index.ts"]
 *     }
 *   }
 * }
 * ```
 *
 * @module knapsack-mcp-server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchVault } from "../../bridge/obsidian";
import { writeNote } from "../../bridge/obsidian-notes";
import type { KnapsackDB } from "../../core/database";
import {
	formatRetrievalStats,
	loadRetrievalStats,
	recordRetrieval,
} from "../../core/retrieval-stats";
import type { KnapsackStore } from "../../core/types";
import { retrieve } from "../../pillar1-compression/ccr";
import { outputCache } from "../../pillar1-compression/output-cache";
import { checkDrift, formatDriftReport } from "../../pillar2-memory/drift";
import { embed, isAvailable, serializeEmbedding } from "../../pillar2-memory/embeddings";
import { scoreAndRank } from "../../pillar2-memory/scoring";

/**
 * Create a knapsack MCP server with all tools registered.
 *
 * @param db - Knapsack database handle (opened once per session)
 * @param store - Knapsack runtime store
 * @returns Configured `McpServer` ready to connect to a transport
 */
export function createKnapsackMcpServer(db: KnapsackDB, store: KnapsackStore): McpServer {
	const server = new McpServer(
		{ name: "knapsack", version: "0.3.3" },
		{ capabilities: { tools: { listChanged: false } } },
	);

	server.tool(
		"knapsack_search",
		"Search Knapsack's persistent memory (BM25 + optional embeddings) and Obsidian vault. Use when starting work in an unfamiliar codebase or when the user references a past decision, convention, or pitfall.",
		{
			query: z.string().describe("What to search for (topic, technology, error message, etc.)"),
			limit: z.number().optional().default(10).describe("Max results (default: 10)"),
		},
		async (params) => {
			const candidates = db.searchMemory(
				params.query,
				20,
				undefined,
				store.projectRoot ?? undefined,
			);

			let vaultResults: string[] = [];
			if (store.vaultPath) {
				vaultResults = searchVault(store.vaultPath, params.query, 5) ?? [];
			}

			if (candidates.length === 0 && vaultResults.length === 0) {
				return {
					content: [{ type: "text", text: `No memories found for "${params.query}".` }],
				};
			}

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
						type: "text",
						text: `Found ${ranked.length} memories + ${vaultResults.length} vault notes:\n\n${lines.join("\n")}`,
					},
				],
			};
		},
	);

	server.tool(
		"knapsack_save",
		"Save a fact, decision, gotcha, convention, or preference to Knapsack's persistent memory. Available in future sessions.",
		{
			content: z.string().describe("What to remember (be specific and concise)"),
			type: z.enum([
				"decision",
				"fact",
				"gotcha",
				"convention",
				"preference",
				"command",
				"constraint",
				"hypothesis",
			]),
			importance: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.default(0.5)
				.describe("0.0 = trivial, 1.0 = critical (default: 0.5)"),
			scope: z.enum(["global", "project", "session"]).optional().default("project"),
		},
		async (params) => {
			let embedding: string | null = null;
			try {
				if (isAvailable()) {
					const vec = await embed(params.content);
					if (vec) embedding = serializeEmbedding(vec);
				}
			} catch {
				/* embeddings optional */
			}

			const entry = db.saveMemory({
				content: params.content,
				type: params.type,
				scope: params.scope ?? "project",
				project: store.projectRoot ?? undefined,
				importance: params.importance ?? 0.5,
				sourceSession: store.sessionId ?? undefined,
				embedding,
			});

			return {
				content: [
					{ type: "text", text: `✅ Saved: [${entry.type}] ${entry.content}\n\`id: ${entry.id}\`` },
				],
			};
		},
	);

	server.tool(
		"knapsack_retrieve",
		"Retrieve the full original of a previously compressed tool output by its hash. Call ONLY when the compressed output is missing a critical detail.",
		{
			hash: z.string().describe("Content hash from the compression footer"),
		},
		async (params) => {
			const original = retrieve(
				store.dbPath.replace("/memory.db", ""),
				store.vaultPath,
				params.hash,
			);
			if (original) {
				recordRetrieval(db, params.hash);
			}
			if (!original) {
				return {
					content: [{ type: "text", text: `No cached original found for hash "${params.hash}".` }],
				};
			}
			return {
				content: [{ type: "text", text: original }],
			};
		},
	);

	server.tool(
		"knapsack_forget",
		"Delete a memory entry by its ID. Use when a memory is outdated or incorrect.",
		{
			id: z.string().describe("Memory entry ID to delete"),
		},
		async (params) => {
			const deleted = db.deleteMemory(params.id);
			return {
				content: [
					{
						type: "text",
						text: deleted ? `✅ Deleted memory ${params.id}` : `❌ Memory ${params.id} not found`,
					},
				],
			};
		},
	);

	server.tool(
		"knapsack_stats",
		"Show Knapsack compression and memory statistics — tokens saved, compressions performed, memory entries, cache hit rate.",
		{},
		async () => {
			const allTime = db.getAllTimeStats();
			const cacheStats = outputCache.stats();
			const retrievalStats = loadRetrievalStats(db);
			return {
				content: [
					{
						type: "text",
						text: [
							"## 🎒 Knapsack Stats",
							"",
							`Compressions: ${allTime.compressionCount}`,
							`Memory entries: ${allTime.memoryCount}`,
							`Total tokens saved: ${allTime.totalOriginalTokens - allTime.totalCompressedTokens} (${allTime.totalSavingsPercent}%)`,
							`Output cache: ${cacheStats.hits} hits · ${cacheStats.misses} misses · ${cacheStats.size}/${cacheStats.maxSize}`,
							"",
							formatRetrievalStats(retrievalStats),
							store.vaultPath ? `Vault: ${store.vaultPath}` : "",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
			};
		},
	);

	server.tool(
		"knapsack_anchor",
		"Declare a decision anchor with violation signals. Knapsack will monitor future tool outputs and flag drift if the signals appear.",
		{
			statement: z
				.string()
				.describe("The decision statement (e.g., 'Use sql.js, not better-sqlite3')"),
			signals: z
				.array(z.string())
				.describe("Keywords that indicate drift if found in code or output"),
		},
		async (params) => {
			const content = `[anchor] ${params.statement} | signals: ${params.signals.join(", ")}`;
			const _entry = db.saveMemory({
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
						type: "text",
						text: `✅ Anchor declared: ${params.statement}\nMonitoring for: ${params.signals.join(", ")}`,
					},
				],
			};
		},
	);

	server.tool(
		"knapsack_drift",
		"Check for decision drift — scans text for violation signals from declared anchors.",
		{
			content: z
				.string()
				.optional()
				.describe("Text to scan. When omitted, returns current anchors without scanning."),
		},
		async (params) => {
			const detections = checkDrift(db, params.content ?? "", store.projectRoot ?? undefined);
			const report = formatDriftReport(detections);
			return {
				content: [{ type: "text", text: report }],
			};
		},
	);

	server.tool(
		"knapsack_note",
		"Write or append to a note in the Obsidian vault. Notes live in vault root, no frontmatter. Use [[wikilinks]] inline.",
		{
			title: z.string().describe("Note title (becomes filename)"),
			content: z.string().describe("Markdown content. Use [[wikilinks]] for connections."),
		},
		async (params) => {
			if (!store.vaultPath) {
				return { content: [{ type: "text", text: "No Obsidian vault found." }] };
			}
			const notePath = writeNote(store.vaultPath, params.title, params.content);
			return {
				content: [
					{
						type: "text",
						text: notePath ? `✅ [[${notePath.replace(".md", "")}]]` : "Failed to write note.",
					},
				],
			};
		},
	);

	return server;
}

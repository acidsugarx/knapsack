/**
 * Knapsack MCP server entry point — run as a standalone stdio process.
 *
 * ```bash
 * npx tsx src/adapters/mcp/index.ts
 * ```
 *
 * Configure in agent MCP settings:
 * ```json
 * {
 *   "mcpServers": {
 *     "knapsack": {
 *       "command": "npx",
 *       "args": ["tsx", "path/to/src/adapters/mcp/index.ts"]
 *     }
 *   }
 * }
 * ```
 *
 * @module knapsack-mcp-entry
 */

import { mkdirSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { discoverVault } from "../../bridge/obsidian";
import { createDB } from "../../core/database";
import { getProjectRoot } from "../../core/project";
import { initEmbeddings } from "../../pillar2-memory/embeddings";
import { createKnapsackMcpServer } from "./server";

async function main(): Promise<void> {
	const home = process.env.KNAPSACK_HOME ?? `${process.env.HOME ?? "~"}/.knapsack`;
	const dbPath = `${home}/memory.db`;

	mkdirSync(home, { recursive: true });
	const db = await createDB(dbPath);
	await initEmbeddings();

	const store = {
		dbPath,
		projectRoot: getProjectRoot(process.cwd()),
		sessionId: null,
		vaultPath: discoverVault(),
	};

	const server = createKnapsackMcpServer(db, store);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	console.error("Knapsack MCP server failed:", err);
	process.exit(1);
});

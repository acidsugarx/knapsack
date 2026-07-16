/**
 * Command registration — registers Knapsack's slash commands with Pi.
 *
 * Commands are available as `/knapsack-status` and `/knapsack-learn`
 * in the Pi editor. They provide quick access to diagnostics and
 * session analysis without going through the LLM tool-calling path.
 *
 * Commands use `triggerTurn: false` — they don't send anything to the LLM,
 * they just show information directly in the UI.
 *
 * @module commands
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore } from "../core/types";

/**
 * Register all Knapsack slash commands with Pi.
 *
 * @param pi - Pi ExtensionAPI
 * @param getDB - Lazy accessor for the current database handle
 * @param getStore - Lazy accessor for the current runtime store
 */
export function registerCommands(
	pi: ExtensionAPI,
	getDB: () => KnapsackDB | null,
	getStore: () => KnapsackStore | null,
): void {
	/**
	 * /knapsack-status — show current Knapsack state and statistics.
	 *
	 * Displays:
	 * - Database path and size
	 * - Obsidian vault status
	 * - Session compression stats
	 * - All-time stats
	 * - Active project
	 */
	pi.registerCommand("knapsack-status", {
		description: "Show Knapsack status, stats, and configuration",
		handler: async (_args, ctx) => {
			const db = getDB();
			const store = getStore();

			if (!db || !store) {
				ctx.ui.notify("Knapsack is not initialized. Start a session first.", "warning");
				return;
			}

			const sessionStats = db.getSessionCompressionStats(store.sessionId ?? "");
			const allTime = db.getAllTimeStats();

			const lines = [
				"🎒 Knapsack Status",
				"──────────────────",
				`DB: ${store.dbPath}`,
				`Vault: ${store.vaultPath ?? "not found"}`,
				`Project: ${store.projectRoot ?? "not in git repo"}`,
				`Session: ${store.sessionId ?? "none"}`,
				"",
				"Session stats:",
				`  Compressions: ${sessionStats.count}`,
				`  Tokens saved: ${sessionStats.totalOriginalTokens - sessionStats.totalCompressedTokens} (${sessionStats.totalSavingsPercent}%)`,
				"",
				"All-time:",
				`  Compressions: ${allTime.compressionCount}`,
				`  Memories: ${allTime.memoryCount}`,
				`  Total saved: ${allTime.totalOriginalTokens - allTime.totalCompressedTokens} tokens (${allTime.totalSavingsPercent}%)`,
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	/**
	 * /knapsack-learn — analyze the current session and save learnings.
	 *
	 * Reviews session events and saves insights to memory.
	 * Currently a placeholder for future offline analysis functionality.
	 */
	pi.registerCommand("knapsack-learn", {
		description: "Analyze the current session and save learnings to memory",
		handler: async (_args, ctx) => {
			const db = getDB();
			const store = getStore();

			if (!db || !store) {
				ctx.ui.notify("Knapsack is not initialized.", "warning");
				return;
			}

			// For now, just show what we have
			const memories = db.getRecentMemory(5, store.projectRoot ?? undefined);

			if (memories.length === 0) {
				ctx.ui.notify("No memories to learn from in this project yet.", "info");
				return;
			}

			ctx.ui.notify(
				`Recent learnings (${memories.length}):\n${memories.map((m) => `  [${m.type}] ${m.content}`).join("\n")}`,
				"info",
			);
		},
	});
}

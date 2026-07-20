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

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore } from "../core/types";
import { isAvailable } from "../pillar2-memory/embeddings";
import {
	analyzeSession,
	formatAnalysis,
	saveAnalysisToMemory,
} from "../pillar2-memory/session-analysis";

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

			const embeddingsOn = isAvailable();

			const lines = [
				"🎒 Knapsack Status",
				"──────────────────",
				`DB: ${store.dbPath}`,
				`Vault: ${store.vaultPath ?? "not found"}`,
				`Embeddings: ${embeddingsOn ? "on (384-dim MiniLM)" : "off (install @xenova/transformers to enable)"}`,
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

			// Find the session JSONL file
			const sessionDir = `${process.env.HOME ?? "~"}/.pi/agent/sessions`;
			const sessionFile = store.sessionId ? findSessionFile(sessionDir, store.sessionId) : null;

			if (!sessionFile || !existsSync(sessionFile)) {
				ctx.ui.notify("No session file found for analysis.", "warning");
				return;
			}

			// Analyze
			const analysis = analyzeSession(sessionFile);
			const saved = saveAnalysisToMemory(analysis, db, store);
			const report = formatAnalysis(analysis);

			ctx.ui.notify(report, saved > 0 ? "info" : "info");
		},
	});

	/**
	 * /knapsack-consolidate — batch-merge duplicate memories.
	 *
	 * Pair-wise merge within each (type, project) group when Jaccard word
	 * overlap >= 0.75. Surviving row keeps the longer content, bumped
	 * importance, summed access_count. Duplicates are deleted.
	 */
	pi.registerCommand("knapsack-consolidate", {
		description: "Batch-merge duplicate memories (older cleanup pass)",
		handler: async (_args, ctx) => {
			const db = getDB();
			if (!db) {
				ctx.ui.notify("Knapsack is not initialized.", "warning");
				return;
			}
			const result = db.consolidateMemories();
			const lines = [
				"🎒 Memory consolidation",
				"──────────────────────",
				`Scanned:   ${result.scanned}`,
				`Merged:    ${result.merged}`,
				`Remaining: ${result.remaining}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

/**
 * Find the session JSONL file by session ID.
 */
function findSessionFile(sessionDir: string, sessionId: string): string | null {
	try {
		for (const dir of readdirSync(sessionDir, { recursive: true, withFileTypes: true })) {
			if (dir.isFile() && dir.name.includes(sessionId) && dir.name.endsWith(".jsonl")) {
				return join(dir.parentPath ?? sessionDir, dir.name);
			}
		}
	} catch {
		// Session dir not found
	}
	return null;
}

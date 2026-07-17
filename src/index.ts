/**
 * Knapsack — Pi extension entry point.
 *
 * Wires up compression hooks, memory hooks, custom tools, and slash commands.
 * This is the file pi loads via jiti when the extension is activated.
 *
 * ## Hook order matters
 *
 * Hooks are registered in the order pi fires them during a session lifecycle:
 * session_start → tool_result/turn_end → before_agent_start → session_before_compact → session_shutdown
 *
 * @module knapsack
 * @packageDocumentation
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverVault } from "./bridge/obsidian";
import { registerCommands } from "./commands/index";
import type { KnapsackDB } from "./core/database";
import { createDB } from "./core/database";
import { getProjectRoot } from "./core/project";
import type { KnapsackStore } from "./core/types";
import { createDefaultRegistry } from "./pillar1-compression/default-registry";
import { compressionHook } from "./pillar1-compression/hook";
import { compactionHook } from "./pillar2-memory/compaction";
import { memoryInjectHook } from "./pillar2-memory/inject";
import { observeHook } from "./pillar2-memory/observe";
import { knapsackPromptGuidance } from "./system-prompt";
import { registerTools } from "./tools/index";

/**
 * Knapsack extension entry point.
 *
 * Pi loads this module via jiti (TypeScript runtime). The default export
 * receives the ExtensionAPI and wires up all hooks, tools, and commands.
 *
 * The factory is async because sql.js (WASM) requires async initialization.
 *
 * @param pi - Pi's ExtensionAPI instance
 *
 * @example
 * ```bash
 * # Install and load
 * pi install npm:knapsack-pi
 * # or for development:
 * pi -e ./src/index.ts
 * ```
 */
export default async function knapsack(pi: ExtensionAPI) {
	/**
	 * Knapsack runtime store — shared state across all hooks.
	 * Created lazily on session_start, destroyed on session_shutdown.
	 */
	let store: KnapsackStore | null = null;

	/**
	 * Database handle — opened once per session.
	 * SQLite via sql.js (WASM) with FTS5 for memory search.
	 */
	let db: KnapsackDB | null = null;

	/**
	 * Compression strategy registry — created once at extension load.
	 * Third-party strategies can be added before session_start.
	 */
	const compressionRegistry = createDefaultRegistry();

	// ── Lifecycle: startup ──────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const home = process.env.KNAPSACK_HOME ?? `${process.env.HOME ?? "~"}/.knapsack`;
		const dbPath = `${home}/memory.db`;

		const fs = await import("node:fs");
		fs.mkdirSync(home, { recursive: true });

		db = await createDB(dbPath);

		// Initialize embeddings (optional, graceful fallback)
		const { initEmbeddings, isAvailable } = await import("./pillar2-memory/embeddings");
		await initEmbeddings();

		const projectRoot = getProjectRoot(ctx.cwd);
		const vaultPath = discoverVault();

		store = {
			dbPath,
			projectRoot,
			sessionId: ctx.sessionManager?.getSessionId?.() ?? null,
			vaultPath,
		};

		const status = vaultPath
			? isAvailable()
				? "🎒 ready (embeddings)"
				: "🎒 ready"
			: isAvailable()
				? "🎒 (no vault, embeddings)"
				: "🎒 (no vault)";
		ctx.ui.setStatus("knapsack", status);
	});

	// ── Pillar 1: Compression ──────────────────────────────

	pi.on("tool_result", async (event, ctx) => {
		if (!db || !store) return;
		return compressionHook(event, ctx, db, store, compressionRegistry);
	});

	// ── Pillar 2: Memory ───────────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!db || !store) return;

		// Always inject Knapsack usage guidance into system prompt
		let systemPrompt = `${event.systemPrompt}\n\n${knapsackPromptGuidance()}`;

		// Inject relevant memories if available
		const memoryBlock = await memoryInjectHook(event, db, store);
		if (memoryBlock) {
			systemPrompt += `\n\n${memoryBlock}`;
		}

		return { systemPrompt };
	});

	pi.on("turn_end", async (event, _ctx) => {
		if (!db || !store) return;
		await observeHook(event, db, store);
	});

	pi.on("session_before_compact", async (event, _ctx) => {
		if (!db || !store) return;
		return compactionHook(event, db, store);
	});

	// ── Lifecycle: shutdown ─────────────────────────────────

	pi.on("session_shutdown", async () => {
		if (db) {
			db.pruneMemories();
			db.close();
			db = null;
		}
		store = null;
	});

	// ── Tools & Commands ───────────────────────────────────

	registerTools(
		pi,
		() => db,
		() => store,
	);
	registerCommands(
		pi,
		() => db,
		() => store,
	);
}

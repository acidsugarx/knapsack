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

import { mkdirSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverVault } from "./bridge/obsidian";
import { registerCommands } from "./commands/index";
import type { KnapsackDB } from "./core/database";
import { createDB } from "./core/database";
import { getProjectRoot } from "./core/project";
import type { KnapsackStore } from "./core/types";
import { createDefaultRegistry } from "./pillar1-compression/default-registry";
import { compressionHook } from "./pillar1-compression/hook";
import { outputCompressionHook } from "./pillar1-compression/output-hook";
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
 * @returns A promise that resolves once all hooks, tools, and commands are wired up.
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

	/**
	 * session_start — fires once when a Pi session opens. Creates the
	 * Knapsack home directory, opens the SQLite database, initialises
	 * optional embeddings, discovers the Obsidian vault, and populates
	 * the runtime store. Sets the Pi status bar to reflect readiness.
	 */
	pi.on("session_start", async (_event, ctx) => {
		const home = process.env.KNAPSACK_HOME ?? `${process.env.HOME ?? "~"}/.knapsack`;
		const dbPath = `${home}/memory.db`;

		mkdirSync(home, { recursive: true });

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

	/**
	 * tool_result — fires after every tool execution. Delegates to
	 * {@link compressionHook} which auto-detects content type, compresses
	 * large outputs, caches originals in CCR, records stats, and checks
	 * for decision drift. Returns modified content or undefined (passthrough).
	 */
	pi.on("tool_result", async (event, ctx) => {
		if (!db || !store) return;
		return compressionHook(event, ctx, db, store, compressionRegistry);
	});

	/**
	 * context — fires before each LLM call with the full message list.
	 * Delegates to {@link outputCompressionHook} which compresses old
	 * assistant messages (strip boilerplate, collapse whitespace, truncate
	 * very long blocks) to reduce input tokens on subsequent turns. The
	 * most recent 2 assistant messages are always left untouched.
	 */
	pi.on("context", (event) => {
		return outputCompressionHook(event);
	});

	// ── Pillar 2: Memory ───────────────────────────────────

	/**
	 * before_agent_start — fires after the user submits a prompt, before
	 * the agent loop begins. Appends Knapsack usage guidance to the system
	 * prompt, then injects task-relevant memories via {@link memoryInjectHook}.
	 * Bytes are stable across turns so Pi's prompt cache stays hot.
	 */
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

	/**
	 * turn_end — fires after each agent turn completes. Delegates to
	 * {@link observeHook} which auto-saves failed tool calls as gotchas
	 * so the model doesn't repeat the same mistake in future sessions.
	 */
	pi.on("turn_end", async (event, _ctx) => {
		if (!db || !store) return;
		await observeHook(event, db, store);
	});

	/**
	 * session_before_compact — fires right before Pi compacts the context
	 * window. Delegates to {@link compactionHook} which persists a session
	 * state summary to memory, so the model retains awareness of what was
	 * being worked on after the context reset.
	 */
	pi.on("session_before_compact", async (event, _ctx) => {
		if (!db || !store) return;
		return compactionHook(event, db, store);
	});

	// ── Lifecycle: shutdown ─────────────────────────────────

	/**
	 * session_shutdown — fires when the Pi session closes. Prunes old
	 * low-importance memories (30 days, importance < 0.3, access ≤ 1),
	 * closes the SQLite database (flushing to disk), and nulls the store.
	 */
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

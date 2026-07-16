/**
 * Knapsack — token reduction & persistent memory for Pi coding agent.
 *
 * ## Architecture
 *
 * Knapsack has two pillars:
 *
 * **Pillar 1: Token Reduction** — transparently compresses large tool outputs
 * (bash, grep, read, find, JSON) before they enter the LLM context window.
 * Originals are cached in Obsidian vault via Compress-Cache-Retrieve (CCR).
 * Model gets the signal, not the noise. Same decisions, 50–95% fewer tokens.
 *
 * **Pillar 2: Persistent Memory** — SQLite-backed knowledge store that
 * survives sessions and compaction. The model saves decisions, facts,
 * gotchas, conventions, and preferences. Relevant memories are injected
 * before each agent turn. Compaction events flush session summaries to
 * memory so context never fully disappears.
 *
 * ## Integration Points
 *
 * Knapsack hooks into Pi's extension API at these lifecycle points:
 *
 * | Hook                    | What happens                                    |
 * |-------------------------|-------------------------------------------------|
 * | `session_start`          | Open DB, discover Obsidian vault, inject skill  |
 * | `before_agent_start`     | Inject relevant memories into system prompt     |
 * | `tool_result`            | Compress large outputs (bash/grep/read/find)    |
 * | `turn_end`               | Observe learnings (failed tools, corrections)   |
 * | `session_before_compact` | Flush session memory before context reset       |
 * | `session_shutdown`       | Close DB, cleanup                               |
 *
 * ## Idempotency
 *
 * Every operation is safe to retry:
 * - Memory: UPSERT by `content_hash` (SHA256 of content + type)
 * - Compression: skip if `original_hash` already in DB
 * - Obsidian writes: check file existence before creating
 *
 * @module knapsack
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverVault } from "./bridge/obsidian";
import { registerCommands } from "./commands/index";
import type { KnapsackDB } from "./core/database";
import { createDB } from "./core/database";
import { getProjectRoot } from "./core/project";
import type { KnapsackStore } from "./core/types";
import { compressionHook } from "./pillar1-compression/hook";
import { compactionHook } from "./pillar2-memory/compaction";
import { memoryInjectHook } from "./pillar2-memory/inject";
import { observeHook } from "./pillar2-memory/observe";
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

	// ── Lifecycle: startup ──────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const home = process.env.KNAPSACK_HOME ?? `${process.env.HOME ?? "~"}/.knapsack`;
		const dbPath = `${home}/memory.db`;

		// Ensure directory exists
		const fs = await import("node:fs");
		fs.mkdirSync(home, { recursive: true });

		db = await createDB(dbPath);
		const projectRoot = getProjectRoot(ctx.cwd);
		const vaultPath = discoverVault();

		store = {
			dbPath,
			projectRoot,
			sessionId: ctx.sessionManager?.getSessionId?.() ?? null,
			vaultPath,
		};

		if (vaultPath) {
			ctx.ui.setStatus("knapsack", "🎒 ready");
		} else {
			ctx.ui.setStatus("knapsack", "🎒 (no vault)");
		}
	});

	// ── Pillar 1: Compression ──────────────────────────────

	pi.on("tool_result", async (event, ctx) => {
		if (!db || !store) return;
		await compressionHook(event, ctx, db, store);
	});

	// ── Pillar 2: Memory ───────────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!db || !store) return;
		return memoryInjectHook(event, db, store);
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

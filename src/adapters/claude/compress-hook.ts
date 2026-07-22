/**
 * Knapsack Claude Code adapter — PostToolUse hook for tool output compression.
 *
 * ## How it works
 *
 * Claude Code fires a `PostToolUse` event after each tool call succeeds.
 * The hook receives the tool output as JSON on stdin and can replace it
 * via `updatedToolOutput` in the response.
 *
 * This script:
 * 1. Reads the PostToolUse event JSON from stdin
 * 2. Extracts the tool name and output text
 * 3. Runs the knapsack compression pipeline
 * 4. Returns the compressed output (or passes through if below threshold)
 *
 * ## Installation
 *
 * Add to `.claude/settings.json`:
 * ```json
 * {
 *   "hooks": {
 *     "PostToolUse": [{
 *       "matcher": "Bash|Read|Grep|Glob",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "npx tsx path/to/src/adapters/claude/compress-hook.ts"
 *       }]
 *     }]
 *   }
 * }
 * ```
 *
 * @module knapsack-claude-adapter
 */

import { mkdirSync } from "node:fs";
import { discoverVault } from "../../bridge/obsidian";
import { createDB } from "../../core/database";
import { compress } from "../../core/pipeline";
import { getProjectRoot } from "../../core/project";
import { createDefaultRegistry } from "../../pillar1-compression/default-registry";
import { initEmbeddings } from "../../pillar2-memory/embeddings";

interface ClaudePostToolUseEvent {
	tool_name: string;
	tool_input: Record<string, unknown>;
	tool_response?: {
		content?: Array<{ type: string; text?: string }>;
	};
}

interface ClaudeHookResult {
	hookSpecificOutput?: {
		updatedToolOutput?: {
			content: Array<{ type: string; text: string }>;
		};
	};
}

let db: Awaited<ReturnType<typeof createDB>> | null = null;
let registry: ReturnType<typeof createDefaultRegistry> | null = null;
let store: {
	dbPath: string;
	projectRoot: string | null;
	sessionId: string | null;
	vaultPath: string | null;
} | null = null;

async function ensureInit(): Promise<void> {
	if (db && registry && store) return;

	const home = process.env.KNAPSACK_HOME ?? `${process.env.HOME ?? "~"}/.knapsack`;
	const dbPath = `${home}/memory.db`;
	mkdirSync(home, { recursive: true });

	db = await createDB(dbPath);
	await initEmbeddings();
	registry = createDefaultRegistry();
	store = {
		dbPath,
		projectRoot: getProjectRoot(process.cwd()),
		sessionId: null,
		vaultPath: discoverVault(),
	};
}

async function main(): Promise<void> {
	const rawInput = await readStdin();
	if (!rawInput.trim()) {
		process.exit(0);
	}

	const event: ClaudePostToolUseEvent = JSON.parse(rawInput);
	const text = extractToolOutput(event.tool_response);
	if (!text) {
		process.exit(0);
	}

	await ensureInit();

	const result = await compress({
		text,
		toolName: event.tool_name,
		path: typeof event.tool_input?.path === "string" ? event.tool_input.path : undefined,
		db: db!,
		store: store!,
		registry: registry!,
	});

	if (!result) {
		process.exit(0);
	}

	const fullText = result.content.map((b) => b.text).join("");

	const hookResult: ClaudeHookResult = {
		hookSpecificOutput: {
			updatedToolOutput: {
				content: [{ type: "text", text: fullText }],
			},
		},
	};

	process.stdout.write(JSON.stringify(hookResult));
}

function readStdin(): Promise<string> {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => (data += chunk));
		process.stdin.on("end", () => resolve(data));
	});
}

function extractToolOutput(response: unknown): string | null {
	if (!response || typeof response !== "object") return null;
	const content = (response as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	const texts = content
		.filter(
			(b): b is { type: string; text: string } =>
				typeof b === "object" &&
				b !== null &&
				(b as { type?: string }).type === "text" &&
				typeof (b as { text?: string }).text === "string",
		)
		.map((b) => b.text);
	return texts.length > 0 ? texts.join("\n") : null;
}

main().catch((err) => {
	console.error("Knapsack Claude hook failed:", err);
	process.exit(0);
});

/**
 * Headless integration test: Knapsack OpenCode plugin.
 *
 * Simulates what OpenCode does when it loads the knapsack plugin:
 * 1. Calls the plugin function to get the hooks object
 * 2. Fires `tool.execute.after` with large output → verifies compression
 * 3. Fires `experimental.chat.system.transform` → verifies memory guidance
 * 4. Calls custom tools (knapsack_stats, knapsack_save, knapsack_search)
 *
 * No LLM needed — this tests the plugin's hook handlers directly.
 *
 * Usage:
 *   npx tsx scripts/test-opencode-headless.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputCache } from "../src/pillar1-compression/output-cache";

// Set up isolated knapsack home before importing the plugin
const tmpHome = mkdtempSync(join(tmpdir(), "knapsack-oc-test-"));
process.env.KNAPSACK_HOME = tmpHome;

const pluginModule = await import("../src/adapters/opencode/plugin");
const plugin = pluginModule.default;

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
	if (condition) {
		console.log(`  ✅ ${name}`);
		passed++;
	} else {
		console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
		failed++;
	}
}

async function main(): Promise<void> {
	console.log("=== Knapsack OpenCode Plugin — Headless Test ===\n");

	// ── Step 1: Load the plugin ──────────────────────────────
	console.log("1. Loading plugin...");
	const hooks = await plugin({});
	check("plugin returns hooks object", typeof hooks === "object" && hooks !== null);
	check("has tool.execute.after hook", typeof hooks["tool.execute.after"] === "function");
	check(
		"has experimental.chat.system.transform hook",
		typeof hooks["experimental.chat.system.transform"] === "function",
	);
	check(
		"has experimental.session.compacting hook",
		typeof hooks["experimental.session.compacting"] === "function",
	);
	check("has custom tools", typeof hooks.tool === "object" && Object.keys(hooks.tool).length > 0);
	const toolNames = Object.keys(hooks.tool);
	check("has knapsack_search", toolNames.includes("knapsack_search"));
	check("has knapsack_save", toolNames.includes("knapsack_save"));
	check("has knapsack_stats", toolNames.includes("knapsack_stats"));
	check("has knapsack_retrieve", toolNames.includes("knapsack_retrieve"));
	check("has knapsack_drift", toolNames.includes("knapsack_drift"));
	check("has knapsack_note", toolNames.includes("knapsack_note"));
	console.log(`   Tools: ${toolNames.join(", ")}\n`);

	// ── Step 2: Simulate tool.execute.after with large output ──
	console.log("2. Simulating tool.execute.after (compression)...");
	outputCache.clear();

	const largeOutput = Array.from({ length: 400 }, (_, i) => `./src/module_${i}/file.c`).join("\n");
	const toolOutput = { title: "Find", output: largeOutput, metadata: {} };

	await hooks["tool.execute.after"]!(
		{
			tool: "Bash",
			sessionID: "test-session",
			callID: "call-1",
			args: { command: "find . -name *.c" },
		},
		toolOutput,
	);

	check("output was modified", toolOutput.output !== largeOutput);
	check("output contains compression footer", toolOutput.output.includes("smaller"));
	check("output contains hash", toolOutput.output.includes("hash"));
	check("output is shorter than original", toolOutput.output.length < largeOutput.length);

	const origTokens = Math.ceil(largeOutput.length / 3.5);
	const compTokens = Math.ceil(toolOutput.output.length / 3.5);
	console.log(`   ${origTokens} → ${compTokens} tokens\n`);

	// ── Step 3: Simulate tool.execute.after with small output (passthrough) ──
	console.log("3. Simulating tool.execute.after (small output, should passthrough)...");
	outputCache.clear();

	const smallOutput = { title: "Echo", output: "hello world", metadata: {} };
	const originalSmall = smallOutput.output;
	await hooks["tool.execute.after"]!(
		{ tool: "Bash", sessionID: "test-session", callID: "call-2", args: {} },
		smallOutput,
	);
	check("small output passes through unchanged", smallOutput.output === originalSmall);
	console.log("");

	// ── Step 4: Simulate system.transform (memory injection) ──
	console.log("4. Simulating experimental.chat.system.transform...");
	const systemOutput = { system: [] as string[] };
	await hooks["experimental.chat.system.transform"]!({ sessionID: "test-session" }, systemOutput);
	check("system prompt was extended", systemOutput.system.length > 0);
	check(
		"contains knapsack guidance",
		systemOutput.system.some((s) => s.includes("Knapsack") || s.includes("knapsack")),
	);
	console.log(`   System prompt blocks: ${systemOutput.system.length}\n`);

	// ── Step 5: Simulate session.compacting ─────────────────
	console.log("5. Simulating experimental.session.compacting...");
	const compactOutput = { context: [] as string[], prompt: undefined as string | undefined };
	await hooks["experimental.session.compacting"]!({ sessionID: "test-session" }, compactOutput);
	check("compaction context was added", compactOutput.context.length > 0);
	check(
		"compaction context mentions knapsack",
		compactOutput.context.some((c) => c.includes("Knapsack") || c.includes("knapsack")),
	);
	console.log("");

	// ── Step 6: Call custom tools ────────────────────────────
	console.log("6. Calling custom tools...");

	// knapsack_stats
	const statsTool = hooks.tool.knapsack_stats;
	const statsResult = await statsTool.execute({});
	check("knapsack_stats returns text", typeof statsResult === "string");
	check(
		"knapsack_stats mentions compressions or Knapsack",
		statsResult.includes("Knapsack") || statsResult.includes("Compression"),
	);
	console.log(`   Stats: ${statsResult}\n`);

	// knapsack_save
	const saveTool = hooks.tool.knapsack_save;
	const saveResult = await saveTool.execute({
		content: "Use sql.js not better-sqlite3 for knapsack",
		type: "decision",
	});
	check("knapsack_save returns saved message", saveResult.includes("Saved"));
	console.log(`   Save: ${saveResult}\n`);

	// knapsack_search
	const searchTool = hooks.tool.knapsack_search;
	const searchResult = await searchTool.execute({ query: "sql.js database" });
	check(
		"knapsack_search finds the saved memory",
		searchResult.includes("sql.js") || searchResult.includes("better-sqlite3"),
	);
	console.log(`   Search: ${searchResult.slice(0, 100)}...\n`);

	// knapsack_drift
	const driftTool = hooks.tool.knapsack_drift;
	const driftResult = await driftTool.execute({});
	check("knapsack_drift returns text", typeof driftResult === "string");
	console.log(`   Drift: ${driftResult.slice(0, 80)}...\n`);

	// ── Step 7: Verify cache works across calls ──────────────
	console.log("7. Verifying output cache...");
	outputCache.clear();
	const cacheTestOutput = { title: "Find", output: largeOutput, metadata: {} };
	await hooks["tool.execute.after"]!(
		{ tool: "Bash", sessionID: "test-session", callID: "call-3", args: {} },
		cacheTestOutput,
	);
	const cacheStats = outputCache.stats();
	check("cache has 1 entry after compression", cacheStats.size === 1);
	check("cache has 1 miss", cacheStats.misses === 1);

	// Second call with same output should hit cache
	const cacheTestOutput2 = { title: "Find", output: largeOutput, metadata: {} };
	await hooks["tool.execute.after"]!(
		{ tool: "Bash", sessionID: "test-session", callID: "call-4", args: {} },
		cacheTestOutput2,
	);
	const cacheStats2 = outputCache.stats();
	check("cache has 1 hit on second call", cacheStats2.hits === 1);
	check("cache still has 1 entry", cacheStats2.size === 1);
	check("both calls produce same output", cacheTestOutput.output === cacheTestOutput2.output);
	console.log("");

	// ── Summary ──────────────────────────────────────────────
	console.log("=== Results ===");
	console.log(`  Passed: ${passed}`);
	console.log(`  Failed: ${failed}`);
	console.log(
		failed === 0 ? "\n✅ All OpenCode plugin tests passed!" : `\n❌ ${failed} tests failed`,
	);

	rmSync(tmpHome, { recursive: true, force: true });
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("❌ Test failed with error:", err);
	rmSync(tmpHome, { recursive: true, force: true });
	process.exit(1);
});

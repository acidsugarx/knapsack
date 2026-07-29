/**
 * Manual test: U-curve position optimization.
 *
 * Usage: npx tsx scripts/test-u-curve.ts
 *
 * Verifies that compressed bash output places errors at the top
 * and that json output places shape before samples.
 */

import { compress } from "../src/core/pipeline";
import type { KnapsackDB, KnapsackStore } from "../src/core/types";
import { createDefaultRegistry } from "../src/pillar1-compression/default-registry";
import { outputCache } from "../src/pillar1-compression/output-cache";

const db = {} as unknown as KnapsackDB;
const store = {
	dbPath: "/tmp/knapsack-test/memory.db",
	vaultPath: null,
	projectRoot: null,
	sessionId: null,
} as KnapsackStore;
const registry = createDefaultRegistry();

async function main() {
	outputCache.clear();

	// Test 1: bash output with errors — errors should be at top
	const bashOutput = [
		"[INFO] Starting build",
		"[INFO] Compiling src/index.ts",
		"[WARN] Deprecated config option 'legacy'",
		"[ERROR] Failed to compile src/broken.ts: type mismatch",
		"[ERROR] Missing dependency 'lodash'",
		"[INFO] Build failed with 2 errors",
	].join("\n");

	const bashResult = await compress({ text: bashOutput, toolName: "bash", db, store, registry });
	console.log(
		"bash test:",
		bashResult
			? `first 200 chars: ${String(bashResult.content[0].text).slice(0, 200)}`
			: "no compression",
	);

	// Test 2: json — shape before samples
	const jsonOutput = JSON.stringify({
		users: [
			{ id: 1, name: "Alice", email: "alice@example.com" },
			{ id: 2, name: "Bob", email: "bob@example.com" },
			{ id: 3, name: "Charlie", email: "charlie@example.com" },
		],
	});

	const jsonResult = await compress({ text: jsonOutput, toolName: "bash", db, store, registry });
	console.log(
		"json test:",
		jsonResult
			? `first 200 chars: ${String(jsonResult.content[0].text).slice(0, 200)}`
			: "no compression",
	);

	// Test 3: find — directory structure before file list (find strategy already sorts by dir)
	const findOutput = Array.from({ length: 200 }, (_, i) => `./src/module_${i}/file.c`).join("\n");
	const findResult = await compress({ text: findOutput, toolName: "find", db, store, registry });
	console.log(
		"find test:",
		findResult ? `footer: ${String(findResult.content[1].text)}` : "no compression",
	);

	console.log("\nDone.");
}

main().catch(console.error);

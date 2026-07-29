/**
 * Manual test: tee-on-failure behavior.
 *
 * Usage: npx tsx scripts/test-tee-on-failure.ts
 */

import { compress } from "../src/core/pipeline";
import type { KnapsackDB, KnapsackStore } from "../src/core/types";
import { createDefaultRegistry } from "../src/pillar1-compression/default-registry";
import { outputCache } from "../src/pillar1-compression/output-cache";

const db = {
	recordCompression: () => {},
	getMeta: () => undefined,
	setMeta: () => {},
} as unknown as KnapsackDB;
const store = {
	dbPath: "/tmp/knapsack/memory.db",
	vaultPath: null,
	projectRoot: null,
	sessionId: null,
} as KnapsackStore;
const registry = createDefaultRegistry();

async function test(label: string, text: string, exitCode?: number) {
	outputCache.clear();
	const result = await compress({ text, toolName: "bash", exitCode, db, store, registry });
	if (result) {
		const body = String(result.content[0].text);
		const footer = String(result.content[1].text);
		const isTee = footer.includes("tee-on-failure");
		console.log(`${label}: ${isTee ? "TEE" : "COMPRESSED"} — ${String(body).slice(0, 100)}`);
	} else {
		console.log(`${label}: PASSTHROUGH (no compression)`);
	}
}

async function main() {
	// Test 1: Failed command with error markers
	await test(
		"exitCode=1 with errors",
		["[INFO] Starting build", "[ERROR] Compilation failed", "[ERROR] Missing dependency"].join(
			"\n",
		),
		1,
	);

	// Test 2: Failed command without error markers
	await test("exitCode=1 no markers", "some output without clear markers".repeat(20), 1);

	// Test 3: Successful command
	await test("exitCode=0 normal", "Build completed successfully".repeat(20), 0);

	// Test 4: No exit code (legacy)
	await test("no exitCode", "some output\n".repeat(100));

	console.log("\nDone.");
}

main().catch(console.error);

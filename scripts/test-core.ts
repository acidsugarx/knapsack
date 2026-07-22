/**
 * Manual test script: Knapsack core compression pipeline.
 *
 * Tests each strategy type directly via the core `compress()` function.
 *
 * @module test-core-pipeline
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compress } from "../src/core/pipeline";
import { createDefaultRegistry } from "../src/pillar1-compression/default-registry";
import { outputCache } from "../src/pillar1-compression/output-cache";

const tmpHome = mkdtempSync(join(tmpdir(), "knapsack-core-test-"));
const db = { recordCompression: () => {}, searchMemory: () => [] } as never;
const store = {
	dbPath: `${tmpHome}/memory.db`,
	vaultPath: null,
	projectRoot: "/fake",
	sessionId: "test",
} as never;
const registry = createDefaultRegistry();

async function test(name: string, text: string, toolName: string): Promise<void> {
	outputCache.clear();
	const result = await compress({ text, toolName, db, store, registry });
	if (!result) {
		console.log(`  ⚠️  ${name}: passthrough (below threshold)`);
		return;
	}
	const body = result.content[0]?.text ?? "";
	const footer = result.content[1]?.text ?? "";
	const savingsMatch = footer.match(/(\d+)% smaller/);
	const savings = savingsMatch ? `${savingsMatch[1]}%` : "N/A";
	const origLen = Math.ceil(text.length / 3.5);
	const compLen = Math.ceil(body.length / 3.5);
	console.log(`  ✅ ${name}: ${origLen} → ${compLen} tokens (${savings})`);
}

async function main(): Promise<void> {
	console.log("=== Knapsack Core Pipeline Test ===\n");

	const findOutput = Array.from({ length: 400 }, (_, i) => `./src/module_${i}/file.c`).join("\n");
	await test("find (400 files)", findOutput, "find");

	const grepOutput = Array.from(
		{ length: 100 },
		(_, i) => `src/api/users.ts:${i * 10 + 5}:const user = await db.find({ id: ${i} })`,
	).join("\n");
	await test("grep (100 matches)", grepOutput, "grep");

	const bashLines: string[] = [];
	for (let i = 0; i < 500; i++) bashLines.push(`[INFO] Compiling module_${i}...`);
	bashLines.push("[ERROR] Failed to compile module D");
	await test("bash (build output)", bashLines.join("\n"), "bash");

	const jsonData = JSON.stringify(
		Array.from({ length: 200 }, (_, i) => ({ id: i, name: `User_${i}`, active: i % 2 === 0 })),
	);
	await test("json (200 items)", jsonData, "json");

	await test("small output", "just one line", "bash");

	console.log("\n=== Core pipeline tests passed ===");
	rmSync(tmpHome, { recursive: true, force: true });
}

main().catch((err) => {
	console.error("❌ Core pipeline test failed:", err);
	process.exit(1);
});

/**
 * Manual test: Retrieval pressure learning.
 *
 * Verifies that:
 * 1. Compressions are tracked per strategy
 * 2. Retrievals adjust the rate
 * 3. Adaptive parameters change based on rate
 * 4. Stats persist in the database
 *
 * Usage: npx tsx scripts/test-retrieval-pressure.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDB } from "../src/core/database";
import { compress } from "../src/core/pipeline";
import {
	formatRetrievalStats,
	getAdaptiveMaxSamples,
	getRetrievalRate,
	loadRetrievalStats,
	recordRetrieval,
} from "../src/core/retrieval-stats";
import { createDefaultRegistry } from "../src/pillar1-compression/default-registry";
import { outputCache } from "../src/pillar1-compression/output-cache";

const tmpHome = mkdtempSync(join(tmpdir(), "knapsack-rp-manual-"));
process.env.KNAPSACK_HOME = tmpHome;

const db = await createDB(`${tmpHome}/memory.db`);
const registry = createDefaultRegistry();
const store = {
	dbPath: `${tmpHome}/memory.db`,
	vaultPath: null,
	projectRoot: "/fake",
	sessionId: "test",
} as never;

const findOutput = Array.from({ length: 400 }, (_, i) => `./src/module_${i}/file.c`).join("\n");
const jsonOutput = JSON.stringify(
	Array.from({ length: 200 }, (_, i) => ({ id: i, name: `User_${i}` })),
);

console.log("=== Retrieval Pressure Learning Test ===\n");

// Phase 1: Compress 35 find outputs (no retrieval)
console.log("1. Compressing 35 find outputs (no retrieval)...");
for (let i = 0; i < 35; i++) {
	outputCache.clear();
	await compress({ text: findOutput, toolName: "find", db, store, registry });
}
let stats = loadRetrievalStats(db);
console.log(
	`   find: ${stats.find?.compressions} compressions, ${stats.find?.retrievals} retrievals`,
);
console.log(`   Rate: ${(getRetrievalRate(stats, "find") * 100).toFixed(1)}%`);
console.log(
	`   Adaptive MAX_SAMPLES: ${getAdaptiveMaxSamples(stats, "find")} (expect 1 — aggressive)`,
);
console.log(`   ✅ ${getAdaptiveMaxSamples(stats, "find") === 1 ? "PASS" : "FAIL"}\n`);

// Phase 2: Compress 35 json outputs, retrieve 8
console.log("2. Compressing 35 json outputs, retrieving 8...");
const jsonHashes: string[] = [];
for (let i = 0; i < 35; i++) {
	outputCache.clear();
	const result = await compress({ text: jsonOutput, toolName: "json", db, store, registry });
	if (result && i < 8) {
		const hashMatch = result.content[1]?.text.match(/hash ([a-f0-9]+)/);
		if (hashMatch?.[1]) jsonHashes.push(hashMatch[1]);
	}
}
for (const hash of jsonHashes) {
	recordRetrieval(db, hash);
}
stats = loadRetrievalStats(db);
console.log(
	`   json: ${stats.json?.compressions} compressions, ${stats.json?.retrievals} retrievals`,
);
console.log(`   Rate: ${(getRetrievalRate(stats, "json") * 100).toFixed(1)}%`);
console.log(
	`   Adaptive MAX_SAMPLES: ${getAdaptiveMaxSamples(stats, "json")} (expect 5 — conservative)`,
);
console.log(`   ✅ ${getAdaptiveMaxSamples(stats, "json") === 5 ? "PASS" : "FAIL"}\n`);

// Phase 3: Show full stats
console.log("3. Full retrieval stats:");
console.log(formatRetrievalStats(stats));
console.log("");

// Phase 4: Verify persistence
console.log("4. Persistence check (reload from DB)...");
const stats2 = loadRetrievalStats(db);
console.log(`   find compressions: ${stats2.find?.compressions} (expect 35)`);
console.log(`   json compressions: ${stats2.json?.compressions} (expect 35)`);
console.log(`   json retrievals: ${stats2.json?.retrievals} (expect ${jsonHashes.length})`);
console.log(
	`   ✅ ${stats2.find?.compressions === 35 && stats2.json?.compressions === 35 ? "PASS" : "FAIL"}\n`,
);

console.log("=== Retrieval pressure test complete ===");
rmSync(tmpHome, { recursive: true, force: true });

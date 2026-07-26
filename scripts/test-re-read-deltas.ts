/**
 * Manual test: Re-read deltas.
 *
 * Verifies that:
 * 1. First read → normal compression
 * 2. Same file re-read unchanged → 3-line marker
 * 3. Same file re-read with changes → unified diff
 * 4. Different file → normal compression (no delta)
 *
 * Usage: npx tsx scripts/test-re-read-deltas.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDB } from "../src/core/database";
import { compress } from "../src/core/pipeline";
import { readTracker } from "../src/core/read-tracker";
import { createDefaultRegistry } from "../src/pillar1-compression/default-registry";
import { outputCache } from "../src/pillar1-compression/output-cache";

const tmpHome = mkdtempSync(join(tmpdir(), "knapsack-rr-test-"));
process.env.KNAPSACK_HOME = tmpHome;

const db = await createDB(`${tmpHome}/memory.db`);
const registry = createDefaultRegistry();
const store = {
	dbPath: `${tmpHome}/memory.db`,
	vaultPath: null,
	projectRoot: "/fake",
	sessionId: "test",
} as never;

const fileContent = Array.from({ length: 200 }, (_, i) => `// line ${i + 1}`).join("\n");

console.log("=== Re-read Deltas Test ===\n");

// 1. First read → normal compression
console.log("1. First read of src/index.ts...");
readTracker.clear();
outputCache.clear();
const r1 = await compress({
	text: fileContent,
	toolName: "read",
	path: "/src/index.ts",
	db,
	store,
	registry,
});
const r1Text = r1?.content.map((b) => b.text).join("") ?? "";
console.log(`   Output length: ${r1Text.length} chars`);
console.log(`   Contains compression footer: ${r1Text.includes("smaller")}`);
console.log(`   ✅ ${r1Text.includes("smaller") ? "PASS" : "FAIL"}\n`);

// 2. Same file re-read unchanged → marker
console.log("2. Re-read same file (unchanged)...");
outputCache.clear();
const r2 = await compress({
	text: fileContent,
	toolName: "read",
	path: "/src/index.ts",
	db,
	store,
	registry,
});
const r2Text = r2?.content.map((b) => b.text).join("") ?? "";
console.log(`   Output: ${r2Text.slice(0, 120)}`);
console.log(`   Contains "re-read": ${r2Text.includes("re-read")}`);
console.log(`   Contains "unchanged": ${r2Text.includes("unchanged")}`);
console.log(`   Length: ${r2Text.length} (vs original ${fileContent.length})`);
const savings2 = Math.round((1 - r2Text.length / fileContent.length) * 100);
console.log(`   Savings: ${savings2}%`);
console.log(
	`   ✅ ${r2Text.includes("re-read") && r2Text.includes("unchanged") ? "PASS" : "FAIL"}\n`,
);

// 3. Same file re-read with changes → diff
console.log("3. Re-read same file (changed)...");
const modifiedContent = `${fileContent.replace("// line 100", "// line 100 — MODIFIED")}\n// new line 201`;
outputCache.clear();
const r3 = await compress({
	text: modifiedContent,
	toolName: "read",
	path: "/src/index.ts",
	db,
	store,
	registry,
});
const r3Text = r3?.content.map((b) => b.text).join("") ?? "";
console.log(`   Output: ${r3Text.slice(0, 200)}`);
console.log(`   Contains "re-read": ${r3Text.includes("re-read")}`);
console.log(`   Contains "changed": ${r3Text.includes("changed")}`);
console.log(`   Contains diff (-): ${r3Text.includes("-// line 100")}`);
console.log(`   Contains diff (+): ${r3Text.includes("+// line 100 — MODIFIED")}`);
console.log(`   Length: ${r3Text.length} (vs original ${modifiedContent.length})`);
const savings3 = Math.round((1 - r3Text.length / modifiedContent.length) * 100);
console.log(`   Savings: ${savings3}%`);
console.log(
	`   ✅ ${r3Text.includes("changed") && r3Text.includes("-// line 100") ? "PASS" : "FAIL"}\n`,
);

// 4. Different file → normal compression
console.log("4. Read different file (src/other.ts)...");
outputCache.clear();
const r4 = await compress({
	text: fileContent,
	toolName: "read",
	path: "/src/other.ts",
	db,
	store,
	registry,
});
const r4Text = r4?.content.map((b) => b.text).join("") ?? "";
console.log(`   Contains "re-read": ${r4Text.includes("re-read")}`);
console.log(`   Contains compression footer: ${r4Text.includes("smaller")}`);
console.log(
	`   ✅ ${!r4Text.includes("re-read") && r4Text.includes("smaller") ? "PASS" : "FAIL"}\n`,
);

console.log("=== Re-read deltas test complete ===");
rmSync(tmpHome, { recursive: true, force: true });

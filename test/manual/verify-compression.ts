import { compressBash } from "../../src/pillar1-compression/strategies/bash";
import { compressFind } from "../../src/pillar1-compression/strategies/find";
import { compressGrep } from "../../src/pillar1-compression/strategies/grep";

// ── Generate realistic build output (600+ lines) ──
const buildLines: string[] = [];
for (let i = 0; i < 300; i++) {
	buildLines.push(`[INFO] [${i}/300] Compiling src/module_${i}.ts...`);
	buildLines.push(`[DEBUG] Processing dependency graph for module_${i}...`);
}
buildLines.push("[WARN] Deprecated import: 'oldAPI' in src/auth.ts:42 — use 'newAPI' instead");
buildLines.push("[WARN] Unused variable 'temp' in src/utils.ts:128");
buildLines.push("[WARN] Implicit any type in src/legacy.ts:15");
buildLines.push(
	"[ERROR] TypeScript compilation failed: src/database.ts:234:12 — Property 'sessionId' does not exist",
);
buildLines.push("  at TypeScriptCompiler.compile (compiler.ts:89)");
buildLines.push("  at BuildPipeline.run (pipeline.ts:156)");
buildLines.push("Build FAILED in 4.2s with 1 error, 3 warnings");
const BUILD_OUTPUT = buildLines.join("\n");

// ── Generate realistic grep output (224 matches) ──
const grepLines: string[] = [];
const dirs = [
	"src/api",
	"src/services",
	"src/db",
	"src/utils",
	"src/auth",
	"src/middleware",
	"test",
	"scripts",
];
const files = [
	"users.ts",
	"orders.ts",
	"payments.ts",
	"auth.ts",
	"middleware.ts",
	"helpers.ts",
	"config.ts",
];
for (const dir of dirs) {
	for (const file of files) {
		for (let i = 0; i < 4; i++) {
			grepLines.push(
				`${dir}/${file}:${10 + i * 20}:  const result = await db.query("SELECT * FROM ${file.replace(".ts", "")} WHERE id = ?", [id]);`,
			);
		}
	}
}
const GREP_OUTPUT = grepLines.join("\n");

// ── Generate realistic find output (251 files) ──
const findLines: string[] = [];
for (let i = 0; i < 100; i++) findLines.push(`src/components/Button_${i}/Button_${i}.tsx`);
for (let i = 0; i < 100; i++) findLines.push(`src/components/Button_${i}/Button_${i}.test.tsx`);
for (let i = 0; i < 50; i++) findLines.push(`src/hooks/useHook_${i}.ts`);
findLines.push("src/index.ts");
const FIND_OUTPUT = findLines.join("\n");

// ═══════════════════════════════════════════════════════════
// TEST 1: BASH COMPRESSION
// ═══════════════════════════════════════════════════════════
console.log("=".repeat(60));
console.log("TEST 1: BASH — 600-line build output with errors");
console.log("=".repeat(60));
const bashResult = compressBash(BUILD_OUTPUT, "", 1);
console.log(`Input:   ${bashResult.originalTokens} tokens (${BUILD_OUTPUT.length} chars)`);
console.log(`Output:  ${bashResult.compressedTokens} tokens (${bashResult.body.length} chars)`);
console.log(`Savings: ${bashResult.savingsPercent}%`);
console.log(`Hash:    ${bashResult.hash}`);
console.log("");
console.log("--- COMPRESSED OUTPUT ---");
console.log(bashResult.body);
console.log("");

const bashChecks: [string, boolean][] = [
	["ERRORS section", bashResult.body.includes("ERRORS")],
	["WARNINGS section", bashResult.body.includes("WARNINGS")],
	["PROGRESS summary", bashResult.body.includes("PROGRESS")],
	["Error message intact", bashResult.body.includes("TypeScript compilation failed")],
	["File path intact", bashResult.body.includes("database.ts")],
	["Exit code", bashResult.body.includes("exit=1")],
	["Warning count", bashResult.body.includes("warnings=3")],
	["Error count", bashResult.body.includes("errors=1")],
	["Deprecated warning", bashResult.body.includes("Deprecated")],
	["compressed < original", bashResult.compressedTokens < bashResult.originalTokens],
	["savings > 80%", bashResult.savingsPercent > 80],
];

for (const [label, ok] of bashChecks) {
	console.log(`  ${ok ? "✅" : "❌"} ${label}`);
}
const bashAllOk = bashChecks.every(([, ok]) => ok);
console.log(`  → ${bashAllOk ? "ALL PASSED" : "SOME FAILED"}`);
console.log("");

// ═══════════════════════════════════════════════════════════
// TEST 2: GREP COMPRESSION
// ═══════════════════════════════════════════════════════════
console.log("=".repeat(60));
console.log("TEST 2: GREP — 224 matches across 8 dirs × 7 files");
console.log("=".repeat(60));
const grepResult = compressGrep(GREP_OUTPUT);
console.log(`Input:   ${grepResult.originalTokens} tokens (${GREP_OUTPUT.length} chars)`);
console.log(`Output:  ${grepResult.compressedTokens} tokens (${grepResult.body.length} chars)`);
console.log(`Savings: ${grepResult.savingsPercent}%`);
console.log("");
console.log("--- COMPRESSED OUTPUT (first 800 chars) ---");
console.log(grepResult.body.slice(0, 800));
console.log("...\n");

const grepChecks: [string, boolean][] = [
	["dir structure", grepResult.body.includes("src/api/")],
	["file counts", grepResult.body.includes("matches in")],
	["compressed < original", grepResult.compressedTokens < grepResult.originalTokens],
	["savings > 50%", grepResult.savingsPercent > 50],
];

for (const [label, ok] of grepChecks) {
	console.log(`  ${ok ? "✅" : "❌"} ${label}`);
}
console.log("");

// ═══════════════════════════════════════════════════════════
// TEST 3: FIND COMPRESSION
// ═══════════════════════════════════════════════════════════
console.log("=".repeat(60));
console.log("TEST 3: FIND — 251 files in 201 dirs");
console.log("=".repeat(60));
const findResult = compressFind(FIND_OUTPUT);
console.log(`Input:   ${findResult.originalTokens} tokens (${FIND_OUTPUT.length} chars)`);
console.log(`Output:  ${findResult.compressedTokens} tokens (${findResult.body.length} chars)`);
console.log(`Savings: ${findResult.savingsPercent}%`);
console.log("");
console.log("--- COMPRESSED OUTPUT (first 400 chars) ---");
console.log(findResult.body.slice(0, 400));
console.log("...\n");

const findChecks: [string, boolean][] = [
	["dir structure", findResult.body.includes("src/components/")],
	["collapse indicator", findResult.body.includes("+") || findResult.body.includes("more")],
	["compressed < original", findResult.compressedTokens < findResult.originalTokens],
	["savings > 50%", findResult.savingsPercent > 50],
];

for (const [label, ok] of findChecks) {
	console.log(`  ${ok ? "✅" : "❌"} ${label}`);
}
console.log("");

// ═══════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════
console.log("=".repeat(60));
console.log("SUMMARY");
console.log("=".repeat(60));
const totalOrig = bashResult.originalTokens + grepResult.originalTokens + findResult.originalTokens;
const totalComp =
	bashResult.compressedTokens + grepResult.compressedTokens + findResult.compressedTokens;
const totalSaved = totalOrig - totalComp;
const totalPct = Math.round((totalSaved / totalOrig) * 100);

console.log(`Total original:   ${totalOrig} tokens`);
console.log(`Total compressed: ${totalComp} tokens`);
console.log(`Total saved:      ${totalSaved} tokens (${totalPct}%)`);
console.log("");
console.log(
	`Bash:  ${bashResult.originalTokens} → ${bashResult.compressedTokens} (${bashResult.savingsPercent}%)`,
);
console.log(
	`Grep:  ${grepResult.originalTokens} → ${grepResult.compressedTokens} (${grepResult.savingsPercent}%)`,
);
console.log(
	`Find:  ${findResult.originalTokens} → ${findResult.compressedTokens} (${findResult.savingsPercent}%)`,
);

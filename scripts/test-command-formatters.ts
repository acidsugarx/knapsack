/**
 * Manual test: per-command formatters with real outputs.
 *
 * Usage: npx tsx scripts/test-command-formatters.ts
 */

import { formatCommandOutput } from "../src/core/command-formatters/index";

function test(name: string, command: string, output: string) {
	const result = formatCommandOutput({ output, command });
	console.log(
		`${name}: ${result ? `${result.strategy} — ${result.savingsPercent}% saved (${result.originalTokens}→${result.compressedTokens} tokens)` : "no match (falls through)"}`,
	);
}

// git status
const gitStatus = [
	"On branch main",
	"Changes not staged for commit:",
	"  modified:   src/index.ts",
	"  modified:   src/utils.ts",
	"",
	"Untracked files:",
	"  src/newfile.ts",
	"",
	"no changes added to commit",
].join("\n");

// git diff
const gitDiff = [
	"diff --git a/src/index.ts b/src/index.ts",
	"index a1b2c3d..d4e5f6g 100644",
	"--- a/src/index.ts",
	"+++ b/src/index.ts",
	"@@ -10,3 +10,5 @@",
	" import { foo } from './bar';",
	"+import { baz } from './qux';",
	"+",
	"+export function main() {",
	"   return foo();",
	" }",
].join("\n");

// npm install
const npmInstall = [
	"npm warn deprecated left-pad@1.0.0: use String.prototype.padStart",
	"",
	"added 127 packages, removed 3 packages, changed 5 packages, and audited 312 packages in 12s",
	"",
	"45 vulnerabilities (2 low, 10 moderate, 30 high, 3 critical)",
].join("\n");

// pytest
const pytest = [
	"============================= test session starts ==============================",
	"collected 50 items",
	"",
	"test_foo.py::test_pass_1 PASSED",
	"test_foo.py::test_pass_2 PASSED",
	"...",
	"test_bar.py::test_fail_1 FAILED",
	"test_bar.py::test_fail_2 FAILED",
	"",
	"============================= FAILURES =============================",
	"______________________________ test_fail_1 ______________________________",
	"    def test_fail_1():",
	">       assert 1 == 2",
	"E       assert 1 == 2",
	"",
	"============================= short test summary ==============================",
	"FAILED test_bar.py::test_fail_1 - assert 1 == 2",
	"FAILED test_bar.py::test_fail_2 - assert 3 == 4",
	"48 passed, 2 failed in 2.34s",
].join("\n");

// cargo build
const cargoBuild = [
	"   Compiling my-crate v0.1.0",
	"error[E0308]: mismatched types",
	"  --> src/lib.rs:10:5",
	"   |",
	"10 |     expects_u32(x)",
	"   |     ^^^^^^^^^^^^ expected `u32`, found `String`",
	"",
	"error: could not compile `my-crate` due to previous error",
].join("\n");

// jest
const jestOutput = [
	"PASS  src/foo.test.ts",
	"PASS  src/bar.test.ts",
	"FAIL  src/baz.test.ts",
	"  ● baz",
	"    expect(received).toBe(expected)",
	"",
	"    Expected: 5",
	"    Received: 3",
	"",
	"      10 | it('baz', () => {",
	"      11 |   expect(baz()).toBe(5);",
	"",
	"Tests: 2 passed, 1 failed, 3 total",
	"Test Suites: 1 failed, 2 passed, 3 total",
].join("\n");

// vitest
const vitestOutput = [
	" ✓ src/foo.test.ts (3 tests) 5ms",
	" ✓ src/bar.test.ts (2 tests) 3ms",
	" × src/baz.test.ts (1 test) 12ms",
	"   → expected 5, got 3",
	"",
	" Test Files  2 passed (2)",
	"      Tests  5 passed (5)",
].join("\n");

// go test
const goTest = [
	"=== RUN   TestPass",
	"--- PASS: TestPass (0.00s)",
	"=== RUN   TestFail",
	"--- FAIL: TestFail (0.00s)",
	"    foo_test.go:10: expected 5, got 3",
	"FAIL",
	"FAIL\texample.com/pkg\t0.123s",
].join("\n");

test("git status", "git status", gitStatus);
test("git diff", "git diff", gitDiff);
test("npm install", "npm install", npmInstall);
test("pytest", "pytest test_foo.py", pytest);
test("cargo build", "cargo build", cargoBuild);
test("jest", "npx jest", jestOutput);
test("vitest", "npx vitest run", vitestOutput);
test("go test", "go test ./...", goTest);

console.log("\nDone.");

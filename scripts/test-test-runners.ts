/**
 * Manual test: test runner filters (pytest, jest, vitest, cargo test, go test).
 *
 * Usage: npx tsx scripts/test-test-runners.ts
 */

import { formatJest, formatVitest } from "../src/core/command-formatters/javascript";
import { formatPytest } from "../src/core/command-formatters/python";
import { formatCargoTest } from "../src/core/command-formatters/rust";
import { formatGoTest } from "../src/core/command-formatters/test-runners";

function test(name: string, result: ReturnType<typeof formatPytest>, expectedSavings: number) {
	const status = result
		? result.savingsPercent >= expectedSavings
			? "PASS"
			: `FAIL (savings ${result.savingsPercent}% < ${expectedSavings}%)`
		: "FAIL (no result)";
	console.log(`${name}: ${status}${result ? ` — ${result.savingsPercent}% saved` : ""}`);
	if (result) console.log(`  ${String(result.body).slice(0, 200)}`);
}

const pytestOutput = [
	"============================= test session starts ==============================",
	"collected 50 items",
	"test_pass.py::test_a PASSED [ 2%]",
	"test_pass.py::test_b PASSED [ 4%]",
	"... 46 more passing ...",
	"test_fail.py::test_1 FAILED [ 96%]",
	"test_fail.py::test_2 FAILED [ 98%]",
	"",
	"============================= FAILURES =============================",
	"____________________________ test_1 __________________________________",
	"    def test_1():",
	">       assert get_value() == 42",
	"E       assert 0 == 42",
	"",
	"test_fail.py:10: AssertionError",
	"============================= short test summary ==============================",
	"FAILED test_fail.py::test_1 - assert 0 == 42",
	"FAILED test_fail.py::test_2 - assert 1 == 2",
	"48 passed, 2 failed in 2.34s",
].join("\n");

const jestOutput = [
	"PASS  src/a.test.ts",
	"PASS  src/b.test.ts",
	"FAIL  src/c.test.ts",
	"  ● c › should work",
	"    expect(received).toBe(expected)",
	"    Expected: 5",
	"    Received: 3",
	"Tests: 2 passed, 1 failed, 3 total",
].join("\n");

const vitestOutput = [
	" ✓ src/a.test.ts (2 tests) 3ms",
	" × src/b.test.ts (1 test) 8ms",
	"   → expected true, got false",
	" Test Files 1 passed, 1 failed (2)",
	"      Tests 2 passed, 1 failed (3)",
].join("\n");

const cargoTestOutput = [
	"running 5 tests",
	"test test_a ... ok",
	"test test_b ... ok",
	"test test_c ... FAILED",
	"test test_d ... ok",
	"test test_e ... ignored",
	"",
	"---- test_c stdout ----",
	"thread 'test_c' panicked at 'assertion failed: 2 + 2 == 5', src/lib.rs:10",
	"note: run with RUST_BACKTRACE=1 for more",
	"failures:",
	"    test_c",
	"",
	"test result: FAILED. 3 passed, 1 failed, 1 ignored",
].join("\n");

const goTestOutput = [
	"=== RUN   TestValid",
	"--- PASS: TestValid (0.00s)",
	"=== RUN   TestInvalid",
	"--- FAIL: TestInvalid (0.00s)",
	"    validate_test.go:15: expected nil error, got: invalid input",
	"=== RUN   TestSkip",
	"--- SKIP: TestSkip (0.00s)",
	"FAIL",
	"FAIL\texample.com/pkg\t0.050s",
].join("\n");

test("pytest (2 failures, 48 passed)", formatPytest(pytestOutput), 80);
test("jest (1 failure, 2 passed)", formatJest(jestOutput), 50);
test("vitest (1 failure, 2 passed)", formatVitest(vitestOutput), 50);
test("cargo test (1 failure, 3 passed)", formatCargoTest(cargoTestOutput), 50);
test("go test (1 failure, 1 passed)", formatGoTest(goTestOutput), 50);

console.log("\nDone.");

/**
 * Test runner formatters — parse test runner output (pytest, jest, vitest,
 * cargo test, go test) and extract failures + summary, collapsing passing
 * tests to a count.
 *
 * Individual formatters are implemented in per-language files (npm.ts,
 * python.ts, rust.ts). This module re-exports them for discoverability
 * and adds go test support.
 *
 * @module test-runners
 */

import type { CompressionResult } from "../types";
import { makeResult } from "./index";

export { formatJest, formatVitest, matchJest, matchVitest } from "./javascript";
export { formatPytest, matchPytest } from "./python";
export { formatCargoTest, matchCargo } from "./rust";

/**
 * Check if a command runs `go test`.
 *
 * @param command - Shell command string
 * @returns true if the command is a go test invocation
 */
export function matchGoTest(command: string): boolean {
	return /\bgo\s+test\b/.test(command.trim());
}

/**
 * Format `go test` output — failures only, passing tests collapsed to count.
 *
 * Go test output format:
 * ```
 * --- FAIL: TestFoo (0.00s)
 *     foo_test.go:10: expected 5, got 3
 * FAIL
 * FAIL    example.com/pkg    0.123s
 * ```
 *
 * @param output - Raw go test output
 * @returns CompressionResult or null if not recognizable go test output
 */
export function formatGoTest(output: string): CompressionResult | null {
	if (!output.includes("--- ") && !output.includes("FAIL\t") && !output.includes("ok  \t")) {
		return null;
	}

	const lines = output.split("\n");
	const kept: string[] = [];
	let passCount = 0;
	let failCount = 0;
	let skipCount = 0;
	let inFailure = false;

	for (const line of lines) {
		const trimmed = line.trim();

		// Package-level result lines
		if (/^ok\s+\S+\s/.test(trimmed)) {
			const timeMatch = trimmed.match(/ok\s+\S+\s+(.+s)/);
			passCount++;
			if (timeMatch) kept.push(trimmed);
			continue;
		}

		if (/^FAIL\s+\S+\s/.test(trimmed) && !trimmed.includes("---")) {
			failCount++;
			kept.push(trimmed);
			continue;
		}

		// Failure details
		if (trimmed.startsWith("--- FAIL:")) {
			inFailure = true;
			kept.push(line);
			continue;
		}

		if (trimmed.startsWith("--- PASS:") || trimmed.startsWith("--- SKIP:")) {
			inFailure = false;
			if (trimmed.startsWith("--- SKIP:")) skipCount++;
			continue;
		}

		if (inFailure) {
			kept.push(line);
			continue;
		}

		// Summary lines
		if (trimmed.startsWith("FAIL") && !trimmed.includes("---")) {
			if (trimmed === "FAIL") kept.push(trimmed);
			continue;
		}

		// Test output lines in failure context
		if (trimmed.includes("Error Trace:") || trimmed.includes("Error:")) {
			kept.push(line);
		}
	}

	if (passCount === 0 && failCount === 0 && kept.length === 0) return null;

	const parts: string[] = ["── go test ──"];
	if (passCount > 0) parts.push(`Passed: ${passCount}`);
	if (failCount > 0) parts.push(`Failed: ${failCount}`);
	if (skipCount > 0) parts.push(`Skipped: ${skipCount}`);

	if (kept.length > 0) {
		parts.push("", "── Results ──", ...kept);
	}

	return makeResult(parts.join("\n"), output, "go-test");
}

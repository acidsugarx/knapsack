/**
 * @module error-extractor-test
 */

import { describe, expect, it } from "vitest";
import { extractErrors, formatErrorBlock } from "../../src/core/error-extractor";

describe("extractErrors", () => {
	it("extracts [ERROR] lines from npm test output", () => {
		const output = [
			"PASS  src/foo.test.ts",
			"PASS  src/bar.test.ts",
			"[ERROR] Failed to compile src/baz.ts",
			"[ERROR] Module not found: './missing'",
			"PASS  src/qux.test.ts",
		].join("\n");

		const result = extractErrors(output);
		expect(result.errors).toContain("[ERROR] Failed to compile");
		expect(result.errors).toContain("Module not found");
		expect(result.warnings).toBe("");
		expect(result.truncated).toBe(false);
	});

	it("extracts Traceback from Python stack trace", () => {
		const output = [
			"Traceback (most recent call last):",
			'  File "app.py", line 42, in <module>',
			"    main()",
			'  File "app.py", line 15, in main',
			"    raise ValueError('bad input')",
			"ValueError: bad input",
		].join("\n");

		const result = extractErrors(output);
		expect(result.errors).toContain("Traceback");
		expect(result.errors).toContain("ValueError:");
	});

	it("extracts panic/fatal from Go output", () => {
		const output = [
			"panic: runtime error: invalid memory address",
			"",
			"goroutine 1 [running]:",
			"main.main()",
			"\t/path/to/main.go:10 +0x25",
		].join("\n");

		const result = extractErrors(output);
		expect(result.errors).toContain("panic: runtime error");
	});

	it("returns empty errors for empty output", () => {
		const result = extractErrors("");
		expect(result.errors).toBe("");
		expect(result.warnings).toBe("");
		expect(result.truncated).toBe(false);
	});

	it("returns empty errors for clean output", () => {
		const output = [
			"Compiling src/index.ts",
			"Compiling src/utils.ts",
			"Build completed in 2.3s",
		].join("\n");

		const result = extractErrors(output);
		expect(result.errors).toBe("");
		expect(result.warnings).toBe("");
	});

	it("extracts warnings separately from errors", () => {
		const output = [
			"[WARN] Deprecated API usage",
			"[ERROR] Build failed",
			"[WARN] Unused variable 'x'",
		].join("\n");

		const result = extractErrors(output);
		expect(result.errors).toContain("[ERROR] Build failed");
		expect(result.warnings).toContain("[WARN] Deprecated API usage");
		expect(result.warnings).toContain("[WARN] Unused variable");
	});

	it("caps errors at 2000 characters and sets truncated flag", () => {
		const longError = `Error: ${"x".repeat(2100)}`;
		const result = extractErrors(longError);
		expect(result.truncated).toBe(true);
		expect(result.errors.length).toBeLessThanOrEqual(2100);
		expect(result.errors).toContain("[truncated]");
	});
});

describe("formatErrorBlock", () => {
	it("formats errors with hash reference", () => {
		const block = formatErrorBlock("Error: something broke", "", "abc123");
		expect(block).toContain("── COMMAND FAILED ──");
		expect(block).toContain("Error: something broke");
		expect(block).toContain('knapsack_retrieve("abc123")');
	});

	it("formats errors and warnings together", () => {
		const block = formatErrorBlock("Error: fail", "Warning: deprecated", "abc123");
		expect(block).toContain("**Errors:**");
		expect(block).toContain("**Warnings:**");
		expect(block).toContain("Error: fail");
		expect(block).toContain("Warning: deprecated");
	});

	it("shows fallback message when no error markers found", () => {
		const block = formatErrorBlock("", "", "abc123");
		expect(block).toContain("no error markers detected");
		expect(block).toContain('knapsack_retrieve("abc123")');
	});
});

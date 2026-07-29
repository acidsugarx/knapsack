/**
 * @module safety-router-test
 */

import { describe, expect, it } from "vitest";
import { checkSafety } from "../../src/core/safety-router";

describe("checkSafety", () => {
	it("detects JavaScript stack traces", () => {
		const output = [
			"Error: something went wrong",
			"    at Object.<anonymous> (/path/to/file.ts:10:5)",
			"    at Module._compile (node:internal/modules/cjs/loader:123:45)",
		].join("\n");

		const result = checkSafety(output, "bash");
		expect(result.shouldPassthrough).toBe(true);
		expect(result.reason).toBe("stack trace");
	});

	it("detects Python Traceback", () => {
		const output = [
			"Traceback (most recent call last):",
			'  File "app.py", line 10, in <module>',
			"    main()",
			"ValueError: invalid argument",
		].join("\n");

		const result = checkSafety(output, "bash");
		expect(result.shouldPassthrough).toBe(true);
		expect(result.reason).toBe("stack trace");
	});

	it("detects Go panic", () => {
		const output = "panic: runtime error: index out of range [0] with length 0";

		const result = checkSafety(output, "bash");
		expect(result.shouldPassthrough).toBe(true);
		expect(result.reason).toBe("stack trace");
	});

	it("detects PEM private keys", () => {
		const output = [
			"-----BEGIN RSA PRIVATE KEY-----",
			"MIIEpAIBAAKCAQEA...",
			"-----END RSA PRIVATE KEY-----",
		].join("\n");

		const result = checkSafety(output, "bash");
		expect(result.shouldPassthrough).toBe(true);
		expect(result.reason).toBe("private key");
	});

	it("detects SQL migration statements", () => {
		const output = [
			"CREATE TABLE users (",
			"  id INTEGER PRIMARY KEY,",
			"  name TEXT NOT NULL",
			");",
		].join("\n");

		const result = checkSafety(output, "bash");
		expect(result.shouldPassthrough).toBe(true);
		expect(result.reason).toBe("SQL migration");
	});

	it("allows normal shell output through", () => {
		const output = [
			"total 24",
			"drwxr-xr-x  5 user  staff  160 Jul 29 12:00 .",
			"drwxr-xr-x 12 user  staff  384 Jul 29 12:00 ..",
		].join("\n");

		const result = checkSafety(output, "bash");
		expect(result.shouldPassthrough).toBe(false);
	});

	it("allows normal grep output through", () => {
		const output = [
			"src/index.ts:10:import { foo } from './bar'",
			"src/utils.ts:42:export function baz() {",
		].join("\n");

		const result = checkSafety(output, "grep");
		expect(result.shouldPassthrough).toBe(false);
	});

	it("returns false for empty string", () => {
		const result = checkSafety("", "bash");
		expect(result.shouldPassthrough).toBe(false);
	});

	it("detects binary data via control character ratio", () => {
		const binary = "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x00".repeat(50);
		const result = checkSafety(binary, "bash");
		expect(result.shouldPassthrough).toBe(true);
		expect(result.reason).toBe("binary data");
	});

	it("allows output with occasional null bytes through", () => {
		// Text with a few null bytes but mostly printable — should pass
		const mostlyText =
			"Hello\x00World\x00\nMore text here with normal content that is mostly printable\n".repeat(
				10,
			);
		const result = checkSafety(mostlyText, "bash");
		expect(result.shouldPassthrough).toBe(false);
	});
});

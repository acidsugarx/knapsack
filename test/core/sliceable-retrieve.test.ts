import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cache, retrieve } from "../../src/pillar1-compression/ccr";

function tmpHome(): string {
	const dir = join(tmpdir(), `knapsack-ccr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const SAMPLE_OUTPUT = [
	"INFO  Starting build",
	"WARN  Deprecated config option 'legacy'",
	"INFO  Compiling module A",
	"ERROR Failed to compile module B: type mismatch",
	"INFO  Compiling module C",
	"INFO  Compiling module D",
	"ERROR Missing dependency 'lodash' in package.json",
	"WARN  Unused import in module E",
	"INFO  Compiling module F",
	"FATAL Build aborted due to errors",
	"INFO  Shutting down",
].join("\n");

describe("sliceable CCR retrieve", () => {
	let home: string;

	beforeEach(() => {
		home = tmpHome();
		cache(home, null, "a1b2c3d4e5f6", SAMPLE_OUTPUT);
	});

	afterEach(() => {
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("returns full original when no options provided (backward compat)", () => {
		const result = retrieve(home, null, "a1b2c3d4e5f6");
		expect(result).toBe(SAMPLE_OUTPUT);
	});

	it("grep returns only lines matching pattern (case-insensitive)", () => {
		const result = retrieve(home, null, "a1b2c3d4e5f6", { grep: "ERROR" });
		expect(result).not.toBeNull();
		expect(result).toContain("RETRIEVED");
		expect(result).toContain('grep="ERROR"');
		expect(result).toContain("Failed to compile module B");
		expect(result).toContain("Missing dependency");
		expect(result).not.toContain("INFO");
		expect(result).not.toContain("WARN");
	});

	it("grep with no matches returns empty result", () => {
		const result = retrieve(home, null, "a1b2c3d4e5f6", { grep: "NONEXISTENT" });
		expect(result).not.toBeNull();
		expect(result).toContain("RETRIEVED");
		expect(result).toContain('grep="NONEXISTENT", 0/11 lines');
	});

	it("lines returns specific range", () => {
		const result = retrieve(home, null, "a1b2c3d4e5f6", { lines: "3-5" });
		expect(result).not.toBeNull();
		expect(result).toContain("RETRIEVED");
		expect(result).toContain("lines=3-5");
		expect(result).toContain("Compiling module A");
		expect(result).toContain("Failed to compile module B");
		expect(result).toContain("Compiling module C");
		expect(result).not.toContain("Starting build");
		expect(result).not.toContain("Deprecated config");
	});

	it("lines range beyond file length returns what exists", () => {
		const result = retrieve(home, null, "a1b2c3d4e5f6", { lines: "9-20" });
		expect(result).not.toBeNull();
		// Should contain lines 9-11 only (total is 11)
		expect(result).toContain("Compiling module F");
		expect(result).toContain("Build aborted");
		expect(result).toContain("Shutting down");
	});

	it("head returns first N lines", () => {
		const result = retrieve(home, null, "a1b2c3d4e5f6", { head: 3 });
		expect(result).not.toBeNull();
		expect(result).toContain("head=3");
		expect(result).toContain("Starting build");
		expect(result).toContain("Deprecated config option");
		expect(result).toContain("Compiling module A");
		expect(result).not.toContain("Failed to compile");
	});

	it("tail returns last N lines", () => {
		const result = retrieve(home, null, "a1b2c3d4e5f6", { tail: 3 });
		expect(result).not.toBeNull();
		expect(result).toContain("tail=3");
		expect(result).toContain("Compiling module F");
		expect(result).toContain("Build aborted");
		expect(result).toContain("Shutting down");
		expect(result).not.toContain("Starting build");
	});

	it("grep + head combined returns first N matching lines", () => {
		const result = retrieve(home, null, "a1b2c3d4e5f6", { grep: "ERROR", head: 1 });
		expect(result).not.toBeNull();
		expect(result).toContain('grep="ERROR"');
		expect(result).toContain("head=1");
		expect(result).toContain("Failed to compile module B");
		expect(result).not.toContain("Missing dependency");
	});

	it("returns null for invalid hash", () => {
		const result = retrieve(home, null, "zzzzz");
		expect(result).toBeNull();
	});

	it("returns null for missing hash", () => {
		const result = retrieve(home, null, "deadbeefdeadbeef");
		expect(result).toBeNull();
	});

	it("handles invalid lines range gracefully", () => {
		const result = retrieve(home, null, "a1b2c3d4e5f6", { lines: "abc" });
		expect(result).not.toBeNull();
		// When range is invalid, full content is returned unchanged
		expect(result).toContain("Starting build");
		expect(result).toContain("Shutting down");
	});
});

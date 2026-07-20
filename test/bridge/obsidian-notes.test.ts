import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readNoteText, writeNote } from "../../src/bridge/obsidian-notes.js";

/**
 * Security-critical surface: every path built from LLM-controlled input
 * (note title) must be validated against the vault root before any
 * filesystem write or read. AGENTS.md: "No path joins without validation."
 */
describe("obsidian-notes path safety", () => {
	let vault: string;

	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "knapsack-vault-"));
	});

	afterEach(() => {
		try {
			const fs = require("node:fs");
			fs.rmSync(vault, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("rejects path-traversal titles (../../../etc/cron.d/x)", () => {
		const result = writeNote(vault, "../../../etc/cron.d/knapsack_probe", "payload");
		expect(result).toBeNull();
	});

	it("normalises absolute path titles to a safe in-vault filename", () => {
		// `/etc/passwd` sanitises to `-etc-passwd` — a valid in-vault filename,
		// not a traversal. The original `/` is gone, so it cannot escape.
		const result = writeNote(vault, "/etc/passwd", "payload");
		expect(result).not.toContain("/");
		expect(result).not.toContain("..");
	});

	it("normalises Windows-style backslash titles to a safe in-vault filename", () => {
		// sanitizeTitle replaces path separators with `-`, so the result is a
		// valid filename under the vault root — no traversal risk.
		const result = writeNote(vault, "sub\\dir\\note", "payload");
		expect(result).not.toBeNull();
		expect(result).not.toContain("..");
	});

	it("writes a normal note under the vault root and returns the relative path", () => {
		const result = writeNote(vault, "PostgreSQL Pooling", "## How it works");
		expect(result).toBe("PostgreSQL Pooling.md");
		const written = readFileSync(join(vault, "PostgreSQL Pooling.md"), "utf8");
		expect(written).toContain("How it works");
	});

	it("readNoteText returns null for traversal titles (no outside-vault read)", () => {
		// `../../../etc/passwd` sanitises to `----etc-passwd` which is a valid
		// in-vault filename — but the file does not exist in the vault, so the
		// read returns null rather than reaching outside.
		const result = readNoteText(vault, "../../../etc/passwd");
		expect(result).toBeNull();
	});

	it("returns null when vaultPath is null", () => {
		expect(writeNote(null, "anything", "x")).toBeNull();
		expect(readNoteText(null, "anything")).toBeNull();
	});
});

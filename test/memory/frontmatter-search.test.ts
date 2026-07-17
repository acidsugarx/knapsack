import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatVaultHits, searchVaultWithFrontmatter } from "../../src/bridge/obsidian.js";

describe("frontmatter-aware vault search", () => {
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

	it("attaches frontmatter to matches in markdown notes", () => {
		writeFileSync(
			join(vault, "decision.md"),
			[
				"---",
				"title: Use sql.js",
				"tags:",
				"  - storage",
				"  - wasm",
				"importance: 0.9",
				"---",
				"",
				"We chose sql.js because better-sqlite3 needs native compilation.",
			].join("\n"),
		);

		const hits = searchVaultWithFrontmatter(vault, "sql.js", 10);
		expect(hits).not.toBeNull();
		expect(hits?.length).toBe(1);
		const hit = hits?.[0];
		expect(hit?.frontmatter).toBeDefined();
		expect(hit?.frontmatter?.title).toBe("Use sql.js");
		expect(hit?.frontmatter?.importance).toBe("0.9");
		expect(hit?.frontmatter?.tags).toEqual(["storage", "wasm"]);
	});

	it("returns hits without frontmatter when the file has no frontmatter block", () => {
		writeFileSync(join(vault, "plain.md"), "no frontmatter here\njust plain text about sql.js\n");
		const hits = searchVaultWithFrontmatter(vault, "sql.js", 10);
		expect(hits?.length).toBe(1);
		expect(hits?.[0]?.frontmatter).toBeUndefined();
	});

	it("formatVaultHits renders a single-line summary per match", () => {
		writeFileSync(
			join(vault, "note.md"),
			"---\ntags:\n  - a\n  - b\n---\n\nmentions sql.js here\n",
		);
		const hits = searchVaultWithFrontmatter(vault, "sql.js", 10);
		const rendered = formatVaultHits(hits);
		expect(rendered).toContain("note.md");
		expect(rendered).toContain("tags=a|b");
		expect(rendered).toContain("sql.js");
	});

	it("formatVaultHits handles empty input without throwing", () => {
		expect(formatVaultHits(null)).toBe("(no matches)");
		expect(formatVaultHits([])).toBe("(no matches)");
	});
});

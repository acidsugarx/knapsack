import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDB } from "../../src/core/database.js";

describe("memory consolidation", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "knapsack-mem-"));
	});

	afterEach(() => {
		try {
			const fs = require("node:fs");
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("merges a near-duplicate instead of inserting a new row", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		const first = db.saveMemory({
			content: "Use sql.js for SQLite because better-sqlite3 needs native compilation",
			type: "decision",
			importance: 0.7,
		});
		const before = db.getAllMemories();
		expect(before.length).toBe(1);

		// Same decision, rephrased — should consolidate into the existing row.
		const second = db.saveMemory({
			content:
				"Use sql.js for SQLite because better-sqlite3 needs native compilation, fails on Node 26",
			type: "decision",
			importance: 0.5,
		});

		const after = db.getAllMemories();
		expect(after.length).toBe(1); // no duplicate inserted
		expect(second.id).toBe(first.id); // merged into the existing row
		// Longer content wins, importance is bumped above the original 0.7.
		expect(second.content).toContain("fails on Node 26");
		expect(second.importance).toBeGreaterThan(0.7);
		db.close();
	});

	it("keeps separate rows when content is genuinely different", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		db.saveMemory({
			content: "Use sql.js for SQLite persistence — no native deps",
			type: "decision",
		});
		db.saveMemory({
			content: "Tree-sitter grammars must come from the grammar npm package, not tree-sitter-wasms",
			type: "gotcha",
		});
		expect(db.getAllMemories().length).toBe(2);
		db.close();
	});

	it("does not merge across types", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		// Identical content but different type — keep both, they classify differently.
		db.saveMemory({ content: "knapsack uses sql.js for storage", type: "fact" });
		db.saveMemory({ content: "knapsack uses sql.js for storage", type: "convention" });
		expect(db.getAllMemories().length).toBe(2);
		db.close();
	});
});

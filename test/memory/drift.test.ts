import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDB } from "../../src/core/database.js";
import { checkDrift } from "../../src/pillar2-memory/drift.js";

describe("drift substring matching", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "knapsack-drift-"));
	});

	afterEach(() => {
		try {
			const fs = require("node:fs");
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	async function seedAnchor(statement: string, signals: string[], project?: string): Promise<void> {
		const db = await createDB(join(tmpHome, "mem.db"));
		db.saveMemory({
			content: `[anchor] ${statement} | signals: ${signals.join(", ")}`,
			type: "constraint",
			scope: "project",
			project,
			importance: 0.9,
		});
		db.close();
	}

	it("does NOT flag negation contexts (no/without/avoid X)", async () => {
		await seedAnchor("Use FTS5, not pgvector", ["pgvector"]);
		const db = await createDB(join(tmpHome, "mem.db"));
		try {
			// Real negation — should not trigger.
			expect(checkDrift(db, "we have no pgvector in this project")).toEqual([]);
			expect(checkDrift(db, "the codebase is pgvector-free")).toEqual([]);
			expect(checkDrift(db, "without pgvector we save a dependency")).toEqual([]);
			expect(checkDrift(db, "avoid pgvector when sqlite suffices")).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("flags a real violation (signal in positive context)", async () => {
		await seedAnchor("Use FTS5, not pgvector", ["pgvector"]);
		const db = await createDB(join(tmpHome, "mem.db"));
		try {
			const detected = checkDrift(db, "we just enabled pgvector for full-text search");
			expect(detected.length).toBe(1);
			expect(detected[0]?.matchedSignals).toContain("pgvector");
		} finally {
			db.close();
		}
	});

	it("handles multiple signals across anchors (no cross-talk)", async () => {
		await seedAnchor("Use sql.js", ["better-sqlite3"]);
		await seedAnchor("No node-gyp", ["node-gyp"]);
		const db = await createDB(join(tmpHome, "mem.db"));
		try {
			const detected = checkDrift(db, "build failed because of node-gyp on Node 26");
			expect(detected.length).toBe(1);
			expect(detected[0]?.matchedSignals).toEqual(["node-gyp"]);
		} finally {
			db.close();
		}
	});
});

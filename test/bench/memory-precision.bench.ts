/**
 * Memory retrieval regression bench — verifies scoring produces expected
 * orderings on a small probe set. Serves as a regression test: if future
 * scoring changes break the expected ordering, this test fails.
 *
 * Run: npx vitest run test/bench/memory-precision.bench.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDB } from "../../src/core/database.js";
import type { KnapsackStore } from "../../src/core/types.js";
import { scoreAndRank } from "../../src/pillar2-memory/scoring.js";

function makeStore(): KnapsackStore {
	return {
		dbPath: "",
		vaultPath: null,
		projectRoot: null,
		sessionId: null,
	} as KnapsackStore;
}

describe("memory retrieval regression", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "knapsack-bench-"));
	});

	afterEach(() => {
		try {
			const fs = require("node:fs");
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("ranks exact-keyword matches above semantic-only matches", async () => {
		const db = await createDB(join(tmpHome, "bench.db"));
		db.saveMemory({
			content: "Use sql.js for WASM SQLite — not better-sqlite3",
			type: "decision",
			importance: 0.8,
		});
		db.saveMemory({
			content: "The database connection pool uses pg",
			type: "fact",
			importance: 0.5,
		});
		db.saveMemory({
			content: "Compression strategies handle bash output",
			type: "fact",
			importance: 0.5,
		});
		db.close();

		const all = [
			{
				id: "1",
				content: "Use sql.js for WASM SQLite — not better-sqlite3",
				type: "decision" as const,
				scope: "project" as const,
				project: null,
				importance: 0.8,
				recency: Date.now(),
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				contentHash: "a",
				sourceSession: null,
				accessCount: 1,
				lastAccessed: null,
			},
			{
				id: "2",
				content: "The database connection pool uses pg",
				type: "fact" as const,
				scope: "project" as const,
				project: null,
				importance: 0.5,
				recency: Date.now(),
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				contentHash: "b",
				sourceSession: null,
				accessCount: 1,
				lastAccessed: null,
			},
		];

		const ranked = await scoreAndRank("sql.js", all, all, 2);
		expect(ranked[0]?.entry.id).toBe("1");
		expect(ranked[1]?.entry.id).toBe("2");
	});

	it("ranks higher-importance entries above lower on ties", async () => {
		const entries = [
			{
				id: "low",
				content: "config file at .env",
				type: "fact" as const,
				scope: "project" as const,
				project: null,
				importance: 0.3,
				recency: Date.now(),
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				contentHash: "c",
				sourceSession: null,
				accessCount: 1,
				lastAccessed: null,
			},
			{
				id: "high",
				content: "config file at .env",
				type: "decision" as const,
				scope: "project" as const,
				project: null,
				importance: 0.9,
				recency: Date.now(),
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				contentHash: "d",
				sourceSession: null,
				accessCount: 1,
				lastAccessed: null,
			},
		];

		const ranked = await scoreAndRank("config", entries, entries, 2);
		expect(ranked[0]?.entry.id).toBe("high");
	});
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDB } from "../../src/core/database.js";
import type { KnapsackStore } from "../../src/core/types.js";
import { memoryInjectHook } from "../../src/pillar2-memory/inject.js";

function makeEvent(prompt: string): any {
	return { prompt };
}

function makeStore(): KnapsackStore {
	return {
		dbPath: "",
		vaultPath: null,
		projectRoot: null,
		sessionId: null,
	} as KnapsackStore;
}

describe("memoryInjectHook", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "knapsack-inject-"));
	});

	afterEach(() => {
		try {
			const fs = require("node:fs");
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("returns undefined when no memories match", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		const result = await memoryInjectHook(makeEvent("anything"), db, makeStore());
		expect(result).toBeUndefined();
		db.close();
	});

	it("returns undefined for an empty prompt", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		db.saveMemory({ content: "use sql.js for storage", type: "fact" });
		const result = await memoryInjectHook(makeEvent(""), db, makeStore());
		expect(result).toBeUndefined();
		db.close();
	});

	it("returns undefined for a stop-word-only prompt", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		db.saveMemory({ content: "use sql.js for storage", type: "fact" });
		// "the and" — all tokens are stop words.
		const result = await memoryInjectHook(makeEvent("the and"), db, makeStore());
		expect(result).toBeUndefined();
		db.close();
	});

	it("injects a memory block when a keyword matches recent entries", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		db.saveMemory({
			content: "Always use sql.js — better-sqlite3 needs native compilation",
			type: "decision",
			importance: 0.9,
		});
		const result = await memoryInjectHook(makeEvent("how do I use sqlite"), db, makeStore());
		expect(result).toBeTruthy();
		expect(result).toContain("Knapsack Memory");
		expect(result).toContain("sql.js");
		db.close();
	});
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDB } from "../../src/core/database.js";

describe("fuzzy zero-match fallback (fff-style)", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "knapsack-fuzzy-"));
	});

	afterEach(() => {
		try {
			const fs = require("node:fs");
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("finds a typo-tolerant match when exact LIKE returns nothing", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		db.saveMemory({
			content: "Always validate the receive window before ack",
			type: "fact",
		});

		// Exact LIKE will not match — query is misspelled.
		const exact = db.searchMemory("recieve", 10);
		expect(exact.length).toBe(0);

		// Fuzzy fallback via 3-gram overlap catches the typo.
		const fuzzy = db.searchMemory("recieve window", 10);
		expect(fuzzy.length).toBeGreaterThan(0);
		expect(fuzzy[0]?.content).toContain("receive");
		db.close();
	});

	it("does not fire when the exact LIKE pass already matched", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		db.saveMemory({ content: "use sql.js for storage", type: "fact" });
		// Exact substring match — fuzzy pass should not be invoked.
		const results = db.searchMemory("sql.js", 10);
		expect(results.length).toBe(1);
		expect(results[0]?.content).toContain("sql.js");
		db.close();
	});
});

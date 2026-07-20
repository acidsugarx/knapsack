import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDB } from "../../src/core/database.js";
import type { KnapsackStore } from "../../src/core/types.js";
import { compactionHook } from "../../src/pillar2-memory/compaction.js";

function makeEvent(opts: { reason?: string; tokenCount?: number; messageCount?: number }): any {
	return {
		reason: opts.reason ?? "threshold",
		preparation: {
			messagesToSummarize: Array.from({ length: opts.messageCount ?? 42 }, () => ({})),
			tokensBefore: opts.tokenCount ?? 50_000,
		},
	};
}

function makeStore(): KnapsackStore {
	return {
		dbPath: "",
		vaultPath: null,
		projectRoot: null,
		sessionId: "test-session",
	} as KnapsackStore;
}

describe("compactionHook", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "knapsack-compaction-"));
	});

	afterEach(() => {
		try {
			const fs = require("node:fs");
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("saves a fact-type memory summarising the pre-compaction state", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		compactionHook(makeEvent({ tokenCount: 12345, messageCount: 7 }), db, makeStore());

		const memories = db.getAllMemories();
		expect(memories.length).toBe(1);
		const m = memories[0];
		expect(m?.type).toBe("fact");
		expect(m?.content).toContain("compaction");
		expect(m?.content).toContain("12345");
		expect(m?.content).toContain("7");
		db.close();
	});

	it("records the compaction reason", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		compactionHook(makeEvent({ reason: "overflow" }), db, makeStore());
		const m = db.getAllMemories()[0];
		expect(m?.content).toContain("overflow");
		db.close();
	});

	it("is a no-op when the event carries no statistics", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		// No preparation.statistics — hook should still save a memory with the
		// reason, just without numbers.
		compactionHook({ reason: "manual", preparation: {} } as any, db, makeStore());
		expect(db.getAllMemories().length).toBe(1);
		db.close();
	});
});

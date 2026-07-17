import { describe, expect, it } from "vitest";
import { scoreAndRank } from "../../src/pillar2-memory/scoring.js";
import type { MemoryEntry } from "../../src/core/types.js";

function mem(opts: Partial<MemoryEntry> & { content: string }): MemoryEntry {
	const now = Date.now();
	return {
		id: opts.id ?? Math.random().toString(36).slice(2),
		content: opts.content,
		type: opts.type ?? "fact",
		scope: opts.scope ?? "project",
		project: opts.project ?? null,
		importance: opts.importance ?? 0.5,
		recency: opts.recency ?? now,
		createdAt: new Date(now).toISOString(),
		updatedAt: new Date(now).toISOString(),
		contentHash: opts.contentHash ?? opts.content,
		sourceSession: opts.sourceSession ?? null,
		accessCount: opts.accessCount ?? 1,
		lastAccessed: opts.lastAccessed ?? null,
	};
}

describe("scoring — frecency boost", () => {
	it("ranks frequently-accessed memories above single-access peers", async () => {
		const base = {
			content: "use sql.js for sqlite storage",
			recency: Date.now(),
			importance: 0.5,
		};
		const entries = [
			mem({ ...base, id: "rare", accessCount: 1 }),
			mem({ ...base, id: "frequent", accessCount: 20 }),
		];
		const ranked = await scoreAndRank("sql.js", entries, entries, 2);
		expect(ranked[0]?.entry.id).toBe("frequent");
		expect(ranked[1]?.entry.id).toBe("rare");
	});
});

describe("scoring — smart-case boost", () => {
	it("boosts entries that preserve the query's uppercase signal", async () => {
		const entries = [
			// lowercase "jwt" — acronym mentioned in passing
			mem({ id: "lower", content: "we use jwt for tokens in the api", importance: 0.5 }),
			// uppercase "JWT" — proper noun form the user typed
			mem({ id: "upper", content: "JWT bearer tokens are validated by auth middleware", importance: 0.5 }),
		];
		const ranked = await scoreAndRank("JWT", entries, entries, 2);
		expect(ranked[0]?.entry.id).toBe("upper");
	});

	it("does not apply the boost when the query has no uppercase", async () => {
		// Both lowercase variants of "jwt" — no case signal to preserve.
		const entries = [
			mem({ id: "a", content: "jwt bearer token here", importance: 0.5 }),
			mem({ id: "b", content: "jwt bearer token there", importance: 0.5 }),
		];
		const ranked = await scoreAndRank("jwt", entries, entries, 2);
		// No smartCaseBoost applied — both have score tied at base BM25.
		expect(ranked[0]?.score).toBe(ranked[1]?.score);
	});
});

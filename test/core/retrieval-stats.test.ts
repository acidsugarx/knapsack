import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnapsackDB } from "../../src/core/database.js";
import { compress } from "../../src/core/pipeline.js";
import {
	formatRetrievalStats,
	getAdaptiveMaxSamples,
	getAdaptiveThresholdMultiplier,
	getRetrievalRate,
	loadRetrievalStats,
	recordCompressionForStats,
	recordRetrieval,
} from "../../src/core/retrieval-stats.js";
import type { KnapsackStore } from "../../src/core/types.js";
import { createDefaultRegistry } from "../../src/pillar1-compression/default-registry.js";
import { outputCache } from "../../src/pillar1-compression/output-cache.js";

function makeStubDb(): KnapsackDB {
	const meta = new Map<string, string>();
	const compressions = new Map<string, { strategy: string }>();
	return {
		recordCompression: (input: { strategy: string; originalHash: string }) => {
			compressions.set(input.originalHash, { strategy: input.strategy });
		},
		getCompressionByHash: (hash: string) => compressions.get(hash) as never,
		searchMemory: () => [],
		getMeta: (key: string) => meta.get(key),
		setMeta: (key: string, value: string) => meta.set(key, value),
	} as unknown as KnapsackDB;
}

function makeStubStore(tmpHome: string): KnapsackStore {
	return {
		dbPath: join(tmpHome, "memory.db"),
		vaultPath: null,
		projectRoot: "/fake/project",
		sessionId: "test-session",
	} as KnapsackStore;
}

describe("retrieval-stats", () => {
	let tmpHome: string;
	let db: KnapsackDB;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "knapsack-rp-test-"));
		db = makeStubDb();
		outputCache.clear();
	});

	afterEach(() => {
		try {
			const fs = require("node:fs");
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("returns empty stats when nothing recorded", () => {
		const stats = loadRetrievalStats(db);
		expect(Object.keys(stats).length).toBe(0);
	});

	it("records compression events per strategy", () => {
		recordCompressionForStats(db, "bash");
		recordCompressionForStats(db, "bash");
		recordCompressionForStats(db, "json");
		const stats = loadRetrievalStats(db);
		expect(stats.bash?.compressions).toBe(2);
		expect(stats.json?.compressions).toBe(1);
	});

	it("records retrieval events and links to strategy via compression table", () => {
		db.recordCompression({ strategy: "bash", originalHash: "abc123" } as never);
		recordCompressionForStats(db, "bash");
		recordRetrieval(db, "abc123");
		const stats = loadRetrievalStats(db);
		expect(stats.bash?.retrievals).toBe(1);
	});

	it("calculates retrieval rate correctly", () => {
		const stats = { bash: { retrievals: 5, compressions: 50 } };
		expect(getRetrievalRate(stats, "bash")).toBe(0.1);
	});

	it("returns 0 rate for unknown strategy", () => {
		expect(getRetrievalRate({}, "unknown")).toBe(0);
	});

	it("returns default max samples for new strategy", () => {
		expect(getAdaptiveMaxSamples({}, "bash")).toBe(3);
	});

	it("returns default max samples below 30 compressions", () => {
		const stats = { bash: { retrievals: 0, compressions: 29 } };
		expect(getAdaptiveMaxSamples(stats, "bash")).toBe(3);
	});

	it("returns aggressive max samples (1) for zero-retrieval after 30+ compressions", () => {
		const stats = { bash: { retrievals: 0, compressions: 50 } };
		expect(getAdaptiveMaxSamples(stats, "bash")).toBe(1);
	});

	it("returns conservative max samples (5) for high-retrieval strategy", () => {
		const stats = { json: { retrievals: 10, compressions: 50 } };
		expect(getAdaptiveMaxSamples(stats, "json")).toBe(5);
	});

	it("returns default threshold multiplier for new strategy", () => {
		expect(getAdaptiveThresholdMultiplier({}, "bash")).toBe(1.0);
	});

	it("returns aggressive threshold (1.2) for zero-retrieval", () => {
		const stats = { bash: { retrievals: 0, compressions: 50 } };
		expect(getAdaptiveThresholdMultiplier(stats, "bash")).toBe(1.2);
	});

	it("returns conservative threshold (0.8) for high-retrieval", () => {
		const stats = { json: { retrievals: 10, compressions: 50 } };
		expect(getAdaptiveThresholdMultiplier(stats, "json")).toBe(0.8);
	});

	it("persists stats across load/save cycle", () => {
		recordCompressionForStats(db, "bash");
		recordCompressionForStats(db, "bash");
		recordRetrieval(db, "nonexistent");

		const stats = loadRetrievalStats(db);
		expect(stats.bash?.compressions).toBe(2);
	});

	it("formatRetrievalStats produces readable output", () => {
		const stats = {
			bash: { retrievals: 2, compressions: 80 },
			json: { retrievals: 8, compressions: 30 },
		};
		const formatted = formatRetrievalStats(stats);
		expect(formatted).toContain("bash: 2/80");
		expect(formatted).toContain("json: 8/30");
		expect(formatted).toContain("%");
	});

	it("integration: compress pipeline records compression stats", async () => {
		const lines: string[] = [];
		for (let i = 0; i < 400; i++) lines.push(`./src/module_${i}/file.c`);
		const output = lines.join("\n");

		await compress({
			text: output,
			toolName: "find",
			db,
			store: makeStubStore(tmpHome),
			registry: createDefaultRegistry(),
		});

		const stats = loadRetrievalStats(db);
		expect(stats.find?.compressions).toBe(1);
	});
});

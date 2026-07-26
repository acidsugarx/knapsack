import { beforeEach, describe, expect, it } from "vitest";
import { DecayDetector, decayDetector } from "../../src/core/decay-detector.js";
import type { MemoryEntry } from "../../src/core/types.js";

function makeMemory(
	id: string,
	importance: number,
	type: MemoryEntry["type"] = "constraint",
): MemoryEntry {
	return {
		id,
		content: `test memory ${id}`,
		type,
		scope: "project",
		project: null,
		importance,
		recency: Date.now(),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		contentHash: id,
		sourceSession: null,
		accessCount: 0,
		lastAccessed: null,
	};
}

describe("DecayDetector", () => {
	let detector: DecayDetector;

	beforeEach(() => {
		detector = new DecayDetector();
	});

	it("starts at turn 0", () => {
		expect(detector.turn).toBe(0);
	});

	it("advances turns", () => {
		detector.advanceTurn();
		detector.advanceTurn();
		expect(detector.turn).toBe(2);
	});

	it("considers never-injected memories as decayed", () => {
		expect(detector.isDecayed("never-seen")).toBe(true);
	});

	it("does not consider freshly-injected memories as decayed", () => {
		detector.advanceTurn();
		detector.recordInjection("m1");
		expect(detector.isDecayed("m1")).toBe(false);
	});

	it("considers memories decayed after 15 turns", () => {
		detector.advanceTurn();
		detector.recordInjection("m1");
		for (let i = 0; i < 14; i++) detector.advanceTurn();
		expect(detector.isDecayed("m1")).toBe(false);
		detector.advanceTurn();
		expect(detector.isDecayed("m1")).toBe(true);
	});

	it("getDecayedMemories filters by importance >= 0.7", () => {
		const memories = [makeMemory("high", 0.9), makeMemory("low", 0.5), makeMemory("mid", 0.7)];
		const decayed = detector.getDecayedMemories(memories);
		expect(decayed.length).toBe(2);
		expect(decayed.find((m) => m.id === "high")).toBeDefined();
		expect(decayed.find((m) => m.id === "mid")).toBeDefined();
		expect(decayed.find((m) => m.id === "low")).toBeUndefined();
	});

	it("getDecayedMemories excludes recently-injected", () => {
		detector.advanceTurn();
		detector.recordInjection("high");
		const memories = [makeMemory("high", 0.9)];
		expect(detector.getDecayedMemories(memories).length).toBe(0);
	});

	it("formatRefreshBlock returns undefined for empty list", () => {
		expect(detector.formatRefreshBlock([])).toBeUndefined();
	});

	it("formatRefreshBlock produces marked output", () => {
		const decayed = [makeMemory("m1", 0.9, "constraint")];
		const block = detector.formatRefreshBlock(decayed);
		expect(block).toBeDefined();
		expect(block).toContain("KNAPSACK_MEMORY_REFRESH");
		expect(block).toContain("⚠️");
		expect(block).toContain("constraint");
		expect(block).toContain("test memory m1");
	});

	it("clear resets turn counter and injected map", () => {
		detector.advanceTurn();
		detector.recordInjection("m1");
		detector.clear();
		expect(detector.turn).toBe(0);
		expect(detector.isDecayed("m1")).toBe(true);
	});
});

describe("decayDetector singleton", () => {
	beforeEach(() => {
		decayDetector.clear();
	});

	it("is a DecayDetector instance", () => {
		expect(decayDetector).toBeInstanceOf(DecayDetector);
	});
});

import { describe, expect, it } from "vitest";
import { optimalK, optimalKCapped } from "../../src/pillar1-compression/adaptive-sizer.js";

describe("adaptive-sizer (Kneedle)", () => {
	it("returns the full count for tiny inputs", () => {
		expect(optimalK([])).toBe(0);
		expect(optimalK(["a"])).toBe(1);
		expect(optimalK(["a", "b", "c", "d"])).toBe(4);
		expect(optimalK(["a", "b", "c", "d", "e", "f", "g", "h"])).toBe(8);
	});

	it("keeps everything when items keep adding new information", () => {
		// Each item introduces a new word — curve is linear, no knee.
		const items = Array.from({ length: 30 }, (_, i) => `unique_topic_${i} files`);
		// Kneedle distance threshold (0.05) should not fire.
		expect(optimalK(items)).toBe(items.length);
	});

	it("drops items when content saturates (repetitive siblings)", () => {
		// First 3 items carry unique information, then 30 near-duplicates.
		const items: string[] = [
			"drivers gpu drm files",
			"kernel sched core files",
			"sound pci hda files",
			...Array.from({ length: 30 }, (_, i) => `drivers gpu drm file ${i}`),
		];
		const k = optimalK(items);
		// The knee should land well below the full count once coverage flattens.
		expect(k).toBeLessThan(items.length);
		expect(k).toBeGreaterThanOrEqual(1);
	});

	it("respects bias multiplier", () => {
		const items: string[] = [
			"drivers gpu drm files",
			"kernel sched core files",
			"sound pci hda files",
			...Array.from({ length: 30 }, (_, i) => `drivers gpu drm file ${i}`),
		];
		const baseline = optimalK(items, 1.0);
		const aggressive = optimalK(items, 0.5);
		const conservative = optimalK(items, 2.0);
		expect(aggressive).toBeLessThanOrEqual(baseline);
		expect(conservative).toBeGreaterThanOrEqual(baseline);
	});

	it("optimalKCapped never exceeds the ceiling", () => {
		const items = Array.from({ length: 50 }, (_, i) => `unique_topic_${i} stuff`);
		expect(optimalKCapped(items, 10)).toBeLessThanOrEqual(10);
		expect(optimalKCapped(items, 5)).toBeLessThanOrEqual(5);
	});

	it("near-total redundancy collapses to a tiny count", () => {
		// Same bigrams repeated — coverage is ~1 almost immediately.
		const items = Array.from({ length: 20 }, () => "same exact text here");
		const k = optimalK(items);
		expect(k).toBeLessThanOrEqual(3);
	});
});

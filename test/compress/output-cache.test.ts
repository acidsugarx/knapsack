import { describe, expect, it } from "vitest";
import { type CachedCompression, OutputCache } from "../../src/pillar1-compression/output-cache.js";

function makeEntry(hash: string): CachedCompression {
	return {
		body: `compressed body for ${hash}`,
		strategy: "bash",
		originalTokens: 1000,
		compressedTokens: 200,
		savingsPercent: 80,
		originalHash: hash,
	};
}

describe("OutputCache", () => {
	it("returns undefined for missing keys", () => {
		const cache = new OutputCache();
		expect(cache.get("nonexistent")).toBeUndefined();
	});

	it("stores and retrieves entries by hash", () => {
		const cache = new OutputCache();
		const entry = makeEntry("abc123");
		cache.set("abc123", entry);
		expect(cache.get("abc123")).toEqual(entry);
	});

	it("tracks hit and miss counts", () => {
		const cache = new OutputCache();
		cache.set("hit", makeEntry("hit"));
		cache.get("hit");
		cache.get("miss");
		const stats = cache.stats();
		expect(stats.hits).toBe(1);
		expect(stats.misses).toBe(1);
	});

	it("evicts least-recently-used entries when full", () => {
		const cache = new OutputCache(3);
		cache.set("a", makeEntry("a"));
		cache.set("b", makeEntry("b"));
		cache.set("c", makeEntry("c"));

		expect(cache.size).toBe(3);
		expect(cache.get("a")).toBeDefined();

		cache.set("d", makeEntry("d"));

		expect(cache.size).toBe(3);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBeDefined();
		expect(cache.get("c")).toBeDefined();
		expect(cache.get("d")).toBeDefined();
	});

	it("promotes entries to most-recently-used on get", () => {
		const cache = new OutputCache(3);
		cache.set("a", makeEntry("a"));
		cache.set("b", makeEntry("b"));
		cache.set("c", makeEntry("c"));

		cache.get("a");

		cache.set("d", makeEntry("d"));

		expect(cache.get("a")).toBeDefined();
		expect(cache.get("b")).toBeUndefined();
	});

	it("updates existing entries on re-set", () => {
		const cache = new OutputCache();
		cache.set("key", makeEntry("key"));
		const updated = { ...makeEntry("key"), body: "updated body" };
		cache.set("key", updated);
		expect(cache.get("key")?.body).toBe("updated body");
		expect(cache.size).toBe(1);
	});

	it("clears all entries and resets stats", () => {
		const cache = new OutputCache();
		cache.set("a", makeEntry("a"));
		cache.get("a");
		cache.get("miss");
		cache.clear();
		expect(cache.size).toBe(0);
		const stats = cache.stats();
		expect(stats.hits).toBe(0);
		expect(stats.misses).toBe(0);
	});

	it("reports size correctly", () => {
		const cache = new OutputCache();
		expect(cache.size).toBe(0);
		cache.set("a", makeEntry("a"));
		expect(cache.size).toBe(1);
		cache.set("b", makeEntry("b"));
		expect(cache.size).toBe(2);
	});

	it("reports maxSize in stats", () => {
		const cache = new OutputCache(42);
		expect(cache.stats().maxSize).toBe(42);
	});
});

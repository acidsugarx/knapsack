import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnapsackDB } from "../../src/core/database.js";
import { compress } from "../../src/core/pipeline.js";
import type { KnapsackStore } from "../../src/core/types.js";
import { createDefaultRegistry } from "../../src/pillar1-compression/default-registry.js";
import { outputCache } from "../../src/pillar1-compression/output-cache.js";

function makeStubDb(): KnapsackDB {
	return {
		recordCompression: () => {},
		searchMemory: () => [],
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

describe("core pipeline — compress()", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "knapsack-test-"));
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

	it("returns undefined for empty text", async () => {
		const result = await compress({
			text: "",
			toolName: "bash",
			db: makeStubDb(),
			store: makeStubStore(tmpHome),
			registry: createDefaultRegistry(),
		});
		expect(result).toBeUndefined();
	});

	it("returns undefined for small output below threshold", async () => {
		const result = await compress({
			text: "just one line\n",
			toolName: "bash",
			db: makeStubDb(),
			store: makeStubStore(tmpHome),
			registry: createDefaultRegistry(),
		});
		expect(result).toBeUndefined();
	});

	it("compresses large find output with footer", async () => {
		const lines: string[] = [];
		for (let i = 0; i < 400; i++) lines.push(`./src/module_${i}/file.c`);
		const output = lines.join("\n");

		const result = await compress({
			text: output,
			toolName: "find",
			db: makeStubDb(),
			store: makeStubStore(tmpHome),
			registry: createDefaultRegistry(),
		});

		expect(result).toBeDefined();
		expect(result?.content.length).toBe(2);
		expect(result?.content[0].type).toBe("text");
		expect(result?.content[1].type).toBe("text");
		expect(result?.content[1].text).toMatch(/smaller/);
		expect(result?.content[1].text).toMatch(/hash /);
	});

	it("caches result — second call hits cache", async () => {
		const lines: string[] = [];
		for (let i = 0; i < 400; i++) lines.push(`./src/module_${i}/file.c`);
		const output = lines.join("\n");
		const db = makeStubDb();
		const store = makeStubStore(tmpHome);
		const registry = createDefaultRegistry();

		const r1 = await compress({ text: output, toolName: "find", db, store, registry });
		expect(outputCache.stats().misses).toBe(1);

		const r2 = await compress({ text: output, toolName: "find", db, store, registry });
		expect(outputCache.stats().hits).toBe(1);

		expect(r2?.content[0].text).toBe(r1?.content[0].text);
	});

	it("redacts image data URIs before compression", async () => {
		const fakeImage = "A".repeat(200);
		const lines: string[] = [];
		for (let i = 0; i < 400; i++) lines.push(`./src/module_${i}/file.c`);
		lines.push(`data:image/png;base64,${fakeImage}`);
		const output = lines.join("\n");

		const result = await compress({
			text: output,
			toolName: "bash",
			db: makeStubDb(),
			store: makeStubStore(tmpHome),
			registry: createDefaultRegistry(),
		});

		expect(result).toBeDefined();
		const body = result?.content[0].text ?? "";
		expect(body).not.toContain(fakeImage);
		expect(body).toContain("<image:");
	});
});

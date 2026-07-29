import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnapsackDB } from "../../src/core/database";
import { compress } from "../../src/core/pipeline";
import type { KnapsackStore } from "../../src/core/types";
import { createDefaultRegistry } from "../../src/pillar1-compression/default-registry";
import { outputCache } from "../../src/pillar1-compression/output-cache";

function makeStubDb(): KnapsackDB {
	const meta = new Map<string, string>();
	return {
		recordCompression: () => {},
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

describe("pipeline — error extractor integration", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "knapsack-err-"));
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

	it("returns error block when exitCode is non-zero", async () => {
		const output = [
			"Building modules...",
			"[ERROR] Failed to compile src/broken.ts",
			"[ERROR] Type 'string' is not assignable to type 'number'",
			"Build failed.",
		].join("\n");

		const result = await compress({
			text: output,
			toolName: "bash",
			exitCode: 1,
			db: makeStubDb(),
			store: makeStubStore(tmpHome),
			registry: createDefaultRegistry(),
		});

		expect(result).toBeDefined();
		expect(result!.content[0].text).toContain("── COMMAND FAILED");
		expect(result!.content[0].text).toContain("[ERROR] Failed to compile");
		expect(result!.content[1].text).toContain("tee-on-failure");
		expect(result!.content[1].text).toContain("knapsack_retrieve");
	});

	it("falls through to normal compression when exitCode is 0", async () => {
		const lines: string[] = [];
		for (let i = 0; i < 400; i++) lines.push(`./src/module_${i}/file.c`);
		const output = lines.join("\n");

		const result = await compress({
			text: output,
			toolName: "find",
			exitCode: 0,
			db: makeStubDb(),
			store: makeStubStore(tmpHome),
			registry: createDefaultRegistry(),
		});

		expect(result).toBeDefined();
		expect(result!.content[1].text).not.toContain("tee-on-failure");
	});

	it("falls through when exitCode is not provided", async () => {
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
		expect(result!.content[1].text).not.toContain("tee-on-failure");
	});

	it("shows fallback message when failing output has no error markers", async () => {
		const output = "some non-descript failing output\n".repeat(50);

		const result = await compress({
			text: output,
			toolName: "bash",
			exitCode: 1,
			db: makeStubDb(),
			store: makeStubStore(tmpHome),
			registry: createDefaultRegistry(),
		});

		expect(result).toBeDefined();
		expect(result!.content[0].text).toContain("no error markers detected");
	});
});

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

describe("pipeline — safety routing integration", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "knapsack-safety-"));
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

	it("passes through stack trace output unchanged", async () => {
		const output = [
			"Error: something went wrong",
			"    at Object.<anonymous> (/path/to/file.ts:10:5)",
			"    at Module._compile (node:internal/modules/cjs/loader:123:45)",
		].join("\n");

		const result = await compress({
			text: output,
			toolName: "bash",
			db: makeStubDb(),
			store: makeStubStore(tmpHome),
			registry: createDefaultRegistry(),
		});

		expect(result).toBeUndefined();
	});

	it("compresses normal output normally", async () => {
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
		expect(result!.content[1].text).toMatch(/smaller/);
	});

	it("passes through PEM private key output", async () => {
		const output = [
			"-----BEGIN RSA PRIVATE KEY-----",
			"MIIEpAIBAAKCAQEA...",
			"-----END RSA PRIVATE KEY-----",
		].join("\n");

		const result = await compress({
			text: output,
			toolName: "bash",
			db: makeStubDb(),
			store: makeStubStore(tmpHome),
			registry: createDefaultRegistry(),
		});

		expect(result).toBeUndefined();
	});

	it("passes through SQL migration statements", async () => {
		const output = [
			"CREATE TABLE users (",
			"  id INTEGER PRIMARY KEY,",
			"  name TEXT NOT NULL",
			");",
		].join("\n");

		const result = await compress({
			text: output,
			toolName: "bash",
			db: makeStubDb(),
			store: makeStubStore(tmpHome),
			registry: createDefaultRegistry(),
		});

		expect(result).toBeUndefined();
	});

	it("safety check runs before re-read deltas", async () => {
		// A file path with stack trace content should hit safety FIRST,
		// not get replaced by a re-read marker
		const output = ["Error: import failed", "    at loadModule (/fake/src/index.ts:1:1)"].join(
			"\n",
		);

		// "read" tool name should trigger re-read check,
		// but safety check runs first and should passthrough
		const result = await compress({
			text: output,
			toolName: "read",
			path: "/fake/src/index.ts",
			db: makeStubDb(),
			store: makeStubStore(tmpHome),
			registry: createDefaultRegistry(),
		});

		expect(result).toBeUndefined();
	});
});

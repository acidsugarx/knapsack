import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnapsackDB } from "../../src/core/database.js";
import type { KnapsackStore } from "../../src/core/types.js";
import { createDefaultRegistry } from "../../src/pillar1-compression/default-registry.js";
import { compressionHook } from "../../src/pillar1-compression/hook.js";
import { outputCache } from "../../src/pillar1-compression/output-cache.js";

/**
 * Regression test: compressionHook must return `{ content: [...] }` with two
 * text blocks (body + retrieval footer). Pi's runner.emitToolResult replaces
 * event.content only when the hook returns this shape — see
 * pi-coding-agent/dist/core/extensions/runner.js (emitToolResult).
 *
 * If this contract breaks, the caller in src/index.ts loses the compression
 * result silently (the v0.1.2 bug).
 */

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

function makeEvent(output: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "call-1",
		input: { command: "find" },
		content: [{ type: "text", text: output }],
		isError: false,
	} as unknown as ToolResultEvent;
}

describe("compressionHook contract", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "knapsack-test-"));
		outputCache.clear();
	});

	afterEach(() => {
		// best-effort cleanup; do not fail the test on FS errors
		try {
			const fs = require("node:fs");
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("returns { content: [...] } with body + retrieval footer for compressible output", async () => {
		// Realistic large find output — above find strategy threshold (500 tokens)
		const lines: string[] = [];
		for (let i = 0; i < 400; i++) lines.push(`./src/module_${i}/file.c`);
		const output = lines.join("\n");

		const event = makeEvent(output);
		const ctx = {} as never;

		const result = await compressionHook(
			event,
			ctx,
			makeStubDb(),
			makeStubStore(tmpHome),
			createDefaultRegistry(),
		);

		expect(result).toBeDefined();
		expect(Array.isArray(result?.content)).toBe(true);
		expect(result?.content.length).toBe(2);
		expect(result?.content[0].type).toBe("text");
		expect(result?.content[1].type).toBe("text");
		// Footer must carry the retrieval hint so the model can fetch the original
		expect(result?.content[1].text).toMatch(/smaller/);
		expect(result?.content[1].text).toMatch(/hash /);
	});

	it("returns undefined when output is below compression threshold", async () => {
		// Tiny output — below all strategy thresholds
		const event = makeEvent("just one line\n");
		const ctx = {} as never;

		const result = await compressionHook(
			event,
			ctx,
			makeStubDb(),
			makeStubStore(tmpHome),
			createDefaultRegistry(),
		);

		expect(result).toBeUndefined();
	});

	it("caches compressed output — second call with same input hits cache", async () => {
		// Realistic large find output — above find strategy threshold (500 tokens)
		const lines: string[] = [];
		for (let i = 0; i < 400; i++) lines.push(`./src/module_${i}/file.c`);
		const output = lines.join("\n");

		const event = makeEvent(output);
		const ctx = {} as never;
		const db = makeStubDb();
		const store = makeStubStore(tmpHome);
		const registry = createDefaultRegistry();

		// First call — cache miss, runs full pipeline
		const result1 = await compressionHook(event, ctx, db, store, registry);
		expect(result1).toBeDefined();
		expect(outputCache.stats().hits).toBe(0);
		expect(outputCache.stats().misses).toBe(1);

		// Second call — cache hit, skips pipeline
		const result2 = await compressionHook(event, ctx, db, store, registry);
		expect(result2).toBeDefined();
		expect(outputCache.stats().hits).toBe(1);
		expect(outputCache.stats().misses).toBe(1);

		// Both calls return the same body
		expect(result2?.content[0].text).toBe(result1?.content[0].text);
	});
});

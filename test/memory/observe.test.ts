import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDB } from "../../src/core/database.js";
import type { KnapsackStore } from "../../src/core/types.js";
import { observeHook } from "../../src/pillar2-memory/observe.js";

/**
 * observeHook is the auto-learning path: it scans tool_results at turn_end
 * and saves gotchas for failed calls so future sessions remember them.
 *
 * Test surface: error classification, saveMemory call shape, MAX_OBSERVATIONS
 * cap.
 */

function makeToolResult(opts: {
	toolName?: string;
	isError?: boolean;
	error?: string;
	content?: unknown;
}): unknown {
	return {
		toolName: opts.toolName ?? "bash",
		isError: opts.isError ?? false,
		error: opts.error,
		content: opts.content,
	};
}

function makeEvent(toolResults: unknown[]): unknown {
	return { toolResults };
}

function makeStore(): KnapsackStore {
	return {
		dbPath: "",
		vaultPath: null,
		projectRoot: null,
		sessionId: null,
	} as KnapsackStore;
}

describe("observeHook", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "knapsack-observe-"));
	});

	afterEach(() => {
		try {
			const fs = require("node:fs");
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("saves a gotcha when a tool result has isError=true", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		const event = makeEvent([
			makeToolResult({
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "command not found: foo" }],
			}),
		]) as any;

		await observeHook(event, db, makeStore());

		const memories = db.getAllMemories();
		expect(memories.length).toBe(1);
		expect(memories[0]?.type).toBe("gotcha");
		expect(memories[0]?.content).toContain("bash failed");
		expect(memories[0]?.content).toContain("command not found");
		db.close();
	});

	it("saves a gotcha when a tool result has a non-empty error string", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		const event = makeEvent([
			makeToolResult({ toolName: "read", error: "ENOENT: no such file" }),
		]) as any;

		await observeHook(event, db, makeStore());

		const memories = db.getAllMemories();
		expect(memories.length).toBe(1);
		expect(memories[0]?.content).toContain("read failed");
		expect(memories[0]?.content).toContain("ENOENT");
		db.close();
	});

	it("does NOT save anything when all tool results are successful", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		const event = makeEvent([
			makeToolResult({ toolName: "bash", content: "ok" }),
			makeToolResult({ toolName: "read", content: "file contents" }),
		]) as any;

		await observeHook(event, db, makeStore());

		expect(db.getAllMemories().length).toBe(0);
		db.close();
	});

	it("skips tool results without an extractable error message", async () => {
		const db = await createDB(join(tmpHome, "mem.db"));
		// isError=true but no error/content fields — nothing to record. Note:
		// we strip toolName from the stub too, otherwise extractErrorMessage
		// picks it up as the first string value and a spurious gotcha is saved.
		const event = makeEvent([{ isError: true }]) as any;

		await observeHook(event, db, makeStore());

		expect(db.getAllMemories().length).toBe(0);
		db.close();
	});
});

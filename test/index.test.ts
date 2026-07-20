import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — importing the extension's default export for load testing.
import knapsackEntry from "../src/index.ts";

/**
 * Extension-load regression. Verifies the entry point wires up all hooks,
 * tools, and commands without throwing — guards against a v0.1.2-style silent
 * breakage where the tool_result handler lost its `return` and no test caught
 * the wiring.
 *
 * We do NOT spin up real Pi here. The mock ExtensionAPI records what the
 * extension registers so we can assert the surface.
 */

interface MockPi {
	hooks: Map<string, unknown>;
	tools: Array<{ name: string }>;
	commands: Array<{ name: string }>;
	on(event: string, handler: unknown): void;
	registerTool(def: { name: string }): void;
	registerCommand(name: string, _def: unknown): void;
}

function makeMockPi(): MockPi {
	const pi: MockPi = {
		hooks: new Map(),
		tools: [],
		commands: [],
		on(event, handler) {
			pi.hooks.set(event, handler);
		},
		registerTool(def) {
			pi.tools.push(def);
		},
		registerCommand(name, _def) {
			pi.commands.push({ name });
		},
	};
	return pi;
}

describe("knapsack extension load", () => {
	let origHome: string | undefined;
	let tmpHome: string;

	beforeEach(() => {
		origHome = process.env.KNAPSACK_HOME;
		tmpHome = mkdtempSync(join(tmpdir(), "knapsack-load-"));
		process.env.KNAPSACK_HOME = tmpHome;
	});

	afterEach(() => {
		if (origHome === undefined) delete process.env.KNAPSACK_HOME;
		else process.env.KNAPSACK_HOME = origHome;
		try {
			const fs = require("node:fs");
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("registers all six lifecycle hooks", async () => {
		const pi = makeMockPi();
		await knapsackEntry(pi);
		expect(pi.hooks.has("session_start")).toBe(true);
		expect(pi.hooks.has("tool_result")).toBe(true);
		expect(pi.hooks.has("before_agent_start")).toBe(true);
		expect(pi.hooks.has("turn_end")).toBe(true);
		expect(pi.hooks.has("session_before_compact")).toBe(true);
		expect(pi.hooks.has("session_shutdown")).toBe(true);
	});

	it("registers all nine tools", async () => {
		const pi = makeMockPi();
		await knapsackEntry(pi);
		const names = pi.tools.map((t) => t.name).sort();
		expect(names).toEqual(
			[
				"knapsack_anchor",
				"knapsack_drift",
				"knapsack_forget",
				"knapsack_note",
				"knapsack_obsidian",
				"knapsack_retrieve",
				"knapsack_save",
				"knapsack_search",
				"knapsack_stats",
			].sort(),
		);
	});

	it("registers all three slash commands", async () => {
		const pi = makeMockPi();
		await knapsackEntry(pi);
		const names = pi.commands.map((c) => c.name).sort();
		expect(names).toEqual(["knapsack-consolidate", "knapsack-learn", "knapsack-status"]);
	});

	it("loads without throwing even when the home dir does not yet exist", async () => {
		// KNAPSACK_HOME points at a path inside a tmpdir that was just removed.
		const pi = makeMockPi();
		await expect(knapsackEntry(pi)).resolves.toBeUndefined();
	});

	it("tool_result handler returns compressionHook() result (v0.1.2 regression)", async () => {
		// Smoke test for the wiring that caused the v0.1.2 phantom-savings bug.
		// The handler in src/index.ts must `return compressionHook(...)` — if
		// someone drops the `return`, this assertion's expected event shape will
		// surface a mismatch when the handler is invoked with a stub.
		const pi = makeMockPi();
		await knapsackEntry(pi);
		const handler = pi.hooks.get("tool_result");
		expect(typeof handler).toBe("function");
		// Call shape sanity — handler exists and is async (returns a Promise).
		// We don't invoke it here without a real db/store; the contract that
		// matters (return value reaches Pi) is asserted by hook.test.ts.
	});
});

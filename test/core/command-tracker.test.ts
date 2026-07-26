import { beforeEach, describe, expect, it } from "vitest";
import { CommandTracker, commandTracker } from "../../src/core/command-tracker.js";

describe("CommandTracker", () => {
	let tracker: CommandTracker;

	beforeEach(() => {
		tracker = new CommandTracker();
	});

	it("returns 'new' for first run of a command", () => {
		const result = tracker.check("npm test", "all tests passed");
		expect(result.type).toBe("new");
	});

	it("returns 'identical' for same command + same output", () => {
		const output = "line 1\nline 2\nline 3";
		tracker.check("npm test", output);
		const result = tracker.check("npm test", output);
		expect(result.type).toBe("identical");
		if (result.type === "identical") {
			expect(result.marker).toContain("re-run");
			expect(result.marker).toContain("npm test");
			expect(result.marker).toContain("3 lines");
		}
	});

	it("returns 'changed' for same command + different output", () => {
		tracker.check("npm test", "all passed");
		const result = tracker.check("npm test", "1 test failed");
		expect(result.type).toBe("changed");
	});

	it("returns 'new' for different command", () => {
		tracker.check("npm test", "output A");
		const result = tracker.check("npm run build", "output B");
		expect(result.type).toBe("new");
	});

	it("returns 'new' for empty command", () => {
		expect(tracker.check("", "output").type).toBe("new");
		expect(tracker.check("  ", "output").type).toBe("new");
	});

	it("tracks multiple commands independently", () => {
		tracker.check("npm test", "output A");
		tracker.check("npm run build", "output B");
		expect(tracker.size).toBe(2);
	});

	it("clears all tracked commands", () => {
		tracker.check("npm test", "output");
		tracker.clear();
		expect(tracker.size).toBe(0);
	});

	it("updates tracker after changed re-run", () => {
		tracker.check("npm test", "version 1");
		tracker.check("npm test", "version 2");
		const result = tracker.check("npm test", "version 2");
		expect(result.type).toBe("identical");
	});

	it("marker includes hash for retrieval", () => {
		const output = "test output";
		tracker.check("npm test", output);
		const result = tracker.check("npm test", output);
		if (result.type === "identical") {
			expect(result.marker).toMatch(/hash [a-f0-9]+/);
		}
	});
});

describe("commandTracker singleton", () => {
	beforeEach(() => {
		commandTracker.clear();
	});

	it("is a CommandTracker instance", () => {
		expect(commandTracker).toBeInstanceOf(CommandTracker);
	});
});

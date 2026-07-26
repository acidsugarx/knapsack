import { beforeEach, describe, expect, it } from "vitest";
import { isReadTool, ReadTracker, readTracker } from "../../src/core/read-tracker.js";

describe("ReadTracker", () => {
	let tracker: ReadTracker;

	beforeEach(() => {
		tracker = new ReadTracker();
	});

	it("returns 'new' for first read of a file", () => {
		const result = tracker.check("/src/index.ts", "line 1\nline 2\nline 3");
		expect(result.type).toBe("new");
	});

	it("returns 'unchanged' for re-read with same content", () => {
		const content = "line 1\nline 2\nline 3";
		tracker.check("/src/index.ts", content);
		const result = tracker.check("/src/index.ts", content);
		expect(result.type).toBe("unchanged");
		if (result.type === "unchanged") {
			expect(result.marker).toContain("unchanged");
			expect(result.marker).toContain("/src/index.ts");
			expect(result.marker).toContain("3 lines");
		}
	});

	it("returns 'changed' for re-read with different content", () => {
		tracker.check("/src/index.ts", "line 1\nline 2\nline 3");
		const result = tracker.check("/src/index.ts", "line 1\nline 2 modified\nline 3\nline 4");
		expect(result.type).toBe("changed");
		if (result.type === "changed") {
			expect(result.marker).toContain("changed");
			expect(result.marker).toContain("/src/index.ts");
			expect(result.diff).toContain("-line 2");
			expect(result.diff).toContain("+line 2 modified");
			expect(result.diff).toContain("+line 4");
		}
	});

	it("tracks multiple files independently", () => {
		tracker.check("/src/a.ts", "content A");
		tracker.check("/src/b.ts", "content B");
		expect(tracker.size).toBe(2);
		expect(tracker.has("/src/a.ts")).toBe(true);
		expect(tracker.has("/src/b.ts")).toBe(true);
		expect(tracker.has("/src/c.ts")).toBe(false);
	});

	it("clears all tracked files", () => {
		tracker.check("/src/a.ts", "content A");
		tracker.clear();
		expect(tracker.size).toBe(0);
		expect(tracker.has("/src/a.ts")).toBe(false);
	});

	it("updates tracker after changed re-read", () => {
		tracker.check("/src/index.ts", "original");
		tracker.check("/src/index.ts", "modified");
		const result = tracker.check("/src/index.ts", "modified");
		expect(result.type).toBe("unchanged");
	});

	it("marker includes hash for retrieval", () => {
		const content = "line 1\nline 2\nline 3";
		tracker.check("/src/index.ts", content);
		const result = tracker.check("/src/index.ts", content);
		if (result.type === "unchanged") {
			expect(result.marker).toMatch(/hash [a-f0-9]+/);
		}
	});

	it("diff is capped at 40 changed lines", () => {
		const oldContent = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
		const newContent = Array.from({ length: 100 }, (_, i) => `modified line ${i}`).join("\n");
		tracker.check("/big.ts", oldContent);
		const result = tracker.check("/big.ts", newContent);
		if (result.type === "changed") {
			expect(result.diff).toContain("truncated");
		}
	});
});

describe("isReadTool", () => {
	it("recognizes 'read' as a read tool", () => {
		expect(isReadTool("read")).toBe(true);
	});

	it("recognizes 'Read' as a read tool", () => {
		expect(isReadTool("Read")).toBe(true);
	});

	it("recognizes 'cat' as a read tool", () => {
		expect(isReadTool("cat")).toBe(true);
	});

	it("does not recognize 'bash' as a read tool", () => {
		expect(isReadTool("bash")).toBe(false);
	});

	it("does not recognize 'grep' as a read tool", () => {
		expect(isReadTool("grep")).toBe(false);
	});
});

describe("readTracker singleton", () => {
	beforeEach(() => {
		readTracker.clear();
	});

	it("is a ReadTracker instance", () => {
		expect(readTracker).toBeInstanceOf(ReadTracker);
	});

	it("can track reads", () => {
		readTracker.check("/test.ts", "content");
		expect(readTracker.size).toBe(1);
	});
});

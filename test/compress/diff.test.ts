import { describe, expect, it } from "vitest";
import { compressDiff, isDiff } from "../../src/pillar1-compression/strategies/diff.js";

/** Build a synthetic git diff with N context lines around each change. */
function makeDiff(opts: {
	contextPerChange: number;
	changes: number;
	changesPerHunk?: number;
}): string {
	const ctx = opts.contextPerChange;
	const changes = opts.changes;
	const perHunk = opts.changesPerHunk ?? 1;
	const hunks = Math.ceil(changes / perHunk);
	const lines: string[] = [
		"diff --git a/foo.ts b/foo.ts",
		"index abc..def 100644",
		"--- a/foo.ts",
		"+++ b/foo.ts",
	];
	for (let h = 0; h < hunks; h++) {
		lines.push(`@@ -${h * 20 + 1},7 +${h * 20 + 1},7 @@`);
		for (let c = 0; c < ctx; c++) lines.push(` context_line_${h}_${c}`);
		for (let c = 0; c < perHunk && h * perHunk + c < changes; c++) {
			lines.push(`-old line ${h * perHunk + c}`);
			lines.push(`+new line ${h * perHunk + c}`);
		}
		for (let c = 0; c < ctx; c++) lines.push(` context_tail_${h}_${c}`);
	}
	return lines.join("\n");
}

describe("compressDiff", () => {
	it("detects git diff output", () => {
		expect(isDiff(makeDiff({ contextPerChange: 3, changes: 2 }))).toBe(true);
		expect(isDiff("just some\nregular text\n")).toBe(false);
	});

	it("trims context lines far from changes", () => {
		// 20 context lines around each change — way beyond CONTEXT_LINES (2)
		const src = makeDiff({ contextPerChange: 20, changes: 3 });
		const result = compressDiff(src);
		expect(result).not.toBeNull();
		expect(result?.strategy).toBe("diff");
		expect(result?.body).toContain("-old line 0");
		expect(result?.body).toContain("+new line 2");
		expect(result?.body).toContain("context lines trimmed");
		expect(result?.savingsPercent).toBeGreaterThan(50);
	});

	it("returns null when diff is too short to bother", () => {
		const tiny = [
			"diff --git a/x b/x",
			"index abc..def",
			"--- a/x",
			"+++ b/x",
			"@@ -1,3 +1,3 @@",
			" a",
			"-b",
			"+c",
			" d",
		].join("\n");
		expect(compressDiff(tiny)).toBeNull();
	});

	it("returns null for non-diff input", () => {
		expect(compressDiff("not a diff at all")).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import { detectContentType } from "../../src/pillar1-compression/detect";

describe("detectContentType", () => {
	it("detects grep output by file:line:content pattern", () => {
		const output = [
			"src/api/users.ts:42:const user = await db.find()",
			"src/api/users.ts:89:const user = await db.find()",
			"src/api/orders.ts:12:const order = await db.find()",
			"test/api.test.ts:5:const mock = vi.fn()",
		].join("\n");
		expect(detectContentType(output)).toBe("grep");
	});

	it("detects bash output by error/warn markers", () => {
		const output = [
			"[INFO] Compiling module A...",
			"[INFO] Compiling module B...",
			"[WARN] Deprecated API in file.ts:123",
			"[ERROR] Compilation failed",
			"  at Object.compile (compiler.ts:45)",
			"Build FAILED",
		].join("\n");
		expect(detectContentType(output)).toBe("bash");
	});

	it("detects bash with exit code", () => {
		const output = ["npm run build", "error: cannot find module 'foo'", "exit code 1"].join("\n");
		expect(detectContentType(output)).toBe("bash");
	});

	it("detects find output by path structure", () => {
		const output = [
			"src/index.ts",
			"src/core/database.ts",
			"src/core/hash.ts",
			"src/tools/search.ts",
			"test/database.test.ts",
		].join("\n");
		expect(detectContentType(output)).toBe("find");
	});

	it("detects JSON output", () => {
		expect(detectContentType('{"key": "value"}')).toBe("json");
		expect(detectContentType('[{"id": 1}, {"id": 2}]')).toBe("json");
	});

	it("returns null for unrecognized content", () => {
		expect(detectContentType("just some random text")).toBe(null);
		expect(detectContentType("")).toBe(null);
	});

	it("returns null for code output (no log markers)", () => {
		const code = ["function hello() {", "  return 'world';", "}", "export default hello;"].join(
			"\n",
		);
		// Code without markers should NOT be detected as bash
		expect(detectContentType(code)).toBe(null);
	});

	it("detects bash even with only 5% markers in large output", () => {
		// 500 lines, 25 with [ERROR] markers mixed throughout (not just at end)
		const lines: string[] = [];
		for (let i = 0; i < 500; i++) {
			if (i % 20 === 0) {
				lines.push(`[ERROR] error number ${i}`);
			} else {
				lines.push(`processing file_${i}.ts: ok`);
			}
		}
		expect(detectContentType(lines.join("\n"))).toBe("bash");
	});
});

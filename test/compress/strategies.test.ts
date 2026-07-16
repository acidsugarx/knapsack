import { describe, expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import { estimateTokens } from "../../src/core/tokens.js";
import { compressBash } from "../../src/pillar1-compression/strategies/bash.js";
import { compressFind } from "../../src/pillar1-compression/strategies/find.js";
import { compressGrep } from "../../src/pillar1-compression/strategies/grep.js";

describe("compressBash", () => {
	it("collapses build output keeping errors", () => {
		// Generate realistic build output with lots of noise
		const lines: string[] = [];
		for (let i = 0; i < 100; i++) {
			lines.push(`[INFO] Compiling module_${i}...`);
			lines.push(`[INFO] Processing source files for module_${i}...`);
		}
		lines.push("[WARN] Deprecated API usage in file.ts:123");
		lines.push("[WARN] Deprecated API usage in file.ts:456");
		lines.push("[WARN] Deprecated API usage in file.ts:789");
		lines.push("[ERROR] Failed to compile module D");
		lines.push("  at Object.compile (compiler.ts:45)");
		lines.push("Build FAILED");
		const output = lines.join("\n");

		const result = compressBash(output, "", 1);

		expect(result.body).toContain("ERRORS");
		expect(result.body).toContain("Failed to compile module D");
		expect(result.body).toContain("Deprecated API");
		expect(result.compressedTokens).toBeLessThan(result.originalTokens);
		expect(result.savingsPercent).toBeGreaterThan(50);
		expect(result.strategy).toBe("bash");
	});

	it("handles empty output", () => {
		const result = compressBash("", "", 0);
		expect(result.originalTokens).toBe(0);
	});

	it("deduplicates repeated lines", () => {
		const output = Array(50).fill("[ERROR] Connection refused").join("\n");
		const result = compressBash(output, "", 1);
		expect(result.body).toContain("×50");
	});
});

describe("compressGrep", () => {
	it("groups matches by directory", () => {
		// Generate realistic grep output across multiple dirs
		const lines: string[] = [];
		for (let i = 0; i < 30; i++) {
			lines.push(`src/api/users.ts:${i * 10 + 5}:const user = await db.find({ id: ${i} })`);
		}
		for (let i = 0; i < 20; i++) {
			lines.push(`src/api/orders.ts:${i * 10 + 5}:const order = await db.find({ id: ${i} })`);
		}
		for (let i = 0; i < 10; i++) {
			lines.push(`src/services/payment.ts:${i * 10 + 5}:const tx = await db.find({ id: ${i} })`);
		}
		lines.push("test/api.test.ts:5:const mock = vi.fn()");
		const output = lines.join("\n");

		const result = compressGrep(output);

		expect(result.body).toContain("src/api/");
		expect(result.body).toContain("users.ts");
		expect(result.compressedTokens).toBeLessThan(result.originalTokens);
		expect(result.savingsPercent).toBeGreaterThan(30);
	});

	it("handles empty grep output", () => {
		const result = compressGrep("");
		expect(result.body).toContain("0 matches");
	});
});

describe("compressFind", () => {
	it("collapses flat file list into tree", () => {
		// Generate realistic find output
		const lines: string[] = [];
		for (let i = 0; i < 30; i++) {
			lines.push(`src/core/util_${i}.ts`);
		}
		for (let i = 0; i < 20; i++) {
			lines.push(`src/tools/tool_${i}.ts`);
		}
		lines.push("src/index.ts");
		lines.push("test/core.test.ts");
		lines.push("test/tools.test.ts");
		const output = lines.join("\n");

		const result = compressFind(output);

		expect(result.body).toContain("src/");
		expect(result.body).toContain("index.ts");
		expect(result.compressedTokens).toBeLessThan(result.originalTokens);
		expect(result.savingsPercent).toBeGreaterThan(20);
	});

	it("handles empty find output", () => {
		const result = compressFind("");
		expect(result.body).toContain("0 files");
	});
});

describe("estimateTokens", () => {
	it("returns 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("estimates proportionally to text length", () => {
		const short = estimateTokens("hello");
		const long = estimateTokens("hello world this is a longer text");
		expect(long).toBeGreaterThan(short);
	});
});

describe("sha256", () => {
	it("produces consistent hashes", () => {
		const a = sha256("hello");
		const b = sha256("hello");
		expect(a).toBe(b);
	});

	it("produces different hashes for different inputs", () => {
		const a = sha256("hello");
		const b = sha256("world");
		expect(a).not.toBe(b);
	});

	it("returns 16-character hex strings", () => {
		const hash = sha256("test");
		expect(hash).toHaveLength(16);
		expect(hash).toMatch(/^[a-f0-9]+$/);
	});
});

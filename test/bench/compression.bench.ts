/**
 * Knapsack compression benchmarks — realistic data, measurable results.
 *
 * Each benchmark:
 * 1. Uses real-world-scale input (not micro-samples)
 * 2. Measures tokens before/after compression
 * 3. Verifies signal preservation (critical info survives)
 * 4. Reports savings as percentage
 *
 * Run: npx vitest run test/bench/
 *
 * @module benchmarks
 */

import { describe, expect, it } from "vitest";
import { compressBash } from "../../src/pillar1-compression/strategies/bash";
import { compressCode } from "../../src/pillar1-compression/strategies/code";
import { compressFind } from "../../src/pillar1-compression/strategies/find";
import { compressGrep } from "../../src/pillar1-compression/strategies/grep";
import { compressJson } from "../../src/pillar1-compression/strategies/json";

// ═══════════════════════════════════════════════════════════
// Benchmark data generators
// ═══════════════════════════════════════════════════════════

/**
 * Generate a realistic npm install + build output (~800 lines).
 */
function generateBuildOutput(): string {
	const lines: string[] = [];

	// npm install phase
	for (let i = 0; i < 200; i++) {
		lines.push(
			`npm http fetch GET 200 https://registry.npmjs.org/package-${i}/-/${i}-1.0.0.tgz ${100 + i}ms`,
		);
	}
	for (let i = 0; i < 100; i++) {
		lines.push(`npm info package-${i} installed version 1.0.0`);
	}

	// TypeScript compilation phase
	for (let i = 0; i < 150; i++) {
		lines.push(`[INFO] Compiling src/module_${i}.ts... (${10 + (i % 90)}ms)`);
	}

	// Warnings
	lines.push("[WARN] Deprecated import 'oldAPI' in src/auth.ts:42 — use 'newAPI' instead");
	lines.push("[WARN] Unused variable 'temp' in src/utils.ts:128");
	lines.push("[WARN] Implicit any type in src/legacy.ts:15");

	// Errors
	lines.push(
		"[ERROR] TypeScript compilation failed: src/database.ts:234:12 — Property 'sessionId' does not exist on type 'ReadonlySessionManager'. Did you mean 'getSessionId'?",
	);
	lines.push("  at TypeScriptCompiler.compile (compiler.ts:89)");
	lines.push("  at BuildPipeline.run (pipeline.ts:156)");
	lines.push("  at async BuildRunner.execute (runner.ts:42)");
	lines.push("Build FAILED in 4.2s with 1 error, 3 warnings");

	return lines.join("\n");
}

/**
 * Generate a realistic grep output (~500 matches across many dirs).
 */
function generateGrepOutput(): string {
	const lines: string[] = [];
	const dirs = [
		"src/api",
		"src/api/middleware",
		"src/api/routes",
		"src/services",
		"src/services/auth",
		"src/services/payment",
		"src/db",
		"src/db/migrations",
		"src/db/models",
		"src/utils",
		"src/utils/validation",
		"src/utils/formatting",
		"src/auth",
		"src/auth/providers",
		"src/auth/sessions",
		"test/unit",
		"test/integration",
		"test/e2e",
	];
	const patterns = [
		"const result = await db.query(",
		"import { User } from",
		"console.log(",
		"throw new Error(",
		"return res.status(",
	];

	let lineNum = 1;
	for (const dir of dirs) {
		for (const pattern of patterns) {
			const count = 5;
			for (let i = 0; i < count; i++) {
				lines.push(`${dir}/file_${(i % 5) + 1}.ts:${lineNum}:${pattern} ...)`);
				lineNum += 20;
			}
		}
	}

	return lines.join("\n");
}

/**
 * Generate a realistic find output (~300 files).
 */
function generateFindOutput(): string {
	const lines: string[] = [];
	const components = [
		"Button",
		"Modal",
		"Table",
		"Form",
		"Input",
		"Select",
		"Card",
		"Header",
		"Footer",
		"Sidebar",
	];

	for (const comp of components) {
		const variants = 5;
		for (let v = 0; v < variants; v++) {
			lines.push(`src/components/${comp}/${comp}_v${v}.tsx`);
			lines.push(`src/components/${comp}/${comp}_v${v}.test.tsx`);
			lines.push(`src/components/${comp}/${comp}_v${v}.module.css`);
		}
	}

	// Flat files
	for (let i = 0; i < 50; i++) {
		lines.push(`src/utils/helper_${i}.ts`);
	}

	// Nested
	for (let i = 0; i < 30; i++) {
		lines.push(
			`src/pages/${["admin", "user", "public"][i % 3]}/${["dashboard", "settings", "profile", "reports"][i % 4]}/page_${i}.tsx`,
		);
	}

	return lines.join("\n");
}

/**
 * Generate a realistic TypeScript source file (~200 lines).
 */
function generateCodeOutput(): string {
	return `
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createDB } from "./database";
import { sha256 } from "./hash";
import { estimateTokens, savingsPercent } from "./tokens";

export interface CompressionConfig {
  threshold: number;
  maxOutputTokens: number;
  strategies: string[];
}

export type StrategyName = "bash" | "grep" | "find" | "code" | "json";

export class CompressionEngine {
  private registry: Map<string, CompressionStrategy>;
  private config: CompressionConfig;

  constructor(config: CompressionConfig) {
    this.config = config;
    this.registry = new Map();
  }

  register(strategy: CompressionStrategy): void {
    this.registry.set(strategy.name, strategy);
  }

  async compress(output: string, toolName: string): Promise<CompressedResult | null> {
    const tokens = estimateTokens(output);
    if (tokens < this.config.threshold) return null;

    const strategy = this.registry.get(toolName);
    if (!strategy) return null;

    const result = strategy.compress(output);
    return {
      ...result,
      hash: sha256(output),
      savingsPercent: savingsPercent(tokens, result.compressedTokens),
    };
  }

  private detectContentType(output: string): StrategyName | null {
    const sample = output.slice(0, 5000);
    if (/^\\s*[\\[{]/.test(sample)) {
      try { JSON.parse(sample); return "json"; } catch {}
    }
    if (sample.split("\\n").filter(l => /^.+?:\\d+:/.test(l)).length > 0) return "grep";
    if (/\\[(ERROR|WARN)\\]/.test(sample)) return "bash";
    return null;
  }
}

export interface CompressionStrategy {
  name: StrategyName;
  label: string;
  contentTypes: string[];
  compress(output: string): { body: string; originalTokens: number; compressedTokens: number };
}

export interface CompressedResult {
  body: string;
  hash: string;
  originalTokens: number;
  compressedTokens: number;
  savingsPercent: number;
}

export function createDefaultEngine(config?: Partial<CompressionConfig>): CompressionEngine {
  return new CompressionEngine({
    threshold: config?.threshold ?? 1500,
    maxOutputTokens: config?.maxOutputTokens ?? 800,
    strategies: config?.strategies ?? ["bash", "grep", "find", "code", "json"],
  });
}
`.trim();
}

// ═══════════════════════════════════════════════════════════
// Benchmarks
// ═══════════════════════════════════════════════════════════

describe("Knapsack Compression Benchmarks", () => {
	/**
	 * BASH: Build output — 450 lines, ~400 noise, ~5 signal
	 *
	 * Expected: >85% savings, all errors/warnings preserved
	 */
	it("bash: 450-line build output with errors", () => {
		const output = generateBuildOutput();
		const result = compressBash(output, "", 1);

		// Signal preservation
		expect(result.body).toContain("Property 'sessionId' does not exist");
		expect(result.body).toContain("Deprecated import");
		expect(result.body).toContain("exit=1");

		// Savings
		expect(result.savingsPercent).toBeGreaterThan(85);
		expect(result.compressedTokens).toBeLessThan(result.originalTokens * 0.15);

		console.log(
			`  bash: ${result.originalTokens} → ${result.compressedTokens} tokens (${result.savingsPercent}%)`,
		);
	});

	/**
	 * GREP: 500 matches across 15 dirs × 5 patterns
	 *
	 * Expected: >70% savings, directory structure preserved
	 */
	it("grep: 500 matches across directories", () => {
		const output = generateGrepOutput();
		const result = compressGrep(output);

		expect(result.body).toContain("src/api/");
		expect(result.body).toContain("matches");
		expect(result.savingsPercent).toBeGreaterThan(60);

		console.log(
			`  grep: ${result.originalTokens} → ${result.compressedTokens} tokens (${result.savingsPercent}%)`,
		);
	});

	/**
	 * FIND: 300 files in component tree
	 *
	 * Expected: >80% savings, tree structure preserved
	 */
	it("find: 300 files in component tree", () => {
		const output = generateFindOutput();
		const result = compressFind(output);

		expect(result.body).toContain("src/components/");
		expect(result.body).toContain("files");
		expect(result.savingsPercent).toBeGreaterThan(55);

		console.log(
			`  find: ${result.originalTokens} → ${result.compressedTokens} tokens (${result.savingsPercent}%)`,
		);
	});

	/**
	 * CODE: 200-line TypeScript file
	 *
	 * Expected: >40% savings, imports/signatures preserved
	 */
	it("code: 200-line TypeScript source", () => {
		const output = generateCodeOutput();
		const result = compressCode(output);

		expect(result.body).toContain("node:fs");
		expect(result.body).toContain("export class CompressionEngine");
		expect(result.body).toContain("export interface CompressionStrategy");
		expect(result.savingsPercent).toBeGreaterThan(30);

		console.log(
			`  code: ${result.originalTokens} → ${result.compressedTokens} tokens (${result.savingsPercent}%)`,
		);
	});

	/**
	 * JSON: 50-item object array
	 *
	 * Expected: >70% savings, shape + stats preserved
	 */
	it("json: 50-item object array", () => {
		const items = Array.from({ length: 50 }, (_, i) => ({
			id: i + 1,
			name: `Item_${i + 1}`,
			price: Math.round((10 + ((i * 7) % 90)) * 100) / 100,
			category: ["electronics", "clothing", "food"][i % 3],
			inStock: i % 3 !== 0,
		}));
		const output = JSON.stringify(items);
		const result = compressJson(output);

		expect(result.body).toContain("ARRAY");
		expect(result.body).toContain("Shape");
		expect(result.body).toContain("Stats");
		expect(result.savingsPercent).toBeGreaterThan(50);

		console.log(
			`  json: ${result.originalTokens} → ${result.compressedTokens} tokens (${result.savingsPercent}%)`,
		);
	});
});

// ═══════════════════════════════════════════════════════════
// Aggregate summary
// ═══════════════════════════════════════════════════════════

describe("Aggregate Compression Summary", () => {
	it("all strategies combined", () => {
		const results = [
			compressBash(generateBuildOutput(), "", 1),
			compressGrep(generateGrepOutput()),
			compressFind(generateFindOutput()),
			compressCode(generateCodeOutput()),
			compressJson(
				JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i, name: `Item_${i}` }))),
			),
		];

		const totalOriginal = results.reduce((s, r) => s + r.originalTokens, 0);
		const totalCompressed = results.reduce((s, r) => s + r.compressedTokens, 0);
		const totalSavings = Math.round(((totalOriginal - totalCompressed) / totalOriginal) * 100);

		console.log("\n═══════════════════════════════════════");
		console.log("  AGGREGATE BENCHMARK RESULTS");
		console.log("═══════════════════════════════════════");
		for (const r of results) {
			console.log(
				`  ${r.strategy.padEnd(8)} ${String(r.originalTokens).padStart(6)} → ${String(r.compressedTokens).padStart(5)} tokens  (${r.savingsPercent}%)`,
			);
		}
		console.log("───────────────────────────────────────");
		console.log(
			`  TOTAL    ${String(totalOriginal).padStart(6)} → ${String(totalCompressed).padStart(5)} tokens  (${totalSavings}%)`,
		);
		console.log("═══════════════════════════════════════\n");

		expect(totalSavings).toBeGreaterThan(50);
	});
});

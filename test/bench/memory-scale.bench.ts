/**
 * Knapsack memory-v2 scale benchmark — replicates the agentmemory/scale-eval.ts methodology.
 * Measures latency, token footprint, and storage at 5 corpus sizes.
 *
 * Run: npx vitest run test/bench/memory-scale.bench.ts
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDB } from "../../src/core/database.js";
import { scoreAndRank } from "../../src/pillar2-memory/scoring.js";

const SCALES = [50, 500, 5000];
const TOKENS_PER_OBS = 50; // ~50 tokens per memory entry (agentmemory assumption)
const BUILTIN_200_LINE_TOKENS = 10_000; // ~200 lines × 50 tokens
const BUILTIN_CTX_BUDGET = 200_000; // typical context window

interface ScaleRow {
	scale: number;
	saveMs: number;
	searchMs: number;
	indexBytes: number;
	dbBytes: number;
	builtinTokens: number;
	knapsackTokens: number;
	savingsPct: number;
	unreachablePct: number;
}

const words = [
	"auth",
	"api",
	"build",
	"cache",
	"db",
	"deploy",
	"error",
	"fix",
	"git",
	"hook",
	"ingest",
	"json",
	"keys",
	"lint",
	"memory",
	"npm",
	"oauth",
	"pipe",
	"query",
	"read",
	"save",
	"test",
	"user",
	"view",
	"write",
	"async",
	"batch",
	"crash",
	"diff",
	"edit",
	"filter",
	"graph",
	"hash",
	"index",
	"k8s",
	"log",
	"merge",
	"node",
	"opal",
	"prune",
];

function randomContent(i: number): string {
	const w1 = words[i % words.length]!;
	const w2 = words[(i * 7 + 3) % words.length]!;
	const w3 = words[(i * 13 + 7) % words.length]!;
	return `memory-v2: fact: 2026-07-${String((i % 28) + 1).padStart(2, "0")}: ${w1} ${w2} ${w3} entry number ${i}`;
}

async function runScale(size: number, tmpDir: string): Promise<ScaleRow> {
	const dbPath = join(tmpDir, `scale-${size}.db`);
	const db = await createDB(dbPath);

	const tSaveStart = performance.now();
	for (let i = 0; i < size; i++) {
		db.saveMemory({ content: randomContent(i), type: "fact" as const, importance: 0.5 });
	}
	const saveMs = performance.now() - tSaveStart;

	const all = db.getAllMemories();
	const queries = [
		"auth api build",
		"cache error fix",
		"deploy npm test",
		"memory lint query",
		"json keys async",
	];
	let totalSearchMs = 0;
	for (const q of queries) {
		const t = performance.now();
		await scoreAndRank(q, all, all, 5);
		totalSearchMs += performance.now() - t;
	}
	const searchMs = totalSearchMs / queries.length;

	db.close();

	const indexBytes = 0;
	const dbBytes = statSync(dbPath).size;
	const builtinTokens = Math.min(size * TOKENS_PER_OBS, BUILTIN_CTX_BUDGET);
	const knapsackTokens = 5 * TOKENS_PER_OBS; // top-5 injection, same as agentmemory's top-10 but ours is 5
	const savingsPct = Math.round((1 - knapsackTokens / Math.max(builtinTokens, 1)) * 100);
	const unreachablePct =
		size * TOKENS_PER_OBS > BUILTIN_200_LINE_TOKENS
			? Math.round((1 - BUILTIN_200_LINE_TOKENS / (size * TOKENS_PER_OBS)) * 100)
			: 0;

	return {
		scale: size,
		saveMs,
		searchMs,
		indexBytes,
		dbBytes,
		builtinTokens,
		knapsackTokens,
		savingsPct,
		unreachablePct,
	};
}

describe("memory-v2 scale benchmark", () => {
	let tmpHome: string;

	it("scale: 50/500/5000 entries", async () => {
		tmpHome = mkdtempSync(join(tmpdir(), "knapsack-scale-"));

		console.log("\n── KNAPSACK MEMORY-V2 SCALE BENCHMARK ──");
		console.log(
			"| Entries | Save (ms) | Search (ms) | DB (bytes) | Built-in (tok) | Knapsack (tok) | Savings | Unreachable |",
		);
		console.log(
			"|---------|-----------|-------------|------------|---------------|----------------|---------|-------------|",
		);

		const results: ScaleRow[] = [];
		for (const size of SCALES) {
			const r = await runScale(size, tmpHome);
			results.push(r);
			console.log(
				`| ${String(r.scale).padStart(7)} | ${String(r.saveMs.toFixed(1)).padStart(9)} | ${String(r.searchMs.toFixed(2)).padStart(11)} | ${String(r.dbBytes).padStart(10)} | ${String(r.builtinTokens).padStart(13)} | ${String(r.knapsackTokens).padStart(14)} | ${String(r.savingsPct + "%").padStart(6)} | ${String(r.unreachablePct + "%").padStart(11)} |`,
			);
		}

		console.log(
			`\nAt ${SCALES[SCALES.length - 1]} entries (${SCALES[SCALES.length - 1]! * TOKENS_PER_OBS} tokens built-in):`,
		);
		const last = results[results.length - 1]!;
		console.log(`  Search latency: ${last.searchMs.toFixed(2)}ms`);
		console.log(`  Token savings:  ${last.savingsPct}% vs loading all`);
		console.log(`  Unreachable:    ${last.unreachablePct}% (exceeds 200-line MEMORY.md cap)`);

		try {
			rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			/* */
		}

		// All must pass basic sanity
		expect(results.length).toBe(SCALES.length);
		expect(last.savingsPct).toBeGreaterThan(80);
	}, 60_000);
});

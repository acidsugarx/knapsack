/**
 * LongMemEval-S benchmark — retrieval recall@K on the cleaned LongMemEval
 * dataset (xiaowu0162/longmemeval-cleaned).
 *
 * Methodology matches agentmemory/longmemeval-bench.ts:
 * 1. Per question: index all haystack sessions as memory entries
 * 2. Query with question text, retrieve top-K
 * 3. Check if ANY gold session ID appears in results (recall_any@K)
 *
 * Run: npx vitest run test/bench/longmemeval.bench.ts
 * Prereq: python3 -c "from huggingface_hub import hf_hub_download; hf_hub_download(...)"
 */

import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDB } from "../../src/core/database.js";
import { scoreAndRank } from "../../src/pillar2-memory/scoring.js";

interface LMEQuestion {
	question_id: string;
	question_type: string;
	question: string;
	answer: string;
	answer_session_ids: string[];
	haystack_session_ids: string[];
	haystack_sessions: Array<Array<{ role: string; content: string }>>;
}

interface LMEBenchRow {
	type: string;
	count: number;
	r5: number;
	r10: number;
	r20: number;
}

function loadQuestions(): LMEQuestion[] {
	return JSON.parse(readFileSync("test/bench/data/longmemeval_s_cleaned.json", "utf8"));
}

/** Get gold session IDs as a Set for fast lookup */
function goldSessionSet(q: LMEQuestion): Set<string> {
	return new Set(q.answer_session_ids);
}

/** Format a session's turns into a single text block, tagging with session ID */
function formatSession(sessionId: string, turns: Array<{ role: string; content: string }>): string {
	const prefix = `[session:${sessionId}] `;
	const text = turns.map((t) => `${t.role}: ${t.content}`).join(" ");
	return prefix + text.slice(0, 500);
}

describe("LongMemEval-S retrieval benchmark", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "knapsack-lme-"));

	it("recall@K on 500 questions (sample first 50)", async () => {
		const allQuestions = loadQuestions();
		const questions = allQuestions.slice(0, 50);

		const byType = new Map<string, LMEBenchRow>();

		console.log("\n── LONGMEMEVAL-S BENCHMARK (BM25 + RRF) ──");
		console.log("| Type | Count | R@5 | R@10 | R@20 |");
		console.log("|------|-------|------|------|------|");

		for (const q of questions) {
			const dbPath = join(tmpDir, `lme-${q.question_id}.db`);
			const db = await createDB(dbPath);
			const gold = goldSessionSet(q);

			for (let i = 0; i < q.haystack_sessions.length; i++) {
				const sid = q.haystack_session_ids[i]!;
				const content = formatSession(sid, q.haystack_sessions[i]!);
				db.saveMemory({ content, type: "fact", importance: 0.5 });
			}

			const all = db.getAllMemories();
			const ranked = await scoreAndRank(q.question, all, all, 20);
			const retrieved = ranked.map((r) => r.entry.content);

			const r5 = checkRecall(retrieved, gold, 5);
			const r10 = checkRecall(retrieved, gold, 10);
			const r20 = checkRecall(retrieved, gold, 20);

			const row = byType.get(q.question_type) ?? {
				type: q.question_type,
				count: 0,
				r5: 0,
				r10: 0,
				r20: 0,
			};
			row.count++;
			row.r5 += r5;
			row.r10 += r10;
			row.r20 += r20;
			byType.set(q.question_type, row);

			db.close();
			try {
				unlinkSync(dbPath);
			} catch {}
		}

		for (const row of byType.values()) {
			console.log(
				`| ${row.type.padEnd(24)} | ${String(row.count).padStart(5)} | ${((row.r5 / row.count) * 100).toFixed(1).padStart(4)}% | ${((row.r10 / row.count) * 100).toFixed(1).padStart(4)}% | ${((row.r20 / row.count) * 100).toFixed(1).padStart(4)}% |`,
			);
		}

		let total = 0,
			t5 = 0,
			t10 = 0,
			t20 = 0;
		for (const row of byType.values()) {
			total += row.count;
			t5 += row.r5;
			t10 += row.r10;
			t20 += row.r20;
		}
		console.log(
			`| ${"OVERALL (50q)".padEnd(24)} | ${String(total).padStart(5)} | ${((t5 / total) * 100).toFixed(1).padStart(4)}% | ${((t10 / total) * 100).toFixed(1).padStart(4)}% | ${((t20 / total) * 100).toFixed(1).padStart(4)}% |`,
		);
		console.log(
			`\nCompared: agentmemory BM25+Vector R@5=95.2% R@10=98.6% (full 500q) — knapsack uses BM25+RRF only, no vectors`,
		);

		const overallR5 = t5 / total;
		expect(overallR5).toBeGreaterThan(0.3);
	}, 120_000);

	it("full 500 question run (benchmark mode)", async () => {
		const questions = loadQuestions();
		const byType = new Map<string, LMEBenchRow>();

		for (const q of questions) {
			const dbPath = join(tmpDir, `lme-full-${q.question_id}.db`);
			const db = await createDB(dbPath);
			const gold = goldSessionSet(q);

			for (let i = 0; i < q.haystack_sessions.length; i++) {
				const sid = q.haystack_session_ids[i]!;
				const content = formatSession(sid, q.haystack_sessions[i]!);
				db.saveMemory({ content, type: "fact", importance: 0.5 });
			}

			const all = db.getAllMemories();
			const ranked = await scoreAndRank(q.question, all, all, 20);
			const retrieved = ranked.map((r) => r.entry.content);

			const row = byType.get(q.question_type) ?? {
				type: q.question_type,
				count: 0,
				r5: 0,
				r10: 0,
				r20: 0,
			};
			row.count++;
			row.r5 += checkRecall(retrieved, gold, 5);
			row.r10 += checkRecall(retrieved, gold, 10);
			row.r20 += checkRecall(retrieved, gold, 20);
			byType.set(q.question_type, row);
			db.close();
		}

		console.log("\n── LONGMEMEVAL-S FULL 500q ──");
		console.log(`| Type | Count | R@5 | R@10 | R@20 |`);
		console.log("|------|-------|------|------|------|");

		for (const row of byType.values()) {
			console.log(
				`| ${row.type.padEnd(24)} | ${String(row.count).padStart(5)} | ${(row.r5 / row.count).toFixed(3)} | ${(row.r10 / row.count).toFixed(3)} | ${(row.r20 / row.count).toFixed(3)} |`,
			);
		}

		let total = 0,
			t5 = 0,
			t10 = 0,
			t20 = 0;
		for (const row of byType.values()) {
			total += row.count;
			t5 += row.r5;
			t10 += row.r10;
			t20 += row.r20;
		}
		console.log(
			`| ${"OVERALL".padEnd(24)} | ${String(total).padStart(5)} | ${(t5 / total).toFixed(3)} | ${(t10 / total).toFixed(3)} | ${(t20 / total).toFixed(3)} |`,
		);
	}, 600_000);
});

/** Check if any gold session ID appears in top-K retrieved content */
function checkRecall(retrieved: string[], gold: Set<string>, k: number): number {
	for (let i = 0; i < Math.min(k, retrieved.length); i++) {
		const content = retrieved[i]!;
		for (const gid of gold) {
			if (content.includes(gid)) return 1;
		}
	}
	return 0;
}

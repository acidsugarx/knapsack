import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDB } from "../../src/core/database.js";
import { scoreAndRank } from "../../src/pillar2-memory/scoring.js";

describe("scoring precision", () => {
	let tmp: string;
	afterAll(() => {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {}
	});

	it("ranks expected entry first for each query", async () => {
		tmp = mkdtempSync(join(tmpdir(), "kprec-"));
		const db = await createDB(join(tmp, "prec.db"));
		const seeds = [
			["sqlite wasm database engine storage", "decision", 0.9],
			["rrf ranking fusion algorithm cormack sigir", "decision", 0.9],
			["pnpm package manager node dependency resolution", "decision", 0.8],
			["api key secret credentials env dotenv", "fact", 0.7],
			["docker image node alpine multistage container", "fact", 0.5],
			["npm install native module compile error hung", "gotcha", 0.8],
			["import circular dependency module esm undefined", "gotcha", 0.8],
			["typescript strict mode tsconfig noimplicitany", "constraint", 0.9],
			["jwt bearer token authentication refresh endpoint", "constraint", 0.8],
			["oauth provider google github microsoft callback", "fact", 0.5],
			["redis cache ttl session rate limiting storage", "fact", 0.6],
			["github actions ci pipeline deploy staging merge", "fact", 0.7],
			["postgresql database port connection pooling 5432", "fact", 0.6],
			["vite react tailwind frontend dist build static", "fact", 0.5],
			["bcrypt password hashing salt rounds auth module", "fact", 0.6],
			["kubernetes hpa autoscaling cpu replicas config", "fact", 0.6],
			["prisma seed script database npx command tool", "fact", 0.5],
			["pytest configuration pyproject toml markers slow", "fact", 0.4],
			["cargo build release profile optimization lto rust", "fact", 0.4],
			["gin framework go router middleware chain handler", "fact", 0.3],
		];

		for (const [content, type, imp] of seeds) {
			db.saveMemory({ content, type: type as never, importance: imp as number });
		}
		const all = db.getAllMemories();

		const probes = [
			{ q: "sqlite database wasm storage", e: "sqlite" },
			{ q: "rrf ranking fusion algorithm", e: "rrf" },
			{ q: "package manager pnpm node", e: "pnpm" },
			{ q: "api key secret credentials", e: "api key" },
			{ q: "docker container image alpine", e: "docker" },
			{ q: "npm install error native hung", e: "npm install" },
			{ q: "circular dependency import esm", e: "import circular" },
			{ q: "typescript strict noimplicitany", e: "typescript" },
			{ q: "jwt token authentication bearer", e: "jwt" },
			{ q: "oauth provider config google", e: "oauth" },
		];

		let top1hits = 0;
		for (const p of probes) {
			const r = await scoreAndRank(p.q, all, all, 5);
			const topId = r[0]?.entry.content ?? "";
			if (topId.includes(p.e)) top1hits++;
			else console.log(`  MISS: "${p.q}" → "${topId.slice(0, 60)}" (expected: "${p.e}")`);
		}

		console.log(
			`\nPrecision@1: ${top1hits}/${probes.length} (${((top1hits / probes.length) * 100).toFixed(0)}%)`,
		);
		expect(top1hits).toBeGreaterThanOrEqual(7);
		db.close();
	}, 15000);
});

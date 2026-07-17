import { describe, expect, it } from "vitest";
import { compressCodeAST } from "../../src/pillar1-compression/strategies/code-ast.js";

describe("compressCodeAST (tree-sitter)", () => {
	it("extracts C function signatures with parameter types", async () => {
		const src = [
			"struct rq { int cpu; struct task_struct *curr; };",
			"static inline int __task_prio(const struct task_struct *p) { return p->prio; }",
			"void sched_core_enqueue(struct rq *rq, struct task_struct *p, int flags) { /* body */ }",
			"#define SCHED_FEAT(name, enabled) (1UL << __SCHED_FEAT_##name) * enabled",
		].join("\n");

		const result = await compressCodeAST(src, "c");

		expect(result).not.toBeNull();
		expect(result?.strategy).toBe("code-ast");
		expect(result?.body).toContain("__task_prio");
		expect(result?.body).toContain("sched_core_enqueue");
		// signatures carry parameter types so the model doesn't need the body
		expect(result?.body).toContain("struct task_struct");
		expect(result?.body).toContain("FUNCTIONS");
		expect(result?.body).toContain("STRUCTS");
		expect(result?.savingsPercent).toBeGreaterThan(0);
	});

	it("extracts TypeScript class, interface, function", async () => {
		const src = [
			'import { Foo } from "./foo";',
			"interface Bar { method(): void; }",
			"type Alias = string | number;",
			"export class Baz {",
			"  constructor(private x: number) {}",
			"  public doThing(): string { return this.x.toString(); }",
			"}",
			"export async function handler(req: Request): Promise<Response> { return new Response(); }",
		].join("\n");

		const result = await compressCodeAST(src, "typescript");

		expect(result).not.toBeNull();
		expect(result?.body).toContain("interface Bar");
		expect(result?.body).toContain("class Baz");
		expect(result?.body).toContain("function handler");
		// class methods are surfaced because class_declaration is a container
		expect(result?.body).toContain("doThing");
		expect(result?.body).toContain("IMPORTS");
		expect(result?.body).toContain("INTERFACES");
		expect(result?.savingsPercent).toBeGreaterThan(0);
	});

	it("returns null for unknown language", async () => {
		const result = await compressCodeAST("some code", "cobol");
		expect(result).toBeNull();
	});
});

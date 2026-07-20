import { describe, expect, it } from "vitest";
import { detectLanguageFromExt, loadLanguage } from "../../src/pillar1-compression/tree-sitter-loader.js";

describe("detectLanguageFromExt", () => {
	it("maps common source extensions to grammar ids", () => {
		expect(detectLanguageFromExt("kernel/sched/core.c")).toBe("c");
		expect(detectLanguageFromExt("header.h")).toBe("c");
		expect(detectLanguageFromExt("app.ts")).toBe("typescript");
		expect(detectLanguageFromExt("component.tsx")).toBe("tsx");
		expect(detectLanguageFromExt("script.js")).toBe("javascript");
		expect(detectLanguageFromExt("module.mjs")).toBe("javascript");
		expect(detectLanguageFromExt("view.jsx")).toBe("javascript");
		expect(detectLanguageFromExt("service.py")).toBe("python");
		expect(detectLanguageFromExt("main.go")).toBe("go");
		expect(detectLanguageFromExt("lib.rs")).toBe("rust");
	});

	it("is case-insensitive on the extension", () => {
		expect(detectLanguageFromExt("FOO.C")).toBe("c");
		expect(detectLanguageFromExt("App.TS")).toBe("typescript");
	});

	it("returns null for unknown extensions and missing filenames", () => {
		expect(detectLanguageFromExt("readme.md")).toBeNull();
		expect(detectLanguageFromExt("data.csv")).toBeNull();
		expect(detectLanguageFromExt("noext")).toBeNull();
		expect(detectLanguageFromExt(undefined)).toBeNull();
	});
});

describe("loadLanguage", () => {
	it("loads the C grammar from the tree-sitter-c package", async () => {
		const lang = await loadLanguage("c");
		expect(lang).not.toBeNull();
		// The loaded grammar can parse a tiny C snippet without throwing.
		// (Full round-trip parsing is covered by code-ast.test.ts.)
	});

	it("loads typescript and tsx grammars", async () => {
		expect(await loadLanguage("typescript")).not.toBeNull();
		expect(await loadLanguage("tsx")).not.toBeNull();
	});

	it("loads javascript, python, go, rust grammars", async () => {
		expect(await loadLanguage("javascript")).not.toBeNull();
		expect(await loadLanguage("python")).not.toBeNull();
		expect(await loadLanguage("go")).not.toBeNull();
		expect(await loadLanguage("rust")).not.toBeNull();
	});

	it("returns null for unknown grammar ids", async () => {
		expect(await loadLanguage("cobol")).toBeNull();
		expect(await loadLanguage("")).toBeNull();
	});

	it("caches loaded grammars — second call is the same object", async () => {
		const first = await loadLanguage("c");
		const second = await loadLanguage("c");
		// Same instance — proves the cache hit. Avoids re-reading the wasm.
		expect(second).toBe(first);
	});
});

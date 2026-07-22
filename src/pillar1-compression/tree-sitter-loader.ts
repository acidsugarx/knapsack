/**
 * Lazy tree-sitter language loader.
 *
 * Loads grammar `.wasm` files from `node_modules/tree-sitter-<lang>/` packages.
 * Languages are cached per-process after first load. Falls back gracefully
 * (returns null) when a grammar is missing or fails to load.
 *
 * @module tree-sitter-loader
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Language, Parser } from "web-tree-sitter";

let initPromise: Promise<void> | null = null;
const langCache = new Map<string, Language | null>();

/** Map language id → npm grammar package that ships the `.wasm` file. */
const GRAMMAR_PKG: Record<string, { pkg: string; wasm: string }> = {
	c: { pkg: "tree-sitter-c", wasm: "tree-sitter-c.wasm" },
	typescript: {
		pkg: "tree-sitter-typescript",
		wasm: "tree-sitter-typescript.wasm",
	},
	tsx: { pkg: "tree-sitter-typescript", wasm: "tree-sitter-tsx.wasm" },
	javascript: {
		pkg: "tree-sitter-javascript",
		wasm: "tree-sitter-javascript.wasm",
	},
	python: { pkg: "tree-sitter-python", wasm: "tree-sitter-python.wasm" },
	go: { pkg: "tree-sitter-go", wasm: "tree-sitter-go.wasm" },
	rust: { pkg: "tree-sitter-rust", wasm: "tree-sitter-rust.wasm" },
};

const require = createRequire(import.meta.url);

/** Initialise web-tree-sitter WASM runtime once; resets on failure so callers can retry. */
async function ensureInit(): Promise<void> {
	if (!initPromise) {
		initPromise = Parser.init().catch(() => {
			// If WASM init fails, mark as failed so callers fall back.
			initPromise = null;
			throw new Error("web-tree-sitter init failed");
		});
	}
	return initPromise;
}

/**
 * Load a tree-sitter grammar by language id.
 *
 * @param name - One of the keys of {@link GRAMMAR_PKG} (`c`, `typescript`,
 * `tsx`, `javascript`, `python`, `go`, `rust`).
 * @returns The loaded `Language`, or null if the language is unknown, the
 * grammar package is not installed, or loading fails. Callers must handle
 * null by falling back to the regex strategy.
 */
export async function loadLanguage(name: string): Promise<Language | null> {
	const spec = GRAMMAR_PKG[name];
	if (!spec) return null;
	if (langCache.has(name)) return langCache.get(name) ?? null;

	let result: Language | null = null;
	try {
		await ensureInit();
		const pkgJsonPath = require.resolve(`${spec.pkg}/package.json`);
		const wasmPath = join(dirname(pkgJsonPath), spec.wasm);
		const bytes = readFileSync(wasmPath);
		result = await Language.load(bytes);
	} catch {
		result = null;
	}
	langCache.set(name, result);
	return result;
}

/**
 * Detect language from a filename extension or simple content heuristics.
 *
 * @param filename - Filename to inspect (e.g. `core.c`, `app.tsx`).
 * @returns One of the keys of {@link GRAMMAR_PKG}, or null if unknown.
 */
export function detectLanguageFromExt(filename?: string): string | null {
	if (!filename) return null;
	const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
	switch (ext) {
		case "c":
		case "h":
			return "c";
		case "ts":
			return "typescript";
		case "tsx":
			return "tsx";
		case "js":
		case "mjs":
		case "cjs":
		case "jsx":
			return "javascript";
		case "py":
			return "python";
		case "go":
			return "go";
		case "rs":
			return "rust";
		default:
			return null;
	}
}

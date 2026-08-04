/**
 * Code compression strategy — Headroom-style: extract structure + body snippets.
 *
 * ## Approach
 *
 * Uses regex-based heuristics to extract imports, exports, and
 * function/class definitions with the first 5 lines of each body preserved.
 * The model can understand the logical flow without needing knapsack_retrieve.
 *
 * ## Limitations
 *
 * - Regex-based — won't handle all edge cases (nested generics, complex decorators)
 * - Prefer the tree-sitter AST strategy (code-ast.ts) when grammars are available
 * - Language support: TypeScript, JavaScript, Python (basic)
 *
 * @module code-compression
 */

import { sha256 } from "../../core/hash";
import { estimateTokens, estimateTokensCode, savingsPercent } from "../../core/tokens";
import type { CompressionResult } from "../../core/types";

/**
 * Extract imports/requires from source code.
 *
 * Handles:
 * - `import { X } from "y"` / `import X from "y"`
 * - `import "y"` (side-effect)
 * - `import type { X } from "y"`
 * - `const X = require("y")`
 * - `export { X } from "y"` (re-exports)
 */
function extractImports(source: string): string[] {
	const imports: string[] = [];
	const lines = source.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (/^import\b/.test(trimmed) || /^(?:const|let|var)\s+\w+\s*=\s*require\(/.test(trimmed)) {
			// Collapse multi-line imports to one line
			if (trimmed.endsWith(";") || trimmed.endsWith('"') || trimmed.endsWith("'")) {
				imports.push(trimmed);
			} else {
				imports.push(`${trimmed} …`);
			}
		}
	}

	// Deduplicate
	return [...new Set(imports)];
}

/**
 * Extract export statements from source code.
 *
 * Handles:
 * - `export class/function/const/interface/type/enum X`
 * - `export default X`
 * - `export { X, Y }`
 */
function extractExports(source: string): string[] {
	const exports: string[] = [];
	const lines = source.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (/^export\b/.test(trimmed)) {
			if (trimmed.length > 120) {
				exports.push(`${trimmed.slice(0, 117)}…`);
			} else {
				exports.push(trimmed);
			}
		}
	}

	return [...new Set(exports)];
}

/** Maximum body lines to preserve for function/method/class definitions. */
const MAX_BODY_LINES = 5;

/**
 * Extract function, method, and class definitions with body snippet preservation.
 *
 * For each declaration, this extracts the signature line and the first
 * {@link MAX_BODY_LINES} lines of the body (indented), with a line-count
 * marker when truncated. This preserves enough signal for the model to
 * understand the logic without needing knapsack_retrieve for simple edits.
 *
 * Uses regex heuristics — for full accuracy, use the tree-sitter strategy.
 */
function extractDefinitions(source: string): string[] {
	const defs: string[] = [];
	const lines = source.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]!.trim();
		if (!trimmed) continue;

		// Match declaration patterns
		const isSig =
			/^(?:export\s+)?(?:async\s+)?(?:static\s+)?(?:private\s+)?(?:public\s+)?(?:protected\s+)?(?:function|class|interface|enum|type)\s/.test(
				trimmed,
			) ||
			/^(?:export\s+)?(?:async\s+)?(?:static\s+)?(?:private\s+)?(?:public\s+)?(?:protected\s+)?(?:get|set)\s+\w+\s*\(/.test(
				trimmed,
			) ||
			/^(?:export\s+)?(?:async\s+)?(?:static\s+)?(?:private\s+)?(?:public\s+)?(?:protected\s+)?(?:constructor|\w+)\s*\(/.test(
				trimmed,
			);

		if (!isSig) continue;

		// Check for inline body (single-line function)
		if (/\{\s*[^}]*\}/.test(trimmed)) {
			defs.push(trimmed.replace(/\s*\{[^}]*\}\s*$/, " {…}"));
			continue;
		}

		// Multi-line function: extract body snippet
		const sig = trimmed.replace(/\s*\{.*$/, "");

		// Find the opening brace — may be on next line (C-style) or on same line
		let bodyStart = i;
		if (trimmed.endsWith("{") || trimmed.endsWith(":")) {
			bodyStart = i + 1;
		} else {
			// Look for brace on next non-empty line
			let j = i + 1;
			while (j < lines.length && lines[j]!.trim() === "") j++;
			if (j < lines.length && lines[j]!.trim() === "{") {
				bodyStart = j + 1;
			}
		}

		if (bodyStart >= lines.length) {
			defs.push(`${sig} {…}`);
			continue;
		}

		// Collect first MAX_BODY_LINES of body
		const bodyLines: string[] = [];
		let bodyCount = 0;
		let k = bodyStart;
		while (k < lines.length && bodyCount < MAX_BODY_LINES) {
			const bl = lines[k]!.trim();
			if (bl === "}" || bl === "};" || bl === ");") break;
			if (bl) {
				bodyLines.push(bl.length > 100 ? `${bl.slice(0, 97)}…` : bl);
				bodyCount++;
			}
			k++;
		}

		// Rough estimate of total body lines
		let bodyEnd = k;
		while (
			bodyEnd < lines.length &&
			lines[bodyEnd]!.trim() !== "}" &&
			lines[bodyEnd]!.trim() !== "};"
		) {
			bodyEnd++;
		}
		const remainingLines = bodyEnd - k;

		if (bodyLines.length > 0) {
			const snippet = bodyLines.map((l) => `    ${l}`).join("\n");
			if (remainingLines > 0) {
				defs.push(`${sig} {\n${snippet}\n    … (${remainingLines} more lines)\n}`);
			} else {
				defs.push(`${sig} {\n${snippet}\n}`);
			}
		} else {
			defs.push(`${sig} {…}`);
		}

		// Skip to end of this function
		i = Math.max(i, bodyEnd);
	}

	return defs;
}

/**
 * Compress source code — Headroom-style: extract structure + body snippets.
 *
 * Preserves imports, exports, and definition signatures with the first
 * {@link MAX_BODY_LINES} lines of each body. The model can see the logical
 * flow without needing knapsack_retrieve for simple understanding.
 *
 * Falls back to the tree-sitter AST strategy when grammars are available.
 *
 * @param source - Source code to compress
 * @param _language - Language hint (unused, regex is language-agnostic)
 * @returns Compression result with structured outline + body snippets
 */
export function compressCode(source: string, _language = "typescript"): CompressionResult {
	const imports = extractImports(source);
	const exports = extractExports(source);
	const definitions = extractDefinitions(source);

	const lines = source.split("\n");
	const stats = {
		lines: lines.length,
		chars: source.length,
		imports: imports.length,
		exports: exports.length,
		definitions: definitions.length,
	};

	const sections: string[] = [];

	if (imports.length > 0) {
		sections.push(
			`── IMPORTS (${imports.length}) ──\n${imports.slice(0, 20).join("\n")}${imports.length > 20 ? `\n(+${imports.length - 20} more)` : ""}`,
		);
	}

	if (exports.length > 0) {
		sections.push(
			`── EXPORTS (${exports.length}) ──\n${exports.slice(0, 15).join("\n")}${exports.length > 15 ? `\n(+${exports.length - 15} more)` : ""}`,
		);
	}

	if (definitions.length > 0) {
		sections.push(
			`── DEFINITIONS (${definitions.length}) ──\n${definitions.slice(0, 15).join("\n")}${definitions.length > 15 ? `\n(+${definitions.length - 15} more)` : ""}`,
		);
	}

	const body = `📦 ${stats.lines} lines · ${stats.imports} imports · ${stats.exports} exports · ${stats.definitions} definitions\n\n${sections.join("\n\n")}`;

	const originalTokens = estimateTokensCode(source);
	const compressedTokens = estimateTokens(body);

	return {
		body,
		hash: sha256(source),
		originalTokens,
		compressedTokens,
		savingsPercent: savingsPercent(originalTokens, compressedTokens),
		strategy: "code",
	};
}

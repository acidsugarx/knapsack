/**
 * Code compression strategy — extract structure, collapse bodies.
 *
 * ## Approach
 *
 * Uses regex-based heuristics to extract imports, exports, function/class
 * signatures, and type definitions. Function bodies are collapsed to `{…}`
 * with line counts.
 *
 * ## Limitations (v0.1)
 *
 * - Regex-based — won't handle all edge cases (nested generics, complex decorators)
 * - No AST awareness — can't distinguish method overrides from new methods
 * - Language support: TypeScript, JavaScript, Python (basic)
 *
 * ## Future
 *
 * When tree-sitter WASM is available as optional dependency, a tree-sitter
 * strategy will replace this with full AST accuracy. This strategy remains
 * as the zero-dependency fallback.
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

/**
 * Extract function and method signatures.
 *
 * Uses regex to find lines that look like function/method/class declarations.
 * Includes the opening brace line if on the same line, collapsed to {…}.
 *
 * This is a heuristic — for full accuracy, use the tree-sitter strategy.
 */
function extractSignatures(source: string): string[] {
	const signatures: string[] = [];
	const lines = source.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
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

		if (isSig) {
			// Collapse inline body to {…}
			const collapsed = trimmed.replace(/\s*\{[^}]*\}\s*$/, " {…}").replace(/\s*\{.*$/, " {…}");
			signatures.push(collapsed);
		}
	}

	return signatures;
}

/**
 * Compress source code by extracting structure and collapsing bodies.
 *
 * @param source - Source code to compress
 * @param language - Language hint ("typescript", "javascript", "python")
 * @returns Compression result with structured outline
 */
export function compressCode(source: string, _language = "typescript"): CompressionResult {
	const imports = extractImports(source);
	const exports = extractExports(source);
	const signatures = extractSignatures(source);

	const lines = source.split("\n");
	const stats = {
		lines: lines.length,
		chars: source.length,
		imports: imports.length,
		exports: exports.length,
		signatures: signatures.length,
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

	if (signatures.length > 0) {
		sections.push(
			`── SIGNATURES (${signatures.length}) ──\n${signatures.slice(0, 30).join("\n")}${signatures.length > 30 ? `\n(+${signatures.length - 30} more)` : ""}`,
		);
	}

	const body = `📦 ${stats.lines} lines · ${stats.imports} imports · ${stats.exports} exports · ${stats.signatures} signatures\n\n${sections.join("\n\n")}`;

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

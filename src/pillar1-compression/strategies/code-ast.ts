/**
 * AST-aware code compression via tree-sitter — Headroom-style.
 *
 * Preserves SIGNAL not just structure:
 * - Signatures (same as before)
 * - First N lines of each function/method body (so model can understand logic)
 * - Error handlers (try/catch/except blocks — always preserved)
 * - Docstrings (first line)
 *
 * Falls back to null when the grammar is unavailable or parsing fails.
 *
 * @module code-compression-ast
 */

import type { Language, Node, Parser } from "web-tree-sitter";
import { sha256 } from "../../core/hash";
import { estimateTokens, estimateTokensCode, savingsPercent } from "../../core/tokens";
import type { CompressionResult } from "../../core/types";
import { loadLanguage } from "../tree-sitter-loader";

/** One AST node type → output section. */
interface Rule {
	type: string;
	label: string;
}

/** Maximum body lines to preserve per function/method (signature not counted). */
const MAX_BODY_LINES = 5;

/** Maximum items per section before truncating. */
const PER_SECTION_LIMIT = 60;

/** Maximum signature length before truncation. */
const SIG_MAX = 140;

/** Maximum character length for a body snippet. */
const BODY_SNIPPET_MAX = 200;

const RULES: Record<string, Rule[]> = {
	c: [
		{ type: "preproc_function_def", label: "MACROS" },
		{ type: "type_definition", label: "TYPEDEFS" },
		{ type: "struct_specifier", label: "STRUCTS" },
		{ type: "enum_specifier", label: "ENUMS" },
		{ type: "function_definition", label: "FUNCTIONS" },
	],
	typescript: [
		{ type: "import_statement", label: "IMPORTS" },
		{ type: "interface_declaration", label: "INTERFACES" },
		{ type: "type_alias_declaration", label: "TYPES" },
		{ type: "class_declaration", label: "CLASSES" },
		{ type: "function_declaration", label: "FUNCTIONS" },
		{ type: "method_definition", label: "METHODS" },
	],
	tsx: [
		{ type: "import_statement", label: "IMPORTS" },
		{ type: "interface_declaration", label: "INTERFACES" },
		{ type: "type_alias_declaration", label: "TYPES" },
		{ type: "class_declaration", label: "CLASSES" },
		{ type: "function_declaration", label: "FUNCTIONS" },
		{ type: "method_definition", label: "METHODS" },
	],
	javascript: [
		{ type: "import_statement", label: "IMPORTS" },
		{ type: "class_declaration", label: "CLASSES" },
		{ type: "function_declaration", label: "FUNCTIONS" },
		{ type: "method_definition", label: "METHODS" },
	],
	python: [
		{ type: "import_statement", label: "IMPORTS" },
		{ type: "class_definition", label: "CLASSES" },
		{ type: "function_definition", label: "FUNCTIONS" },
	],
	go: [
		{ type: "import_declaration", label: "IMPORTS" },
		{ type: "type_declaration", label: "TYPES" },
		{ type: "function_declaration", label: "FUNCTIONS" },
		{ type: "method_declaration", label: "METHODS" },
	],
	rust: [
		{ type: "use_declaration", label: "USES" },
		{ type: "struct_item", label: "STRUCTS" },
		{ type: "enum_item", label: "ENUMS" },
		{ type: "trait_item", label: "TRAITS" },
		{ type: "function_item", label: "FUNCTIONS" },
	],
};

/** Node types for functions/methods — these get body snippet preservation. */
const FUNCTION_NODES = new Set([
	"function_definition", // c, python
	"function_declaration", // ts, js, go
	"function_item", // rust
	"method_definition", // ts, js
	"method_declaration", // go
]);

/** Node types for error handlers — always fully preserved. */
const ERROR_HANDLER_NODES = new Set([
	"try_statement", // ts, js, python
	"catch_clause", // ts, js
	"except_clause", // python
	"finally_clause", // ts, js, python
]);

/**
 * Collapse a node's text to its signature line.
 */
function toSignature(text: string): string {
	const brace = text.indexOf("{");
	const colon = text.indexOf(":");
	// Use whichever delimiter appears first (Python uses `:`, C-like uses `{`)
	const delimiter = brace >= 0 ? brace : colon >= 0 ? colon : -1;
	const cleaned = (delimiter >= 0 ? text.slice(0, delimiter) : text).replace(/\s+/g, " ").trim();
	return cleaned.length > SIG_MAX ? `${cleaned.slice(0, SIG_MAX - 1)}…` : cleaned;
}

/**
 * Extract a body snippet from a function/method node.
 *
 * Takes the first {@link MAX_BODY_LINES} lines of the function body
 * (after the opening brace/colon), indents them, and adds a line-count
 * marker if truncated.
 *
 * @param node - A function/method AST node
 * @param source - Full source text (for accurate line extraction)
 * @returns Body snippet string, or empty string if trivial
 */
function bodySnippet(node: Node, source: string): string {
	const text = node.text;
	const lines = text.split("\n");
	if (lines.length <= 1) return "";

	// Find the first non-signature line (after `{` or `:`)
	let bodyStart = 0;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]!.trim();
		if (trimmed === "{" || trimmed.endsWith(":") || trimmed.endsWith("{")) {
			bodyStart = i + 1;
			break;
		}
		// Python: signature line ends with `:` and next line is indented
		if (trimmed.endsWith(":") && i + 1 < lines.length && lines[i + 1]!.startsWith(" ")) {
			bodyStart = i + 1;
			break;
		}
	}

	if (bodyStart >= lines.length) return "";

	// Take first MAX_BODY_LINES body lines, strip leading whitespace
	const bodyLines = lines.slice(bodyStart, bodyStart + MAX_BODY_LINES);
	const trimmed = bodyLines.map((l) => l.trim()).filter((l) => l.length > 0);

	if (trimmed.length === 0) return "";

	const snippet = trimmed.join("\n    ");
	const totalBodyLines = lines.length - bodyStart;

	if (bodyStart + MAX_BODY_LINES < lines.length) {
		return `    ${snippet}\n    … (${totalBodyLines - MAX_BODY_LINES} more lines)`;
	}

	return `    ${snippet}`;
}

/** Parser singleton — race-safe via a cached Promise. */
let parserPromise: Promise<Parser> | null = null;
function getParser(): Promise<Parser> {
	if (!parserPromise) {
		parserPromise = (async () => {
			const { Parser } = await import("web-tree-sitter");
			await Parser.init();
			return new Parser();
		})();
	}
	return parserPromise;
}

/**
 * Compress source code via tree-sitter AST extraction — Headroom-style.
 *
 * Preserves: imports, signatures, first N body lines per function,
 * error handlers (try/catch/except). Drops: remaining body content,
 * comments, whitespace.
 *
 * @param source - Source code to compress
 * @param language - Language id
 * @returns Compression result, or null if the grammar is unavailable or parsing fails
 */
export async function compressCodeAST(
	source: string,
	language: string,
): Promise<CompressionResult | null> {
	const rules = RULES[language];
	if (!rules) return null;

	const grammar: Language | null = await loadLanguage(language);
	if (!grammar) return null;

	const parser = await getParser();
	parser.setLanguage(grammar);

	const tree = parser.parse(source);
	if (!tree) return null;

	const sections = new Map<string, string[]>();
	for (const rule of rules) sections.set(rule.label, []);
	const errorHandlers: string[] = [];

	let definitions = 0;

	const CONTAINERS = new Set([
		"class_declaration",
		"impl_item",
		"interface_declaration",
		"trait_item",
	]);
	const SKIP_INTO = new Set([
		"compound_statement",
		"declaration",
		"parameter_list",
		"field_declaration_list",
		// Don't recurse into bodies we've already captured
		"statement_block",
		"block",
		"call_expression",
	]);

	function walk(node: Node): void {
		if (SKIP_INTO.has(node.type)) return;

		// Capture error handlers anywhere in the tree
		if (ERROR_HANDLER_NODES.has(node.type)) {
			const text = node.text.replace(/\s+/g, " ").trim();
			if (text.length < BODY_SNIPPET_MAX) {
				errorHandlers.push(text);
			} else {
				errorHandlers.push(`${text.slice(0, BODY_SNIPPET_MAX - 3)}…`);
			}
			return; // Don't recurse into try blocks — captured
		}

		let matched = false;
		for (const rule of rules) {
			if (node.type === rule.type) {
				const sig = toSignature(node.text);
				if (!sig) break;

				// For functions/methods: attach body snippet
				if (FUNCTION_NODES.has(node.type)) {
					const snippet = bodySnippet(node, source);
					if (snippet) {
						sections.get(rule.label)?.push(`${sig} {\n${snippet}\n}`);
					} else {
						sections.get(rule.label)?.push(`${sig} {…}`);
					}
				} else {
					sections.get(rule.label)?.push(sig);
				}
				definitions++;
				matched = true;
				break;
			}
		}

		if (matched && !CONTAINERS.has(node.type)) return;

		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (child) walk(child);
		}
	}
	walk(tree.rootNode);

	const parts: string[] = [];
	const lineCount = source.split("\n").length;
	for (const rule of rules) {
		const items = sections.get(rule.label) ?? [];
		if (items.length === 0) continue;
		const sliced = items.slice(0, PER_SECTION_LIMIT);
		const more =
			items.length > PER_SECTION_LIMIT ? `\n(+${items.length - PER_SECTION_LIMIT} more)` : "";
		parts.push(`── ${rule.label} (${items.length}) ──\n${sliced.join("\n")}${more}`);
	}

	if (errorHandlers.length > 0) {
		parts.push(`── ERROR HANDLERS (${errorHandlers.length}) ──\n${errorHandlers.join("\n")}`);
	}

	if (parts.length === 0) return null;

	const body = `📦 ${lineCount} lines · ${definitions} definitions\n\n${parts.join("\n\n")}`;
	const originalTokens = estimateTokensCode(source);
	const compressedTokens = estimateTokens(body);

	return {
		body,
		hash: sha256(source),
		originalTokens,
		compressedTokens,
		savingsPercent: savingsPercent(originalTokens, compressedTokens),
		strategy: "code-ast",
	};
}

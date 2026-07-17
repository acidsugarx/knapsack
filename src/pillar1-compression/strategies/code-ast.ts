/**
 * AST-aware code compression via tree-sitter.
 *
 * Uses tree-sitter grammars (lazy-loaded WASM) to extract an accurate
 * structural outline: imports, function signatures, struct/class/interface
 * declarations, type aliases. Bodies are dropped.
 *
 * Falls back to null when the grammar is unavailable or parsing fails — the
 * caller (registry) then falls through to the regex strategy.
 *
 * ## Per-language extraction rules
 *
 * Each language declares which AST node types to surface, ordered by output
 * priority. A node becomes one line: its signature (text up to the first `{`)
 * collapsed to single-space form and truncated to ~140 chars.
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
	/** tree-sitter node type to match. */
	type: string;
	/** Section heading in the compressed output. */
	label: string;
}

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

const PER_SECTION_LIMIT = 60;
const SIG_MAX = 140;

/** Collapse a node's text to its signature line. */
function toSignature(text: string): string {
	const brace = text.indexOf("{");
	const cleaned = (brace >= 0 ? text.slice(0, brace) : text).replace(/\s+/g, " ").trim();
	return cleaned.length > SIG_MAX ? `${cleaned.slice(0, SIG_MAX - 1)}…` : cleaned;
}

let parserInstance: Parser | null = null;
async function getParser(): Promise<Parser> {
	if (!parserInstance) {
		const { Parser } = await import("web-tree-sitter");
		await Parser.init();
		parserInstance = new Parser();
	}
	return parserInstance;
}

/**
 * Compress source code via tree-sitter AST extraction.
 *
 * @param source - Source code to compress
 * @param language - Language id ("c", "typescript", "tsx", "javascript", "python", "go", "rust")
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

	let definitions = 0;

	/**
	 * Containers we recurse into after collecting (class/impl/trait bodies
	 * hold the methods the user wants to see).
	 */
	const CONTAINERS = new Set([
		"class_declaration",
		"impl_item",
		"interface_declaration",
		"trait_item",
	]);
	/**
	 * Nodes we never descend into — function bodies contain local
	 * declarations that would only add noise.
	 */
	const SKIP_INTO = new Set([
		"compound_statement",
		"declaration",
		"parameter_list",
		"field_declaration_list",
	]);

	function walk(node: Node): void {
		if (SKIP_INTO.has(node.type)) return;

		let matched = false;
		for (const rule of rules) {
			if (node.type === rule.type) {
				const sig = toSignature(node.text);
				if (sig) {
					sections.get(rule.label)?.push(sig);
					definitions++;
				}
				matched = true;
				break;
			}
		}

		// If we matched a non-container declaration, do not descend
		// (avoids catching local declarations inside a body). Containers
		// still recurse so methods are surfaced.
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

/**
 * Default compression strategy registry — registers all built-in strategies.
 *
 * Third-party packages can add custom strategies by importing `createRegistry`
 * and calling `registry.register(myStrategy)` in a pi extension.
 *
 * @module registry-setup
 */

import { detectContentType } from "./detect";
import { createRegistry, type StrategyRegistry } from "./plugin";
import { compressBash } from "./strategies/bash";
import { compressCode } from "./strategies/code";
import { compressFind } from "./strategies/find";
import { compressGrep } from "./strategies/grep";
import { compressJson } from "./strategies/json";

/**
 * Create and configure the default strategy registry with all built-in strategies.
 *
 * Registering order matters: first registered content detector wins for auto-routing.
 *
 * @returns Configured StrategyRegistry ready for use in the compression hook
 */
export function createDefaultRegistry(): StrategyRegistry {
	const registry = createRegistry();

	// ── Bash strategy ────────────────────────────────────
	registry.register({
		name: "bash",
		label: "Bash Output",
		contentTypes: ["bash"],
		threshold: 1500,
		compress(output, ctx) {
			const exitCode = ctx?.exitCode ?? 0;
			return compressBash(output, undefined, exitCode);
		},
	});

	// ── Grep strategy ────────────────────────────────────
	registry.register({
		name: "grep",
		label: "Grep Results",
		contentTypes: ["grep", "ffgrep"],
		threshold: 1000,
		compress(output) {
			return compressGrep(output);
		},
	});

	// ── Find strategy ────────────────────────────────────
	registry.register({
		name: "find",
		label: "Find Results",
		contentTypes: ["find", "fffind"],
		threshold: 500,
		compress(output) {
			return compressFind(output);
		},
	});

	// ── Code strategy ────────────────────────────────────
	registry.register({
		name: "code",
		label: "Source Code",
		contentTypes: ["read", "code"],
		threshold: 2000,
		compress(output, ctx) {
			const lang = ctx?.language ?? detectLanguage(output);
			return compressCode(output, lang);
		},
	});

	// ── JSON strategy ────────────────────────────────────
	registry.register({
		name: "json",
		label: "JSON Data",
		contentTypes: ["json"],
		threshold: 1000,
		compress(output) {
			return compressJson(output);
		},
	});

	// ── Content detectors for auto-routing ────────────────
	registry.registerDetector({
		name: "json",
		detect(output) {
			const trimmed = output.trim();
			return /^\s*[[{]/.test(trimmed) && !/^\[(ERROR|WARN|INFO|DEBUG)/.test(trimmed);
		},
	});

	registry.registerDetector({
		name: "grep",
		detect(output) {
			const lines = output.split("\n").filter(Boolean);
			const grepLines = lines.filter((l) => {
				const match = l.match(/^(.+?):(\d+):(.*)$/);
				if (!match) return false;
				const file = match[1] ?? "";
				return file.includes("/") || /\.[a-z]{1,6}$/i.test(file);
			});
			return grepLines.length > 0 && grepLines.length >= lines.length * 0.6;
		},
	});

	registry.registerDetector({
		name: "bash",
		detect(output) {
			const auto = detectContentType(output);
			return auto === "bash";
		},
	});

	registry.registerDetector({
		name: "find",
		detect(output) {
			const auto = detectContentType(output);
			return auto === "find";
		},
	});

	return registry;
}

/**
 * Simple language detection from source code.
 *
 * Checks for common patterns: TypeScript type annotations, JSX, Python keywords.
 *
 * @param source - Source code
 * @returns Language identifier
 */
function detectLanguage(source: string): string {
	if (/^\s*import\s+type\b/m.test(source)) return "typescript";
	if (/:\s*(string|number|boolean|void|any|never)\b/.test(source)) return "typescript";
	if (/def\s+\w+\s*\(/.test(source)) return "python";
	if (/<\w+[^>]*>/.test(source) && /import\s+React/.test(source)) return "tsx";
	return "javascript";
}

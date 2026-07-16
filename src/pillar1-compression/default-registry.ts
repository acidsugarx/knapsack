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

	// ── Unified content detector (all routing via detectContentType) ──
	for (const type of ["json", "grep", "bash", "find"] as const) {
		registry.registerDetector({
			name: type,
			detect(output) {
				return detectContentType(output) === type;
			},
		});
	}

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

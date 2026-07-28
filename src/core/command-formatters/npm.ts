/**
 * NPM command formatters — install, test.
 *
 * @module npm-formatters
 */

import type { CompressionResult } from "../types";
import { makeResult } from "./index";

/**
 * Check if a command is an npm/pnpm/yarn install.
 */
export function matchNpm(command: string, subcommand: string): boolean {
	if (subcommand === "install") {
		return /^(npm|pnpm|yarn)\s+(install|i|add|ci)\b/.test(command.trim());
	}
	return (
		/^(npm|pnpm|yarn)\s+(test|t)\b/.test(command.trim()) ||
		/^(npm|pnpm)\s+run\s+(test|t)\b/.test(command.trim())
	);
}

/**
 * Format `npm install` output — strip progress, keep errors + summary.
 */
export function formatNpmInstall(output: string): CompressionResult | null {
	if (output.length < 200) return null;

	const lines = output.split("\n");
	const kept: string[] = [];
	let _addedCount = 0;
	let _auditCount = 0;

	for (const line of lines) {
		const trimmed = line.trim();
		if (/^(added|removed|changed|audited)\s+\d+/.test(trimmed)) {
			kept.push(trimmed);
			if (trimmed.startsWith("added")) {
				const m = trimmed.match(/added\s+(\d+)/);
				if (m) _addedCount = Number(m[1]);
			}
			if (trimmed.startsWith("audited")) {
				const m = trimmed.match(/audited\s+(\d+)/);
				if (m) _auditCount = Number(m[1]);
			}
			continue;
		}
		if (/npm warn/i.test(trimmed) || /npm error/i.test(trimmed)) {
			kept.push(trimmed);
			continue;
		}
		if (/^\s*[√✓✗×▶→]/.test(line) || /^\s*\+/.test(line)) continue;
		if (/^\s*$/.test(trimmed)) continue;
		if (/up to date|already|in \d+s/.test(trimmed)) {
			kept.push(trimmed);
			continue;
		}
		if (/^npm notice/i.test(trimmed)) continue;
		if (/^\s*[a-z].*@.*\s/.test(trimmed)) continue;
	}

	if (kept.length === 0) return null;
	return makeResult(`── npm install ──\n${kept.join("\n")}`, output, "npm-install");
}

/**
 * Format `npm test` output — delegate to test runner parser if recognizable,
 * otherwise keep summary + errors only.
 */
export function formatNpmTest(output: string): CompressionResult | null {
	if (output.includes("PASS ") || output.includes("FAIL ")) {
		return formatJestStyle(output);
	}
	if (output.includes("Test Files") || output.includes("Tests ")) {
		return formatVitestStyle(output);
	}

	const lines = output.split("\n");
	const kept: string[] = [];
	for (const line of lines) {
		if (/passing|failing|pending|✓|✗|FAIL|Error|assert|expected|received/i.test(line)) {
			kept.push(line);
		}
	}
	if (kept.length === 0) return null;
	return makeResult(`── npm test ──\n${kept.join("\n")}`, output, "npm-test");
}

function formatJestStyle(output: string): CompressionResult | null {
	const lines = output.split("\n");
	const kept: string[] = [];
	let passCount = 0;
	let failCount = 0;

	for (const line of lines) {
		if (line.startsWith("PASS ")) {
			passCount++;
			continue;
		}
		if (line.startsWith("FAIL ")) {
			kept.push(line);
			failCount++;
			continue;
		}
		if (line.startsWith("  ") && (line.includes("✓") || line.includes("✕") || line.includes("✗"))) {
			if (line.includes("✕") || line.includes("✗")) kept.push(line);
			continue;
		}
		if (/Tests:\s+\d+/.test(line) || /Test Suites:\s+\d+/.test(line)) {
			kept.push(line);
			continue;
		}
		if (/●|expect|Received|Expected|at\s+/.test(line)) {
			kept.push(line);
		}
	}

	if (kept.length === 0 && passCount === 0) return null;
	const summary = `── npm test (jest) ──\n${passCount} passed, ${failCount} failed\n${kept.join("\n")}`;
	return makeResult(summary, output, "npm-test");
}

function formatVitestStyle(output: string): CompressionResult | null {
	const lines = output.split("\n");
	const kept: string[] = [];

	for (const line of lines) {
		if (line.includes("Test Files") || line.includes("Tests ") || line.includes("Duration")) {
			kept.push(line);
			continue;
		}
		if (line.includes("FAIL") || line.includes("✗") || line.includes("×")) {
			kept.push(line);
			continue;
		}
		if (/AssertionError|Expected|Received|at\s+/.test(line)) {
			kept.push(line);
		}
	}

	if (kept.length === 0) return null;
	return makeResult(`── npm test (vitest) ──\n${kept.join("\n")}`, output, "npm-test");
}

/**
 * Format jest output — failures only.
 */
export function formatJest(output: string): CompressionResult | null {
	return formatJestStyle(output);
}

/**
 * Format vitest output — failures only.
 */
export function formatVitest(output: string): CompressionResult | null {
	return formatVitestStyle(output);
}

/**
 * Check if a command runs jest.
 */
export function matchJest(command: string): boolean {
	return /\bjest\b/.test(command.trim());
}

/**
 * Check if a command runs vitest.
 */
export function matchVitest(command: string): boolean {
	return /\bvitest\b/.test(command.trim());
}

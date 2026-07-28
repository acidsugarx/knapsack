/**
 * Python command formatters — pytest.
 *
 * @module python-formatters
 */

import type { CompressionResult } from "../types";
import { makeResult } from "./index";

/**
 * Check if a command runs pytest.
 */
export function matchPytest(command: string): boolean {
	return /\bpytest\b/.test(command.trim());
}

/**
 * Format `pytest` output — failures only with trimmed traceback,
 * passing tests collapsed to a count.
 */
export function formatPytest(output: string, _exitCode?: number): CompressionResult | null {
	if (!output.includes("===") && !output.includes("test session starts")) return null;

	const lines = output.split("\n");
	const kept: string[] = [];
	let inFailure = false;
	let inError = false;
	let failureCount = 0;
	let passCount = 0;
	let skipCount = 0;
	let errorCount = 0;
	let summaryLine = "";

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";

		if (/={4,}\s*FAILURES/.test(line)) {
			inFailure = true;
			inError = false;
			kept.push(line);
			continue;
		}
		if (/={4,}\s*ERRORS/.test(line)) {
			inError = true;
			inFailure = false;
			kept.push(line);
			continue;
		}
		if (/^={4,}/.test(line)) {
			inFailure = false;
			inError = false;
			if (line.includes("short test summary")) continue;
			if (line.includes("test session starts")) continue;
			if (line.includes("no tests ran")) continue;
			continue;
		}

		if (line.startsWith("PASSED") || line.includes(" PASSED")) {
			passCount++;
			continue;
		}
		if (line.startsWith("FAILED ") && line.includes(" - ")) {
			kept.push(line);
			continue;
		}
		if (line.startsWith("FAILED") || line.includes(" FAILED")) {
			failureCount++;
			kept.push(line);
			continue;
		}
		if (line.startsWith("ERROR") || line.includes(" ERROR")) {
			errorCount++;
			kept.push(line);
			continue;
		}
		if (line.startsWith("SKIPPED") || line.includes(" SKIPPED")) {
			skipCount++;
			continue;
		}

		if (inFailure || inError) {
			kept.push(line);
			continue;
		}

		if (
			/^\d+ passed/.test(line) ||
			/^\d+ failed/.test(line) ||
			/^\d+ error/.test(line) ||
			line.includes("===== ")
		) {
			if (line.includes("passed") || line.includes("failed") || line.includes("error")) {
				summaryLine = line;
			}
		}
	}

	if (summaryLine === "" && passCount === 0 && failureCount === 0 && errorCount === 0) return null;

	const parts: string[] = [`── pytest ──`];
	if (passCount > 0) parts.push(`Passed: ${passCount}`);
	if (failureCount > 0) parts.push(`Failed: ${failureCount}`);
	if (errorCount > 0) parts.push(`Errors: ${errorCount}`);
	if (skipCount > 0) parts.push(`Skipped: ${skipCount}`);
	if (summaryLine) parts.push(summaryLine.trim());

	if (kept.length > 0) {
		parts.push("", "── Failures/Errors ──", ...kept);
	}

	return makeResult(parts.join("\n"), output, "pytest");
}

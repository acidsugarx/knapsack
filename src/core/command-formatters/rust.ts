/**
 * Rust command formatters — cargo build, cargo test.
 *
 * @module rust-formatters
 */

import type { CompressionResult } from "../types";
import { makeResult } from "./index";

/**
 * Check if a command is a cargo subcommand.
 */
export function matchCargo(command: string, subcommand: string): boolean {
	return new RegExp(`^cargo\\s+${subcommand}\\b`).test(command.trim());
}

/**
 * Format `cargo build` output — errors + warnings only, strip compilation progress.
 */
export function formatCargoBuild(output: string): CompressionResult | null {
	if (!output.includes("Compiling") && !output.includes("error") && !output.includes("warning"))
		return null;

	const lines = output.split("\n");
	const kept: string[] = [];
	let warningCount = 0;
	let errorCount = 0;

	for (const line of lines) {
		if (/^error(\[|:)/.test(line)) {
			kept.push(line);
			errorCount++;
			continue;
		}
		if (/^warning:/.test(line)) {
			kept.push(line);
			warningCount++;
			continue;
		}
		if (line.startsWith("  --> ") || line.startsWith("   |") || line.startsWith("   =")) {
			kept.push(line);
			continue;
		}
		if (line.includes("Finished") || line.includes("error: could not compile")) {
			kept.push(line);
		}
	}

	if (kept.length === 0) return null;
	const header = `── cargo build ──\n${errorCount} errors, ${warningCount} warnings`;
	return makeResult(`${header}\n${kept.join("\n")}`, output, "cargo-build");
}

/**
 * Format `cargo test` output — failures only, passing tests collapsed to count.
 */
export function formatCargoTest(output: string): CompressionResult | null {
	if (!output.includes("running") && !output.includes("test result")) return null;

	const lines = output.split("\n");
	const kept: string[] = [];
	let passCount = 0;
	let failCount = 0;
	let ignoreCount = 0;

	for (const line of lines) {
		if (line.startsWith("test ") && line.includes(" ... ok")) {
			passCount++;
			continue;
		}
		if (line.startsWith("test ") && line.includes(" ... FAILED")) {
			kept.push(line);
			failCount++;
			continue;
		}
		if (line.startsWith("test ") && line.includes(" ... ignored")) {
			ignoreCount++;
			continue;
		}
		if (line.startsWith("test result:")) {
			kept.push(line);
			continue;
		}
		if (line.startsWith("---- ") || line.startsWith("panicked") || line.startsWith("thread ")) {
			kept.push(line);
			continue;
		}
		if (line.startsWith("error:") || line.startsWith("  --> ")) {
			kept.push(line);
		}
	}

	const parts: string[] = [`── cargo test ──`];
	if (passCount > 0) parts.push(`Passed: ${passCount}`);
	if (failCount > 0) parts.push(`Failed: ${failCount}`);
	if (ignoreCount > 0) parts.push(`Ignored: ${ignoreCount}`);
	if (kept.length > 0) parts.push("", "── Failures ──", ...kept);

	return makeResult(parts.join("\n"), output, "cargo-test");
}

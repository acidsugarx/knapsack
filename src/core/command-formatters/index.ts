/**
 * Command formatter registry — dispatches to per-command formatters
 * that understand output semantics (git, npm, pytest, cargo, etc.).
 *
 * ## Why
 *
 * Generic bash/grep/find strategies don't understand command output
 * structure. RTK has 100+ command-specific filters, sqz has 40+.
 * Knapsack had zero — this module closes that gap.
 *
 * ## How it works
 *
 * Before the generic compression pipeline runs, the registry checks
 * if a command-specific formatter matches. If it does, the formatter
 * produces a compact summary and the generic pipeline is skipped.
 * If no formatter matches (or the formatter returns null), the output
 * falls through to the generic strategies.
 *
 * @module command-formatters
 */

import { sha256 } from "../hash";
import { estimateTokens, savingsPercent } from "../tokens";
import type { CompressionResult } from "../types";
import { formatGitDiff, formatGitLog, formatGitStatus, matchGit } from "./git";
import { formatJest, formatVitest, matchJest, matchVitest } from "./javascript";
import { formatNpmInstall, formatNpmTest, matchNpm } from "./npm";
import { formatPytest, matchPytest } from "./python";
import { formatCargoBuild, formatCargoTest, matchCargo } from "./rust";
import { formatGoTest, matchGoTest } from "./test-runners";

/** Parameters passed to a command formatter. */
export interface FormatterParams {
	/** Raw command output */
	output: string;
	/** Full command string (e.g. "git status --short") */
	command: string;
	/** Exit code of the command (0 = success) */
	exitCode?: number;
}

/** Result of a command formatter — a CompressionResult or null to fall through. */
export type FormatterResult = CompressionResult | null;

interface CommandFormatter {
	name: string;
	match(command: string): boolean;
	format(params: FormatterParams): FormatterResult;
}

const formatters: CommandFormatter[] = [
	{
		name: "git-status",
		match: (cmd) => matchGit(cmd, "status"),
		format: (p) => formatGitStatus(p.output, p.command),
	},
	{
		name: "git-diff",
		match: (cmd) => matchGit(cmd, "diff"),
		format: (p) => formatGitDiff(p.output),
	},
	{
		name: "git-log",
		match: (cmd) => matchGit(cmd, "log"),
		format: (p) => formatGitLog(p.output),
	},
	{
		name: "npm-install",
		match: (cmd) => matchNpm(cmd, "install"),
		format: (p) => formatNpmInstall(p.output),
	},
	{
		name: "npm-test",
		match: (cmd) => matchNpm(cmd, "test"),
		format: (p) => formatNpmTest(p.output),
	},
	{
		name: "pytest",
		match: (cmd) => matchPytest(cmd),
		format: (p) => formatPytest(p.output, p.exitCode),
	},
	{
		name: "cargo-build",
		match: (cmd) => matchCargo(cmd, "build"),
		format: (p) => formatCargoBuild(p.output),
	},
	{
		name: "cargo-test",
		match: (cmd) => matchCargo(cmd, "test"),
		format: (p) => formatCargoTest(p.output),
	},
	{
		name: "jest",
		match: (cmd) => matchJest(cmd),
		format: (p) => formatJest(p.output),
	},
	{
		name: "vitest",
		match: (cmd) => matchVitest(cmd),
		format: (p) => formatVitest(p.output),
	},
	{
		name: "go-test",
		match: (cmd) => matchGoTest(cmd),
		format: (p) => formatGoTest(p.output),
	},
];

/**
 * Try to format a command output using a command-specific formatter.
 *
 * @param params - Command output + metadata
 * @returns CompressionResult if a formatter matched, or null to fall through
 */
export function formatCommandOutput(params: FormatterParams): FormatterResult {
	for (const f of formatters) {
		if (f.match(params.command)) {
			const result = f.format(params);
			if (result !== null) return result;
		}
	}
	return null;
}

/**
 * Wrap a formatted string as a CompressionResult with token stats.
 *
 * @param body - Formatted output body
 * @param originalText - Original raw output (for hash + token count)
 * @param strategyName - Formatter name (e.g. "git-status")
 * @returns CompressionResult with measured savings
 */
export function makeResult(
	body: string,
	originalText: string,
	strategyName: string,
): CompressionResult {
	const originalTokens = estimateTokens(originalText);
	const compressedTokens = estimateTokens(body);
	return {
		body,
		hash: sha256(originalText),
		originalTokens,
		compressedTokens,
		savingsPercent: savingsPercent(originalTokens, compressedTokens),
		strategy: strategyName,
	};
}

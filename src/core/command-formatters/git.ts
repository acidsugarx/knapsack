/**
 * Git command formatters — status, diff, log.
 *
 * @module git-formatters
 */

import type { CompressionResult } from "../types";
import { makeResult } from "./index";

/**
 * Check if a command is a git subcommand.
 * @param command - Full command string
 * @param subcommand - Subcommand to match (e.g. "status", "diff", "log")
 * @returns true if the command is `git <subcommand>`
 */
export function matchGit(command: string, subcommand: string): boolean {
	return new RegExp(`^git\\s+${subcommand}\\b`).test(command.trim());
}

/**
 * Format `git status` output into a compact summary.
 *
 * Converts 20+ lines of boilerplate into:
 * ```
 * ── git status (feat/cross-agent) ──
 * Staged: 2 (new: 1, modified: 1)
 *   new file:   src/core/index.ts
 *   modified:   src/core/pipeline.ts
 * Modified: 2
 *   src/adapters/opencode/plugin.ts
 *   test/core/pipeline.test.ts
 * Untracked: 2
 *   src/core/command-formatters/
 *   scripts/test.ts
 * ```
 */
export function formatGitStatus(output: string, _command: string): CompressionResult | null {
	if (!output.includes("On branch") && !output.includes("HEAD detached")) return null;

	const branchMatch = output.match(/On branch (\S+)/);
	const branch = branchMatch?.[1] ?? "detached";

	const staged: string[] = [];
	const modified: string[] = [];
	const untracked: string[] = [];
	let section = "";

	for (const line of output.split("\n")) {
		if (line.startsWith("Changes to be committed")) section = "staged";
		else if (line.startsWith("Changes not staged")) section = "modified";
		else if (line.startsWith("Untracked files")) section = "untracked";
		else if (line.startsWith("	")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("(")) continue;
			if (section === "staged") staged.push(trimmed);
			else if (section === "modified") modified.push(trimmed.replace(/^modified:\s*/, ""));
			else if (section === "untracked") untracked.push(trimmed);
		}
	}

	if (staged.length === 0 && modified.length === 0 && untracked.length === 0) {
		if (output.includes("nothing to commit")) {
			return makeResult(
				`── git status (${branch}) ──\nClean — nothing to commit`,
				output,
				"git-status",
			);
		}
		return null;
	}

	const lines: string[] = [`── git status (${branch}) ──`];

	if (staged.length > 0) {
		const newCount = staged.filter((s) => s.startsWith("new file")).length;
		const modCount = staged.filter((s) => s.startsWith("modified")).length;
		const parts: string[] = [];
		if (newCount > 0) parts.push(`new: ${newCount}`);
		if (modCount > 0) parts.push(`modified: ${modCount}`);
		lines.push(`Staged: ${staged.length} (${parts.join(", ")})`);
		for (const s of staged) lines.push(`  ${s}`);
	}

	if (modified.length > 0) {
		lines.push(`Modified: ${modified.length}`);
		for (const m of modified) lines.push(`  ${m}`);
	}

	if (untracked.length > 0) {
		lines.push(`Untracked: ${untracked.length}`);
		for (const u of untracked) lines.push(`  ${u}`);
	}

	return makeResult(lines.join("\n"), output, "git-status");
}

/**
 * Format `git diff` output — keep only changed lines + headers, drop context.
 */
export function formatGitDiff(output: string): CompressionResult | null {
	if (!output.includes("diff --git") && !output.includes("---") && !output.includes("@@"))
		return null;

	const lines = output.split("\n");
	const kept: string[] = [];
	let contextRun = 0;

	for (const line of lines) {
		if (
			line.startsWith("diff --git") ||
			line.startsWith("---") ||
			line.startsWith("+++") ||
			line.startsWith("@@") ||
			line.startsWith("+") ||
			line.startsWith("-")
		) {
			if (contextRun > 0) {
				kept.push(`  [${contextRun} context lines]`);
				contextRun = 0;
			}
			kept.push(line);
		} else if (line.startsWith(" ")) {
			contextRun++;
		} else {
			kept.push(line);
		}
	}
	if (contextRun > 0) kept.push(`  [${contextRun} context lines]`);

	return makeResult(kept.join("\n"), output, "git-diff");
}

/**
 * Format `git log` output — hash + author + subject only, no body.
 */
export function formatGitLog(output: string): CompressionResult | null {
	if (!output.match(/^commit [a-f0-9]{7,40}/m)) return null;

	const commits = output.split(/(?=^commit [a-f0-9]{7,40})/m);
	const lines: string[] = [];

	for (const commit of commits) {
		const hashMatch = commit.match(/^commit ([a-f0-9]{7,40})/);
		const authorMatch = commit.match(/^Author:\s+(.+)$/m);
		const _dateMatch = commit.match(/^Date:\s+(.+)$/m);
		const subjectMatch = commit.match(/^\n\s{4}(.+)$/m);

		if (!hashMatch) continue;
		const hash = hashMatch[1]?.slice(0, 7) ?? "";
		const author = authorMatch?.[1]?.split("<")[0]?.trim() ?? "";
		const subject = subjectMatch?.[1]?.trim() ?? "(no subject)";

		lines.push(`${hash} ${author} — ${subject}`);
	}

	if (lines.length === 0) return null;
	return makeResult(lines.join("\n"), output, "git-log");
}

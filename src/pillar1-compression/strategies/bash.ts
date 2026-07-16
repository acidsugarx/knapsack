import { sha256 } from "../../core/hash";
import { estimateTokens, savingsPercent } from "../../core/tokens";
import type { CompressedSection, CompressionResult } from "../../core/types";

// ── ANSI escape sequence stripper ──────────────────────

function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

// ── Line deduplication ─────────────────────────────────

function deduplicateLines(lines: string[]): { line: string; count: number }[] {
	const map = new Map<string, number>();
	for (const line of lines) {
		map.set(line, (map.get(line) ?? 0) + 1);
	}
	return Array.from(map.entries())
		.map(([line, count]) => ({ line, count }))
		.sort((a, b) => b.count - a.count);
}

// ── Severity detection ─────────────────────────────────

function classifyLine(line: string): "error" | "warning" | "info" | "other" {
	const lower = line.toLowerCase();
	if (/error|fatal|fail|panic|abort/i.test(lower)) return "error";
	if (/warn|deprecated|notice/i.test(lower)) return "warning";
	if (/info|debug|trace|verbose/i.test(lower)) return "info";
	return "other";
}

// ── Progress summarization ─────────────────────────────

function summarizeProgress(lines: string[]): string | null {
	if (lines.length === 0) return null;

	// Count compilation/build lines
	const compiled = lines.filter((l) => /compil/i.test(l));
	const processed = lines.filter((l) => /process/i.test(l));
	const downloaded = lines.filter((l) => /download/i.test(l));

	const parts: string[] = [];
	if (compiled.length) parts.push(`compiled ${compiled.length}`);
	if (processed.length) parts.push(`processed ${processed.length}`);
	if (downloaded.length) parts.push(`downloaded ${downloaded.length}`);

	if (parts.length === 0) return `${lines.length} info lines`;
	return parts.join(", ");
}

// ── Main compression ───────────────────────────────────

export interface BashCompressOptions {
	/** Max lines in errors section */
	maxErrors?: number;
	/** Max lines in warnings section */
	maxWarnings?: number;
	/** Max tail lines */
	maxTail?: number;
}

export function compressBash(
	stdout: string,
	stderr?: string,
	exitCode?: number,
	options: BashCompressOptions = {},
): CompressionResult {
	const { maxErrors = 50, maxWarnings = 20, maxTail = 15 } = options;

	const combined = stderr ? `${stderr}\n${stdout}` : stdout;
	const clean = stripAnsi(combined);
	const lines = clean.split("\n");

	const errors: string[] = [];
	const warnings: string[] = [];
	const infos: string[] = [];
	const others: string[] = [];

	for (const line of lines) {
		switch (classifyLine(line)) {
			case "error":
				errors.push(line);
				break;
			case "warning":
				warnings.push(line);
				break;
			case "info":
				infos.push(line);
				break;
			default:
				others.push(line);
				break;
		}
	}

	const sections: CompressedSection[] = [];

	// Errors — always show, capped
	if (errors.length > 0) {
		const shown = errors.slice(0, maxErrors);
		const suffix = errors.length > maxErrors ? `\n(+${errors.length - maxErrors} more errors)` : "";
		sections.push({
			title: "ERRORS",
			content:
				deduplicateLines(shown)
					.map((d) => (d.count > 1 ? `${d.line} (×${d.count})` : d.line))
					.join("\n") + suffix,
		});
	}

	// Warnings — grouped
	if (warnings.length > 0) {
		const deduped = deduplicateLines(warnings);
		const shown = deduped.slice(0, maxWarnings);
		const suffix =
			deduped.length > maxWarnings ? `\n(+${deduped.length - maxWarnings} more warning types)` : "";

		sections.push({
			title: "WARNINGS",
			content:
				shown.map((d) => (d.count > 1 ? `${d.line} (×${d.count})` : d.line)).join("\n") + suffix,
		});
	}

	// Progress summary
	const progressSummary = summarizeProgress(infos);
	if (progressSummary) {
		sections.push({
			title: "PROGRESS",
			content: progressSummary,
		});
	}

	// Tail — last N non-empty lines
	const tail = others.filter((l) => l.trim()).slice(-maxTail);
	if (tail.length > 0) {
		sections.push({
			title: "TAIL",
			content: tail.join("\n"),
		});
	}

	// Build output
	const header = `exit=${exitCode ?? "?"} · errors=${errors.length} · warnings=${warnings.length} · lines=${lines.length}`;
	const body = sections
		.filter((s) => s.content)
		.map((s) => `── ${s.title} ──\n${s.content}`)
		.join("\n\n");

	const output = `📦 ${header}\n\n${body}`;
	const originalTokens = estimateTokens(combined);
	const compressedTokens = estimateTokens(output);

	return {
		body: output,
		hash: sha256(combined),
		originalTokens,
		compressedTokens,
		savingsPercent: savingsPercent(originalTokens, compressedTokens),
		strategy: "bash",
	};
}

/**
 * Bash output compression strategy — collapses logs and captures errors.
 *
 * Pipeline: ANSI strip → log template mining (Drain-style) → severity
 * classification (errors/warnings/info/other) → deduplication → tail.
 *
 * @module bash-compression
 */
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

// ── Log template mining (Drain-inspired) ────────────────
//
// Replaces digits / hex / uuids / emails with placeholders, then collapses
// consecutive runs of identical templates into one line + count. Inspired
// by Headroom's log_compressor and Drain. Lossless: the model still sees the
// shape and frequency of repeated log spam without 800 near-identical lines.

const TEMPLATE_NORM_RE = [
	// uuids
	[/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
	// long hex (commit hashes, hashes)
	[/\b[0-9a-f]{16,}\b/gi, "<hex>"],
	// emails
	[/\S+@\S+\.\S+/g, "<email>"],
	// ip addresses
	[/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<ip>"],
	// numbers (last so uuid/hex/ip already replaced)
	[/\b\d+\b/g, "N"],
] as const;

function normalizeTemplate(line: string): string {
	let out = line;
	for (const [re, replacement] of TEMPLATE_NORM_RE) {
		out = out.replace(re, replacement);
	}
	return out;
}

/** Minimum consecutive identical-template lines to count as a "template run". */
const TEMPLATE_RUN_MIN = 3;

interface TemplateRun {
	/** First line verbatim — model sees one concrete example. */
	sample: string;
	count: number;
}

/**
 * Walk lines, group consecutive same-template runs, return templates and
 * the remaining (non-template) lines in original order.
 */
function extractTemplates(lines: string[]): { templates: TemplateRun[]; rest: string[] } {
	const templates: TemplateRun[] = [];
	const rest: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const norm = normalizeTemplate(lines[i] ?? "");
		let j = i + 1;
		while (j < lines.length && normalizeTemplate(lines[j] ?? "") === norm) j++;
		const count = j - i;
		if (count >= TEMPLATE_RUN_MIN && norm.trim()) {
			templates.push({ sample: lines[i] ?? "", count });
		} else {
			for (let k = i; k < j; k++) rest.push(lines[k] ?? "");
		}
		i = j;
	}
	return { templates, rest };
}

// ── Severity detection ─────────────────────────────────

function classifyLine(line: string): "error" | "warning" | "info" | "other" {
	const lower = line.toLowerCase();
	// Match actual error lines (ERROR/WARN prefix or stack traces), skip lines that just mention "error" in passing
	if (/^\[error\]|^error[:\s]|^fatal[:\s]|^panic[:\s]|error\s+at/i.test(line)) return "error";
	// Match [WARN] prefix, standard warning format, or deprecated/notice keywords
	if (/\[warn\]|^warn(?:ing)?[:\s]/i.test(line)) return "warning";
	if (/\bdeprecated\b|\bnotice\b/i.test(line) && !/error|fail/i.test(line)) return "warning";
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
	/**
	 * Combined stdout text. If `stderr` is also supplied it is prepended
	 * so that error-traces and the actual program output are classified
	 * together.
	 */
	stdout: string,
	/** Optional stderr; prepended onto `stdout` before classification. */
	stderr?: string,
	/** Process exit code surfaced in the compressed header. */
	exitCode?: number,
	/** Per-section size caps. */
	options: BashCompressOptions = {},
): CompressionResult {
	const { maxErrors = 50, maxWarnings = 20, maxTail = 15 } = options;

	const combined = stderr ? `${stderr}\n${stdout}` : stdout;
	const clean = stripAnsi(combined);
	const allLines = clean.split("\n");

	// Pull template runs out first so repetitive INFO/progress spam doesn't
	// flood the INFO section or dilute the tail.
	const { templates, rest: lines } = extractTemplates(allLines);

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

	// Templates — repetitive log patterns collapsed to one line + count
	if (templates.length > 0) {
		const shown = templates.slice(0, 20);
		const suffix = templates.length > 20 ? `\n(+${templates.length - 20} more template types)` : "";
		sections.push({
			title: "TEMPLATES",
			content: shown.map((t) => `[${t.count}x] ${t.sample}`).join("\n") + suffix,
		});
	}

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

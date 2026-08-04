/**
 * Bash output compression — Headroom LogCompressor-style.
 *
 * Pipeline:
 * ANSI strip → stack trace protection → log template mining (Drain-style)
 * → severity classification → error context extraction → deduplication
 * → head + tail preservation.
 *
 * ## What's preserved (always verbatim)
 *
 * - Error lines + surrounding context (3 lines before/after)
 * - Stack traces (file:line patterns, Traceback, panic traces)
 * - First 5 lines (head) and last 15 lines (tail)
 * - Warning lines deduplicated
 *
 * ## What's compressed
 *
 * - Repetitive log lines → template + count
 * - Progress/INFO spam → summary line
 * - Timestamps → <ts> placeholder for grouping
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

// ── Stack trace detection ──────────────────────────────

/** Patterns that indicate a stack trace line — these are NEVER templated. */
const STACK_TRACE_RE = [
	/^\s+at\s+\S+.*\(/, // JS/TS: at function (file:line:col)
	/^\s+at\s+\S+:\d+:\d+/, // JS/TS: at file:line:col
	/^Traceback\s*\(/, // Python
	/^\s+File\s+"[^"]+",\s+line\s+\d+/, // Python
	/^panic:\s/, // Go
	/^goroutine\s+\d+/, // Go
	/^\s+\S+\.go:\d+/, // Go stack frame
	/^\[ERROR\]/, // Explicit error marker
	/^FATAL:/,
	/^Error:\s/m,
	/^Caused by:/,
];

function isStackTrace(line: string): boolean {
	return STACK_TRACE_RE.some((re) => re.test(line));
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

// ── Log template mining (Drain-style + timestamp-aware) ─

const TEMPLATE_NORM_RE = [
	[/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
	[/\b[0-9a-f]{40,}\b/gi, "<sha>"],
	[/\b[0-9a-f]{16,39}\b/gi, "<hex>"],
	[/\S+@\S+\.\S+/g, "<email>"],
	[/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<ip>"],
	// Timestamps — ISO 8601, syslog, common formats
	[/\b\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<ts>"],
	[/\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\b/g, "<ts>"],
	[
		/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\b/gi,
		"<ts>",
	],
	// Hex addresses (0x...) and memory addresses
	[/\b0x[0-9a-f]{8,}\b/gi, "<addr>"],
	// Numbers (last)
	[/\b\d+\b/g, "N"],
] as const;

function normalizeTemplate(line: string): string {
	let out = line;
	for (const [re, replacement] of TEMPLATE_NORM_RE) {
		out = out.replace(re, replacement);
	}
	return out;
}

const TEMPLATE_RUN_MIN = 3;

interface TemplateRun {
	sample: string;
	count: number;
}

/**
 * Extract template runs from non-stack-trace, non-error lines.
 * Stack traces and error lines are always kept verbatim.
 */
function extractTemplates(lines: string[]): { templates: TemplateRun[]; rest: string[] } {
	const templates: TemplateRun[] = [];
	const rest: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		// Never template stack traces or explicit errors
		if (isStackTrace(line) || /^(?:error|fatal|panic)[:\s]/i.test(line)) {
			rest.push(line);
			i++;
			continue;
		}
		const norm = normalizeTemplate(line);
		let j = i + 1;
		while (j < lines.length) {
			const next = lines[j] ?? "";
			if (isStackTrace(next) || /^(?:error|fatal|panic)[:\s]/i.test(next)) break;
			if (normalizeTemplate(next) !== norm) break;
			j++;
		}
		const count = j - i;
		if (count >= TEMPLATE_RUN_MIN && norm.trim()) {
			templates.push({ sample: line, count });
		} else {
			for (let k = i; k < j; k++) rest.push(lines[k] ?? "");
		}
		i = j;
	}
	return { templates, rest };
}

// ── Error context extraction ───────────────────────────

/** Lines of context to keep before/after each error line. */
const ERROR_CONTEXT = 3;

/**
 * Extract error lines with surrounding context from the original line array.
 *
 * For each error, keeps {@link ERROR_CONTEXT} lines before and after,
 * separated by `---` between error blocks. Stack traces are automatically
 * included since they immediately follow errors.
 */
function extractErrorBlocks(lines: string[], errorIndices: number[]): string[] {
	const blocks: string[] = [];
	const used = new Set<number>();

	for (const ei of errorIndices.slice(0, 20)) {
		// Avoid duplicate blocks (overlapping errors)
		if (used.has(ei)) continue;

		const start = Math.max(0, ei - ERROR_CONTEXT);
		const end = Math.min(lines.length, ei + ERROR_CONTEXT + 1);

		const block = lines.slice(start, end);
		for (let k = start; k < end; k++) used.add(k);

		if (blocks.length > 0) blocks.push("---");
		blocks.push(...block);
	}

	return blocks;
}

// ── Severity detection ─────────────────────────────────

function classifyLine(line: string): "error" | "warning" | "info" | "other" {
	const lower = line.toLowerCase();

	// Stack traces are errors
	if (isStackTrace(line)) return "error";

	// Explicit error markers
	if (
		/^\[error\]|^error[:\s]|^fatal[:\s]|^panic[:\s]|^crit(?:ical)?[:\s]/i.test(line) ||
		/\berror\s+at\b/i.test(line)
	)
		return "error";

	// Warnings
	if (/^\[warn\]|^warn(?:ing)?[:\s]/i.test(line)) return "warning";
	if (/\bdeprecated\b|\bnotice\b/i.test(line) && !/error|fail/i.test(line)) return "warning";

	// Info
	if (/info|debug|trace|verbose/i.test(lower)) return "info";

	return "other";
}

// ── Progress summarization ─────────────────────────────

function summarizeProgress(lines: string[]): string | null {
	if (lines.length === 0) return null;

	const compiled = lines.filter((l) => /compil/i.test(l));
	const processed = lines.filter((l) => /process/i.test(l));
	const downloaded = lines.filter((l) => /download/i.test(l));
	const installed = lines.filter((l) => /install/i.test(l));
	const built = lines.filter((l) => /built|build/i.test(l));

	const parts: string[] = [];
	if (compiled.length) parts.push(`compiled ${compiled.length}`);
	if (built.length) parts.push(`built ${built.length}`);
	if (processed.length) parts.push(`processed ${processed.length}`);
	if (downloaded.length) parts.push(`downloaded ${downloaded.length}`);
	if (installed.length) parts.push(`installed ${installed.length}`);

	if (parts.length === 0) return `${lines.length} info lines`;
	return parts.join(", ");
}

// ── Main compression ───────────────────────────────────

/** Per-section size caps for bash output compression. */
export interface BashCompressOptions {
	/** Max error lines to show */
	maxErrors?: number;
	/** Max warning lines to show */
	maxWarnings?: number;
	/** Max tail lines */
	maxTail?: number;
	/** Max head lines */
	maxHead?: number;
}

/**
 * Compress bash output — Headroom LogCompressor-style.
 *
 * Preserves: errors + context, stack traces, first/last N lines.
 * Compresses: repetitive logs → templates, progress spam → summary.
 *
 * @param stdout - Combined stdout text. stderr is prepended if supplied.
 * @param stderr - Optional stderr text.
 * @param exitCode - Process exit code.
 * @param options - Per-section size caps.
 */
export function compressBash(
	stdout: string,
	stderr?: string,
	exitCode?: number,
	options: BashCompressOptions = {},
): CompressionResult {
	const { maxErrors = 30, maxWarnings = 15, maxTail = 15, maxHead = 5 } = options;

	const combined = stderr ? `${stderr}\n${stdout}` : stdout;
	const clean = stripAnsi(combined);
	const allLines = clean.split("\n");

	// Step 1: Pull template runs out of non-critical lines
	const { templates, rest: lines } = extractTemplates(allLines);

	// Step 2: Classify remaining lines
	const errors: string[] = [];
	const errorIndices: number[] = [];
	const warnings: string[] = [];
	const infos: string[] = [];
	const others: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		switch (classifyLine(line)) {
			case "error":
				errors.push(line);
				errorIndices.push(i);
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

	// Head — first N lines (top attention)
	const head = allLines.slice(0, maxHead).filter((l) => l.trim());
	if (head.length > 0) {
		sections.push({ title: "HEAD", content: head.join("\n") });
	}

	// Errors — with context blocks (critical, top attention)
	if (errors.length > 0) {
		const errorBlocks = extractErrorBlocks(lines, errorIndices);
		// Cap total error lines
		const shown = errorBlocks.slice(0, maxErrors * 4); // each error block is ~7 lines
		const suffix = errorBlocks.length > shown.length ? `\n(+ more error context)` : "";
		sections.push({
			title: `ERRORS (${errors.length})`,
			content: shown.join("\n") + suffix,
		});
	}

	// Warnings — deduplicated
	if (warnings.length > 0) {
		const deduped = deduplicateLines(warnings);
		const shown = deduped.slice(0, maxWarnings);
		const suffix =
			deduped.length > maxWarnings ? `\n(+${deduped.length - maxWarnings} more warning types)` : "";
		sections.push({
			title: `WARNINGS (${warnings.length})`,
			content:
				shown.map((d) => (d.count > 1 ? `${d.line} (×${d.count})` : d.line)).join("\n") + suffix,
		});
	}

	// Templates — repetitive log patterns
	if (templates.length > 0) {
		const shown = templates.slice(0, 20);
		const suffix = templates.length > 20 ? `\n(+${templates.length - 20} more template types)` : "";
		sections.push({
			title: "TEMPLATES",
			content: shown.map((t) => `[${t.count}x] ${t.sample}`).join("\n") + suffix,
		});
	}

	// Progress summary
	const progressSummary = summarizeProgress(infos);
	if (progressSummary) {
		sections.push({ title: "PROGRESS", content: progressSummary });
	}

	// Tail — last N lines (bottom attention)
	const tail = others.filter((l) => l.trim()).slice(-maxTail);
	if (tail.length > 0) {
		sections.push({ title: "TAIL", content: tail.join("\n") });
	}

	// Build output
	const header = `exit=${exitCode ?? "?"} · errors=${errors.length} · warnings=${warnings.length} · lines=${allLines.length}`;
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

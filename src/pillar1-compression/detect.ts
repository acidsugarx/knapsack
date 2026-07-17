/**
 * Content type auto-detection — routes tool outputs to compression strategies
 * by analyzing the output format, not by hardcoding tool name mappings.
 *
 * ## Detection order (first match wins)
 *
 * 1. JSON — starts with `{` and parses, or starts with `[` and looks like JSON array
 * 2. Diff — has `diff --git` (or `+++`/`---`) plus `@@` hunk headers
 * 3. Grep — most lines match `file:line:content` with realistic paths
 * 4. Bash — has log-level markers ([ERROR], [WARN]), exit codes, or stack traces
 * 5. Find — most lines look like file paths without grep-style line numbers
 * 6. null — unrecognized, pass through
 *
 * ## Fallback
 *
 * If auto-detection returns null, no strategy applies and output passes through uncompressed.
 *
 * @module content-detection
 */

const SAMPLE_SIZE = 5000;

/**
 * Auto-detect the content type of a tool output.
 *
 * @param output - Raw tool output text
 * @returns Strategy name ('bash', 'grep', 'find', 'json') or null
 */
export function detectContentType(output: string): string | null {
	const sample = output.slice(0, SAMPLE_SIZE).trim();
	if (!sample) return null;

	const lines = sample.split("\n").filter((l) => l.trim());

	// ── JSON ──────────────────────────────────────────────
	// Only trigger on { (object) or clean [ (array — exclude [INFO] etc.)
	if (/^\s*\{/.test(sample)) {
		try {
			JSON.parse(sample);
			return "json";
		} catch {
			// Truncated JSON — still likely JSON
			return "json";
		}
	}
	if (/^\s*\[/.test(sample) && !isLogLine(lines[0] ?? "")) {
		try {
			JSON.parse(sample);
			return "json";
		} catch {
			// Clean [ without log markers — likely JSON array
			if (!lines.some((l) => isLogLine(l))) return "json";
		}
	}

	// ── Diff: git diff header + hunk headers ─────────────
	if (isDiffOutput(lines)) {
		return "diff";
	}

	// ── Grep: file:line:content on 60%+ of lines ──────────
	const grepLines = lines.filter((l) => isGrepLine(l));
	if (grepLines.length > 0 && grepLines.length >= lines.length * 0.6) {
		return "grep";
	}

	// ── Bash: log markers, exit codes, stack traces ───────
	const bashMarkers = lines.filter((l) => isBashLine(l));
	if (bashMarkers.length >= 2 && bashMarkers.length >= lines.length * 0.05) {
		return "bash";
	}

	// ── Find: file paths without grep line numbers ─────────
	const pathLines = lines.filter((l) => isFindLine(l));
	if (pathLines.length > 0 && pathLines.length >= lines.length * 0.8) {
		return "find";
	}

	return null;
}

/**
 * Check if a line looks like a grep result: path:line:content
 */
function isGrepLine(line: string): boolean {
	const match = line.match(/^(.+?):(\d+):(.*)$/);
	if (!match) return false;
	// The file part should look like a real path (has / or .extension)
	const file = match[1] ?? "";
	return file.includes("/") || /\.[a-z]{1,6}$/i.test(file);
}

/**
 * Check if a line has bash/log markers.
 */
function isBashLine(line: string): boolean {
	return (
		/\[(ERROR|WARN|INFO|DEBUG|FATAL)\]/i.test(line) ||
		/\bexit\s*(code)?\s*[:=]?\s*\d/i.test(line) ||
		/\bat\s+\S+\s+\(/.test(line) ||
		/^\s*(error|warn|info|debug)[:\s]/i.test(line) ||
		/(?:FAILED|SUCCESS|DONE)(?:\s|$)/i.test(line)
	);
}

/**
 * Check if a line looks like a file path (not grep, not log).
 */
function isFindLine(line: string): boolean {
	if (!line.trim()) return false;
	if (isGrepLine(line)) return false;
	if (isLogLine(line)) return false;
	return line.includes("/") || /\.[a-z]{1,6}$/i.test(line);
}

/**
 * Check if a line looks like a log entry (to avoid JSON false positives).
 */
function isLogLine(line: string): boolean {
	return /^\[(ERROR|WARN|INFO|DEBUG|FATAL|TRACE)\]/i.test(line);
}

/**
 * Check if the output is a unified git diff.
 *
 * True when both a file header (`diff --git`, `+++`, `---`, etc.) and at
 * least one `@@` hunk header appear in the sampled lines.
 */
function isDiffOutput(lines: string[]): boolean {
	let hasFile = false;
	let hasHunk = false;
	for (const line of lines) {
		if (!hasFile && /^(?:diff --git |index |--- |\+\+\+ )/.test(line)) hasFile = true;
		else if (!hasHunk && /^@@/.test(line)) hasHunk = true;
		if (hasFile && hasHunk) return true;
	}
	return false;
}

/**
 * Git diff compression — trims bloated context lines.
 *
 * Most of a `git diff` is unchanged context the model doesn't need. For each
 * hunk we keep the `+`/`-` change lines plus a small context window around
 * them, and replace dropped runs with a single `... (N context lines trimmed)`
 * marker so the model can see how much was elided.
 *
 * ## Detection
 *
 * Treats input as a diff if it contains both a `diff --git` (or `+++`/`---`)
 * header and at least one `@@` hunk header. Falls through to the next
 * strategy otherwise.
 *
 * ## Output
 *
 * File headers and hunk headers (`@@`) are preserved verbatim. Hunk bodies
 * keep each change line and up to {@link CONTEXT_LINES} of surrounding
 * context. Long dropped runs collapse to one marker line.
 *
 * @module diff-compression
 */

import { sha256 } from "../../core/hash";
import { estimateTokens, savingsPercent } from "../../core/tokens";
import type { CompressionResult } from "../../core/types";

/** Lines of context to keep on each side of a `+`/`-` change. */
const CONTEXT_LINES = 2;
/** Below this many input lines, don't bother — compression isn't worth the noise. */
const MIN_LINES = 40;
/** Max hunks kept per file when scoring fires. Hunks above this count get ranked. */
const MAX_HUNKS_PER_FILE = 8;

const FILE_HEADER_RE =
	/^(?:diff --git |index |--- |\+\+\+ |new file |deleted file |old mode |new mode |similarity index |rename from |rename to |copy from |copy to |Binary files )/;
const HUNK_HEADER_RE = /^@@/;
const FILE_OR_HUNK_RE = /^(?:diff --git |@@)/;

/**
 * Change-line content that signals a structurally important edit — function,
 * class, type, interface, struct, trait, export, import. Matches many
 * languages so we don't need per-lang grammars here.
 */
const PRIORITY_DECL_RE =
	/^\s*(?:export\s+)?(?:default\s+)?(?:public|private|protected|static|async|abstract|final|declare\s+)?\s*(?:function|class|interface|type|enum|const|let|var|def|fn|struct|enum|impl|trait|namespace|module|import|from)\s+/;

/**
 * Returns true if the output looks like a unified git diff.
 *
 * Heuristic: needs at least one file header and one `@@` hunk header.
 */
export function isDiff(output: string): boolean {
	let hasFileHeader = false;
	let hasHunkHeader = false;
	for (const line of output.split("\n")) {
		if (!hasFileHeader && FILE_HEADER_RE.test(line)) hasFileHeader = true;
		else if (!hasHunkHeader && HUNK_HEADER_RE.test(line)) hasHunkHeader = true;
		if (hasFileHeader && hasHunkHeader) return true;
	}
	return false;
}

/**
 * Compress a git diff by trimming context lines.
 *
 * @param source - Raw `git diff` output
 * @returns Compression result, or null if `source` is not a diff or is too short
 */
export function compressDiff(source: string): CompressionResult | null {
	if (!isDiff(source)) return null;
	const lines = source.split("\n");
	if (lines.length < MIN_LINES) return null;

	const files = parseDiffFiles(lines);

	const out: string[] = [];
	let totalContextTrimmed = 0;
	let hunksKept = 0;
	let hunksDropped = 0;

	for (const file of files) {
		out.push(...file.headers);

		// Score every hunk so we can rank when the cap fires.
		for (const h of file.hunks) h.score = scoreHunk(h.body);

		let keepers = file.hunks;
		if (file.hunks.length > MAX_HUNKS_PER_FILE) {
			// Keep the highest-scoring MAX_HUNKS_PER_FILE hunks, preserve their
			// original document order so the diff still reads top-to-bottom.
			const ranked = [...file.hunks].sort((a, b) => b.score - a.score);
			const keepIds = new Set(ranked.slice(0, MAX_HUNKS_PER_FILE));
			keepers = file.hunks.filter((h) => keepIds.has(h));
			hunksDropped += file.hunks.length - keepers.length;
		}

		for (const h of keepers) {
			out.push(h.header);
			const trimmed = trimHunk(h.body);
			out.push(...trimmed.lines);
			totalContextTrimmed += trimmed.contextTrimmed;
		}
		hunksKept += keepers.length;
	}

	const dropLine = hunksDropped > 0 ? ` · ${hunksDropped} low-relevance hunks dropped` : "";
	const header = `📦 diff trimmed: ${hunksKept} hunks kept · ${totalContextTrimmed} context lines dropped${dropLine}\n\n`;
	const body = header + out.join("\n");
	const originalTokens = estimateTokens(source);
	const compressedTokens = estimateTokens(body);

	// Only claim success if we actually shrank the diff meaningfully.
	if (compressedTokens >= originalTokens * 0.9) return null;

	return {
		body,
		hash: sha256(source),
		originalTokens,
		compressedTokens,
		savingsPercent: savingsPercent(originalTokens, compressedTokens),
		strategy: "diff",
	};
}

interface DiffHunk {
	/** `@@ -a,b +c,d @@` header line. */
	header: string;
	/** Body lines after the header (until the next file/hunk header). */
	body: string[];
	/** Relevance score in [0, 1] — higher = more worth keeping. */
	score: number;
}

interface DiffFile {
	/** Pre-hunk header lines: `diff --git`, `index`, `+++`, `---`, … */
	headers: string[];
	hunks: DiffHunk[];
}

/** Parse a unified diff into per-file buckets with their hunks. */
function parseDiffFiles(lines: string[]): DiffFile[] {
	const files: DiffFile[] = [];
	let current: DiffFile | null = null;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (line.startsWith("diff --git ")) {
			current = { headers: [], hunks: [] };
			files.push(current);
		}
		if (HUNK_HEADER_RE.test(line)) {
			if (!current) {
				// Hunk outside any file — synthesise a container so we still emit it.
				current = { headers: [], hunks: [] };
				files.push(current);
			}
			const header = line;
			const body: string[] = [];
			i++;
			while (i < lines.length && !FILE_OR_HUNK_RE.test(lines[i] ?? "")) {
				body.push(lines[i] ?? "");
				i++;
			}
			current.hunks.push({ header, body, score: 0 });
			continue;
		}
		if (current) current.headers.push(line);
		i++;
	}
	return files;
}

/**
 * Score a hunk by change density plus a boost for priority declaration lines
 * (functions, classes, types, exports, imports). Hunks that only shuffle
 * whitespace or comments score near zero and are dropped first when the
 * per-file cap fires.
 */
function scoreHunk(body: string[]): number {
	let changeCount = 0;
	let priorityHits = 0;
	for (const line of body) {
		const first = line[0];
		if (first !== "+" && first !== "-") continue;
		changeCount++;
		const content = line.slice(1);
		if (PRIORITY_DECL_RE.test(content)) priorityHits++;
	}
	const density = Math.min(0.3, changeCount * 0.03);
	const priorityBoost = priorityHits > 0 ? Math.min(0.4, priorityHits * 0.15) : 0;
	return Math.min(1.0, density + priorityBoost);
}

/** Keep change lines and a context window, collapse the rest to one marker. */
function trimHunk(hunkLines: string[]): { lines: string[]; contextTrimmed: number } {
	// Find indices of `+`/`-` change lines (first char only — diff prefix).
	const changeIdx: number[] = [];
	for (let j = 0; j < hunkLines.length; j++) {
		const first = hunkLines[j][0];
		if (first === "+" || first === "-") changeIdx.push(j);
	}
	if (changeIdx.length === 0) {
		// Hunk without changes (rare) — emit verbatim.
		return { lines: hunkLines, contextTrimmed: 0 };
	}

	const keep = new Set<number>();
	for (const ci of changeIdx) {
		const lo = Math.max(0, ci - CONTEXT_LINES);
		const hi = Math.min(hunkLines.length - 1, ci + CONTEXT_LINES);
		for (let k = lo; k <= hi; k++) keep.add(k);
	}

	const out: string[] = [];
	let contextTrimmed = 0;
	let prevKept = -2;
	for (let j = 0; j < hunkLines.length; j++) {
		if (keep.has(j)) {
			const droppedBefore = prevKept === -2 ? j : j - prevKept - 1;
			if (droppedBefore > 0) {
				out.push(`  ... (${droppedBefore} context lines trimmed)`);
			}
			out.push(hunkLines[j]);
			prevKept = j;
		} else {
			contextTrimmed++;
		}
	}
	return { lines: out, contextTrimmed };
}

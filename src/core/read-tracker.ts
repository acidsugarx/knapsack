/**
 * Read tracker — detects re-reads of the same file and produces
 * compact deltas instead of full content.
 *
 * ## How it works
 *
 * When an agent reads a file (toolName includes "read" and path is set),
 * the pipeline computes the content hash and checks the tracker:
 *
 * - **New file**: record path → {hash, lineCount}. Normal compression.
 * - **Same path, same hash**: replace output with a 3-line marker.
 *   `[re-read: src/index.ts — unchanged, 342 lines — hash a1b2c3]`
 * - **Same path, different hash**: show unified diff against previous version.
 *   `[re-read: src/index.ts — changed, +3 -1 lines — diff below]`
 *
 * The tracker is in-memory per session (resets on restart). CCR still
 * stores the full original for retrieval.
 *
 * @module read-tracker
 */

import { sha256 } from "./hash";

/** Tracked file read. */
interface TrackedRead {
	/** Content hash of the file when last read */
	hash: string;
	/** Line count when last read */
	lineCount: number;
	/** Full content when last read (for diffing) */
	content: string;
}

/**
 * Result of checking a file read against the tracker.
 * - `"new"` — first read of this file, no delta available
 * - `"unchanged"` — same content as last read, use marker
 * - `"changed"` — content changed, use diff
 */
export type ReadDeltaResult =
	| { type: "new" }
	| { type: "unchanged"; marker: string }
	| { type: "changed"; marker: string; diff: string };

/** In-memory tracker mapping file path → last read info. */
export class ReadTracker {
	private readonly tracked = new Map<string, TrackedRead>();

	/**
	 * Check a file read against the tracker and produce a delta if possible.
	 *
	 * @param path - File path being read
	 * @param content - Full file content
	 * @returns Delta result indicating whether this is new, unchanged, or changed
	 */
	check(path: string, content: string): ReadDeltaResult {
		const hash = sha256(content);
		const lineCount = content.split("\n").length;
		const previous = this.tracked.get(path);

		if (!previous) {
			this.tracked.set(path, { hash, lineCount, content });
			return { type: "new" };
		}

		if (previous.hash === hash) {
			return {
				type: "unchanged",
				marker: `[re-read: ${path} — unchanged, ${lineCount} lines — hash ${hash}]`,
			};
		}

		const diff = computeUnifiedDiff(previous.content, content, path);
		const added = diff.split("\n").filter((l) => l.startsWith("+")).length - 1;
		const removed = diff.split("\n").filter((l) => l.startsWith("-")).length - 1;
		const marker = `[re-read: ${path} — changed, +${added} -${removed} lines — diff below]`;

		this.tracked.set(path, { hash, lineCount, content });
		return { type: "changed", marker, diff };
	}

	/** Clear all tracked reads (e.g. on session restart). */
	clear(): void {
		this.tracked.clear();
	}

	/** Number of tracked files. */
	get size(): number {
		return this.tracked.size;
	}

	/** Check if a path is tracked. */
	has(path: string): boolean {
		return this.tracked.has(path);
	}
}

/**
 * Compute a simple unified diff between two strings.
 *
 * Produces a minimal diff showing only changed lines with context.
 * Not a full Myers diff — uses a simple line-by-line comparison that
 * handles the common case of small edits in long files.
 *
 * @param oldContent - Previous file content
 * @param newContent - Current file content
 * @param path - File path (for diff header)
 * @returns Unified diff string
 */
function computeUnifiedDiff(oldContent: string, newContent: string, path: string): string {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLen = Math.max(oldLines.length, newLines.length);

	const diffLines: string[] = [`--- ${path} (previous)`, `+++ ${path} (current)`];
	let changes = 0;

	for (let i = 0; i < maxLen; i++) {
		const oldLine = oldLines[i];
		const newLine = newLines[i];

		if (oldLine === newLine) {
			if (changes > 0 && changes < 20) {
				diffLines.push(` ${oldLine ?? ""}`);
			}
			continue;
		}

		if (oldLine !== undefined) {
			diffLines.push(`-${oldLine}`);
			changes++;
		}
		if (newLine !== undefined) {
			diffLines.push(`+${newLine}`);
			changes++;
		}

		if (changes >= 40) {
			diffLines.push("... (truncated, see full file via knapsack_retrieve)");
			break;
		}
	}

	if (changes === 0) {
		return `[no changes detected]`;
	}

	return diffLines.join("\n");
}

/**
 * Check if a tool name indicates a file read operation.
 *
 * @param toolName - Name of the tool that produced the output
 * @returns true if this is a read-type tool (read, Read, cat, etc.)
 */
export function isReadTool(toolName: string): boolean {
	const lower = toolName.toLowerCase();
	return lower === "read" || lower === "cat" || lower === "view";
}

/**
 * Default singleton tracker instance used by the pipeline.
 * Tests should call `readTracker.clear()` in `beforeEach`.
 */
export const readTracker = new ReadTracker();

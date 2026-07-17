/**
 * Compress `find` command output by collapsing to directory tree with file counts.
 *
 * `find` output is typically a flat list of file paths with heavy repetition
 * of directory prefixes. This strategy:
 *
 * 1. Groups files by their immediate parent directory
 * 2. Shows directory structure with file counts
 * 3. Lists representative files (first few per directory)
 * 4. Collapses deeply nested identical structures
 *
 * The model retains structural understanding (which dirs have how many files)
 * without the token cost of every individual path.
 *
 * @module find-compression
 */

import { sha256 } from "../../core/hash";
import { estimateTokens, savingsPercent } from "../../core/tokens";
import type { CompressionResult } from "../../core/types";
import { optimalKCapped } from "../adaptive-sizer";

/**
 * Hard ceiling on the number of subdirectories to render per level. The
 * adaptive sizer (optimalKCapped) picks the actual count based on the
 * content; this just stops pathological inputs from flooding the output.
 */
const MAX_DIRS = 15;

/**
 * Hard ceiling on the number of files to list per directory. The adaptive
 * sizer picks the actual count based on the content; this just caps it.
 */
const MAX_FILES_PER_DIR = 5;

/**
 * Directory tree node for find output compression.
 */
interface DirNode {
	files: string[];
	subdirs: Map<string, DirNode>;
}

/**
 * Compress find output into a directory tree summary.
 *
 * @param output - Raw find command stdout (one path per line)
 * @returns Compression result with directory tree and stats
 *
 * @example
 * ```typescript
 * const result = compressFind("src/a.ts\nsrc/b.ts\nsrc/lib/x.ts\nsrc/lib/y.ts\ntest/a.test.ts");
 * // result.body:
 * //   📦 5 files in 3 dirs
 * //   src/  4 files
 * //     a.ts
 * //     b.ts
 * //     lib/  2 files
 * //       x.ts
 * //       y.ts
 * //   test/  1 files
 * //     a.test.ts
 * ```
 */
export function compressFind(output: string): CompressionResult {
	const paths = output.split("\n").filter((p) => p.trim());

	if (paths.length === 0) {
		return {
			body: "📦 find: 0 files",
			hash: sha256(output),
			originalTokens: estimateTokens(output),
			compressedTokens: estimateTokens("📦 find: 0 files"),
			savingsPercent: 100,
			strategy: "find",
		};
	}

	// Build directory tree
	const root: DirNode = { files: [], subdirs: new Map() };

	for (const path of paths) {
		const parts = path.split("/");
		let node = root;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!;
			if (i === parts.length - 1) {
				// It's a file
				node.files.push(part);
			} else {
				// It's a directory
				if (!node.subdirs.has(part)) {
					node.subdirs.set(part, { files: [], subdirs: new Map() });
				}
				node = node.subdirs.get(part)!;
			}
		}
	}

	// Render tree
	const uniqueDirs = countDirs(root);
	const header = `📦 ${paths.length} files in ${uniqueDirs} dirs`;
	const tree = renderTree(root, "", 0);

	const body = [header, "", tree].join("\n");
	const originalTokens = estimateTokens(output);
	const compressedTokens = estimateTokens(body);

	return {
		body,
		hash: sha256(output),
		originalTokens,
		compressedTokens,
		savingsPercent: savingsPercent(originalTokens, compressedTokens),
		strategy: "find",
	};
}

/**
 * Count unique directories in the tree (excluding leaf files).
 */
function countDirs(node: DirNode): number {
	let count = node.subdirs.size;
	for (const subdir of node.subdirs.values()) {
		count += countDirs(subdir);
	}
	return count;
}

/**
 * Render a directory tree node as indented text lines.
 *
 * @param node - Current directory node
 * @param prefix - Path prefix for this level (e.g., "src/")
 * @param depth - Current nesting depth for indentation
 * @returns Formatted tree string
 */
function renderTree(node: DirNode, prefix: string, depth: number): string {
	const indent = "  ".repeat(depth);
	const lines: string[] = [];

	// Sort subdirectories by total content size (most files first).
	const allDirs = Array.from(node.subdirs.entries()).sort((a, b) => {
		const aSize = countAllFiles(a[1]);
		const bSize = countAllFiles(b[1]);
		return bSize - aSize;
	});
	// Adaptive count: keep enough dirs to surface the variety without flooding
	// the output with near-identical siblings. Hard ceiling = MAX_DIRS.
	const keepDirs = Math.max(
		1,
		optimalKCapped(
			allDirs.map((d) => d[0]),
			MAX_DIRS,
		),
	);
	const sortedDirs = allDirs.slice(0, keepDirs) as [string, DirNode][];

	for (const [name, subdir] of sortedDirs) {
		const totalFiles = countAllFiles(subdir);
		const subPrefix = prefix ? `${prefix}/${name}` : name;
		lines.push(`${indent}${subPrefix}/  ${totalFiles} files`);

		// Adaptive file count — variety over flood.
		const sortedAllFiles = subdir.files.slice().sort();
		const keepFiles = Math.max(1, optimalKCapped(sortedAllFiles, MAX_FILES_PER_DIR));
		for (const file of sortedAllFiles.slice(0, keepFiles)) {
			lines.push(`${indent}  ${file}`);
		}
		if (subdir.files.length > keepFiles) {
			lines.push(`${indent}  (+${subdir.files.length - keepFiles} more files)`);
		}

		if (subdir.subdirs.size > 0) {
			const subLines = renderTree(subdir, subPrefix, depth + 1);
			if (subLines) lines.push(subLines);
		}
	}

	// Collapse remaining directories
	const remainingDirs = node.subdirs.size - sortedDirs.length;
	if (remainingDirs > 0) {
		const entries = Array.from(node.subdirs.entries()) as [string, DirNode][];
		const remainingFiles = entries
			.slice(keepDirs)
			.reduce((sum, entry) => sum + countAllFiles(entry[1]), 0);
		lines.push(`${indent}(+${remainingDirs} more dirs, ${remainingFiles} files)`);
	}

	// Root-level files — adaptive too.
	const sortedRootFiles = node.files.slice().sort();
	const keepRootFiles = Math.max(1, optimalKCapped(sortedRootFiles, MAX_FILES_PER_DIR));
	for (const file of sortedRootFiles.slice(0, keepRootFiles)) {
		lines.push(`${indent}${file}`);
	}
	if (node.files.length > keepRootFiles) {
		lines.push(`${indent}(+${node.files.length - keepRootFiles} more files)`);
	}

	return lines.join("\n");
}

/**
 * Count all files recursively in a directory node.
 */
function countAllFiles(node: DirNode): number {
	let count = node.files.length;
	for (const subdir of node.subdirs.values()) {
		count += countAllFiles(subdir);
	}
	return count;
}

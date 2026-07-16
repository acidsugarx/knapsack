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

/**
 * Maximum number of top-level directories to show in detail.
 * Directories beyond this are collapsed to a summary line.
 */
const MAX_DIRS = 15;

/**
 * Maximum files to list per directory before collapsing to a count.
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

	// Sort subdirectories by total content size (directories with more files first)
	const sortedDirs = Array.from(node.subdirs.entries())
		.sort((a, b) => {
			const aSize = countAllFiles(a[1]);
			const bSize = countAllFiles(b[1]);
			return bSize - aSize;
		})
		.slice(0, MAX_DIRS) as [string, DirNode][];

	for (const [name, subdir] of sortedDirs) {
		const totalFiles = countAllFiles(subdir);
		const subPrefix = prefix ? `${prefix}/${name}` : name;
		lines.push(`${indent}${subPrefix}/  ${totalFiles} files`);

		// List representative files in this directory
		const sortedFiles = subdir.files.sort().slice(0, MAX_FILES_PER_DIR);
		for (const file of sortedFiles) {
			lines.push(`${indent}  ${file}`);
		}

		if (subdir.files.length > MAX_FILES_PER_DIR) {
			lines.push(`${indent}  (+${subdir.files.length - MAX_FILES_PER_DIR} more files)`);
		}

		// Recurse into subdirectories
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
			.slice(MAX_DIRS)
			.reduce((sum, entry) => sum + countAllFiles(entry[1]), 0);
		lines.push(`${indent}(+${remainingDirs} more dirs, ${remainingFiles} files)`);
	}

	// Root-level files
	const sortedRootFiles = node.files.sort().slice(0, MAX_FILES_PER_DIR);
	for (const file of sortedRootFiles) {
		lines.push(`${indent}${file}`);
	}
	if (node.files.length > MAX_FILES_PER_DIR) {
		lines.push(`${indent}(+${node.files.length - MAX_FILES_PER_DIR} more files)`);
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

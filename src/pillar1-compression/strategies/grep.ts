import { sha256 } from "../../core/hash";
import { estimateTokens, savingsPercent } from "../../core/tokens";
import type { CompressionResult } from "../../core/types";

/**
 * Compress grep output by grouping results by directory.
 * Preserves structure, representative matches, and exact counts.
 */
export function compressGrep(output: string): CompressionResult {
	const lines = output.split("\n").filter(Boolean);
	const matches: { file: string; line: string; content: string }[] = [];

	// Parse standard grep -n output: file:linenum:content
	for (const line of lines) {
		const match = line.match(/^(.+?):(\d+):(.*)$/);
		if (match) {
			matches.push({
				file: match[1]!,
				line: match[2]!,
				content: match[3]!,
			});
		}
	}

	if (matches.length === 0) {
		return {
			body: `📦 grep: 0 matches`,
			hash: sha256(output),
			originalTokens: estimateTokens(output),
			compressedTokens: estimateTokens("📦 grep: 0 matches"),
			savingsPercent: 100,
			strategy: "grep",
		};
	}

	// Group by directory → file
	const byDir = new Map<string, Map<string, { line: string; content: string }[]>>();
	for (const m of matches) {
		const dir = dirname(m.file);
		if (!byDir.has(dir)) byDir.set(dir, new Map());
		const fileMap = byDir.get(dir)!;
		if (!fileMap.has(m.file)) fileMap.set(m.file, []);
		fileMap.get(m.file)!.push({ line: m.line, content: m.content });
	}

	// Build output — top directories, top files per dir, first 3 lines per file
	const maxDirs = 8;
	const maxFilesPerDir = 5;
	const maxLinesPerFile = 3;

	const sortedDirs = Array.from(byDir.entries())
		.sort((a, b) => {
			const aTotal = Array.from(a[1].values()).reduce((s, v) => s + v.length, 0);
			const bTotal = Array.from(b[1].values()).reduce((s, v) => s + v.length, 0);
			return bTotal - aTotal;
		})
		.slice(0, maxDirs);

	const parts: string[] = [];
	let _shownCount = 0;

	for (const [dir, files] of sortedDirs) {
		const dirTotal = Array.from(files.values()).reduce((s, v) => s + v.length, 0);
		const sortedFiles = Array.from(files.entries())
			.sort((a, b) => b[1].length - a[1].length)
			.slice(0, maxFilesPerDir);

		parts.push(`${dir}/  (${dirTotal} matches in ${files.size} files)`);

		for (const [file, fileMatches] of sortedFiles) {
			const previews = fileMatches.slice(0, maxLinesPerFile);
			parts.push(`  ${shortName(file)}  ${fileMatches.length} matches`);
			for (const m of previews) {
				const content = m.content.length > 80 ? `${m.content.slice(0, 77)}...` : m.content;
				parts.push(`    L${m.line}: ${content}`);
			}
			if (fileMatches.length > maxLinesPerFile) {
				parts.push(`    (+${fileMatches.length - maxLinesPerFile} more)`);
			}
		}

		const remainingFiles = files.size - sortedFiles.length;
		const remainingMatches = dirTotal - sortedFiles.reduce((s, [, v]) => s + v.length, 0);
		if (remainingFiles > 0) {
			parts.push(`  (+${remainingFiles} more files, ${remainingMatches} matches)`);
		}

		_shownCount += dirTotal;
	}

	const uniqueFiles = new Set(matches.map((m) => m.file)).size;
	const header = `📦 ${matches.length} matches in ${uniqueFiles} files`;

	const body = parts.join("\n");
	const outputText = `${header}\n\n${body}`;
	const originalTokens = estimateTokens(output);
	const compressedTokens = estimateTokens(outputText);

	return {
		body: outputText,
		hash: sha256(output),
		originalTokens,
		compressedTokens,
		savingsPercent: savingsPercent(originalTokens, compressedTokens),
		strategy: "grep",
	};
}

// ── Helpers ────────────────────────────────────────────

function dirname(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "." : path.slice(0, idx);
}

function shortName(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.slice(idx + 1);
}

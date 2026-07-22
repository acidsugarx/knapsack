#!/usr/bin/env node
// JSDoc compliance checker — enforces AGENTS.md documentation rules.
//
// Checks:
// 1. Every .ts file in src/ has a @module block
// 2. Every exported symbol has a JSDoc block immediately before it
// 3. Every pi.on(...), pi.registerTool(...), pi.registerCommand(...) call
//    has a JSDoc block immediately before it
//
// Run: node scripts/check-jsdoc.mjs
// Exit code: 0 if all checks pass, 1 if violations found.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(process.cwd(), "src");
const violations = [];

function collectTsFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir)) {
		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) {
			files.push(...collectTsFiles(fullPath));
		} else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
			files.push(fullPath);
		}
	}
	return files;
}

function hasJSDocBefore(lines, lineIdx) {
	let i = lineIdx - 1;
	while (i >= 0) {
		const trimmed = lines[i].trim();
		if (trimmed === "" || trimmed.startsWith("//")) {
			i--;
			continue;
		}
		break;
	}
	if (i < 0) return false;
	return lines[i].trim().endsWith("*/");
}

const EXPORT_PATTERNS = [
	/^\s*export\s+function\s+/,
	/^\s*export\s+async\s+function\s+/,
	/^\s*export\s+class\s+/,
	/^\s*export\s+interface\s+/,
	/^\s*export\s+type\s+/,
	/^\s*export\s+const\s+/,
	/^\s*export\s+default\s+async\s+function\s+/,
	/^\s*export\s+default\s+function\s+/,
];

const LIFECYCLE_PATTERNS = [
	/^\s*pi\.on\s*\(/,
	/^\s*pi\.registerTool\s*\(/,
	/^\s*pi\.registerCommand\s*\(/,
];

function checkFile(filePath) {
	const content = readFileSync(filePath, "utf-8");
	const lines = content.split("\n");
	const relPath = relative(process.cwd(), filePath);

	const hasModule = lines.some((l) => l.includes("@module"));
	if (!hasModule) {
		violations.push(`${relPath}: missing @module block`);
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
			continue;
		}

		for (const pattern of EXPORT_PATTERNS) {
			if (pattern.test(line)) {
				if (!hasJSDocBefore(lines, i)) {
					const symbol = line
						.replace(/^\s*export\s+(?:default\s+)?(?:async\s+)?/, "")
						.split(/[\s({]/)[0];
					violations.push(`${relPath}:${i + 1}: exported "${symbol}" missing JSDoc`);
				}
				break;
			}
		}

		for (const pattern of LIFECYCLE_PATTERNS) {
			if (pattern.test(line)) {
				if (!hasJSDocBefore(lines, i)) {
					const handler = line.match(
						/pi\.(on|registerTool|registerCommand)\s*\(\s*["']?([^"')\s]+)/,
					);
					const name = handler ? handler[2] : "?";
					violations.push(
						`${relPath}:${i + 1}: pi.${handler?.[1] ?? "on"}("${name}") missing JSDoc`,
					);
				}
				break;
			}
		}
	}
}

const files = collectTsFiles(SRC_DIR);
for (const file of files) {
	checkFile(file);
}

if (violations.length === 0) {
	console.log(`\u2713 JSDoc check passed (${files.length} files scanned)`);
	process.exit(0);
}

console.error(`\u2717 JSDoc check failed: ${violations.length} violation(s)\n`);
for (const v of violations) {
	console.error(`  ${v}`);
}
console.error(`\nSee AGENTS.md "Documentation" section for rules.`);
process.exit(1);

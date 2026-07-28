/**
 * Memory lint — deterministic structural health check for the wiki projection.
 *
 * Checks the generated wiki at ~/.knapsack/wiki/ for common issues:
 * broken wikilinks, orphan pages, stale entries, oversized pages.
 * No LLM required — pure filesystem scan + SQLite query.
 *
 * Design: ddsyasas/llm-wiki two-layer model (deterministic ground truth +
 * optional LLM semantic pass). This module implements the deterministic layer.
 *
 * @module memory-lint
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore } from "../core/types";

/** Maximum page size before flagged as oversized (soft threshold). */
const OVERSIZED_LINES = 400;
/** Days before a memory is considered stale. */
const STALE_DAYS = 60;

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

/**
 * Lint finding — one issue detected by the deterministic scanner.
 */
export interface LintFinding {
	type: "broken-link" | "orphan" | "stale" | "oversized";
	severity: "high" | "medium" | "low";
	file: string;
	detail: string;
}

/**
 * Result of a deterministic lint pass.
 */
export interface LintResult {
	findings: LintFinding[];
	totalPages: number;
	healthScore: number;
}

/**
 * Run deterministic lint on the wiki directory.
 *
 * @param wikiDir - Path to ~/.knapsack/wiki/
 * @param db - Open KnapsackDB handle
 * @param store - Runtime store
 * @returns Structured lint findings with health score (0-100)
 */
export function deterministicLint(
	wikiDir: string,
	db: KnapsackDB,
	store: KnapsackStore,
): LintResult {
	const findings: LintFinding[] = [];

	if (!existsSync(wikiDir)) {
		return { findings: [], totalPages: 0, healthScore: 100 };
	}

	const mdFiles = collectMarkdown(wikiDir);
	const allSlugs = new Set(mdFiles.map((f) => slugFromFile(f)));
	const inboundLinks = new Map<string, number>();

	for (const file of mdFiles) {
		const content = readFileSync(file, "utf8");
		const relativePath = file.replace(`${wikiDir}/`, "").replace(/\.md$/, "");
		const lines = content.split("\n").length;

		let matches: RegExpExecArray | null;
		WIKILINK_RE.lastIndex = 0;
		matches = WIKILINK_RE.exec(content);
		while (matches !== null) {
			const target = matches[1]!.trim();
			inboundLinks.set(target, (inboundLinks.get(target) ?? 0) + 1);
			if (!allSlugs.has(target) && target !== "index" && target !== "log") {
				findings.push({
					type: "broken-link",
					severity: "high",
					file: relativePath,
					detail: `[[${target}]] — target page not found`,
				});
			}
			matches = WIKILINK_RE.exec(content);
		}

		if (lines > OVERSIZED_LINES) {
			findings.push({
				type: "oversized",
				severity: "medium",
				file: relativePath,
				detail: `${lines} lines (threshold: ${OVERSIZED_LINES})`,
			});
		}
	}

	for (const file of mdFiles) {
		const slug = slugFromFile(file);
		const isInbound = (inboundLinks.get(slug) ?? 0) > 0;
		const isIndex = slug === "index" || file.endsWith("index.md");
		const isLog = slug === "log" || file.endsWith("log.md");
		if (!isInbound && !isIndex && !isLog) {
			findings.push({
				type: "orphan",
				severity: "low",
				file: slug,
				detail: "No inbound wikilinks from other pages",
			});
		}
	}

	const now = Date.now();
	const staleCutoff = now - STALE_DAYS * 24 * 60 * 60 * 1000;
	const allMemories = db.getAllMemories(store.projectRoot ?? undefined);
	for (const m of allMemories.filter((m) => !m.supersededBy && m.recency < staleCutoff)) {
		if (m.importance < 0.7) {
			findings.push({
				type: "stale",
				severity: "low",
				file: m.id,
				detail: `${Math.floor((now - m.recency) / (24 * 60 * 60 * 1000))}d old, importance ${m.importance}`,
			});
		}
	}

	const highCount = findings.filter((f) => f.severity === "high").length;
	const medCount = findings.filter((f) => f.severity === "medium").length;
	let healthScore = 100;
	if (highCount > 0) healthScore = Math.min(healthScore, 40);
	else if (medCount > 0) healthScore = Math.min(healthScore, 70);

	return { findings, totalPages: mdFiles.length, healthScore };
}

function collectMarkdown(dir: string): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectMarkdown(path));
		} else if (entry.name.endsWith(".md")) {
			results.push(path);
		}
	}
	return results;
}

function slugFromFile(filePath: string): string {
	const parts = filePath.split("/");
	const filename = parts[parts.length - 1] ?? "";
	return filename.replace(/\.md$/, "");
}

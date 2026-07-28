/**
 * Wiki projection — regenerates a markdown wiki from the SQLite memory store.
 *
 * The wiki lives at `~/.knapsack/wiki/` (machine-owned, NOT the Obsidian vault).
 * It is regenerated wholesale after each dream cycle — never edited incrementally.
 * SQLite remains the source of truth; the wiki is a read model for humans and
 * for LLM index-first navigation at moderate scale (Karpathy LLM Wiki pattern).
 *
 * Files generated:
 * - `index.md` — catalog, one line per live memory, ≤200 lines hard cap
 * - `log.md` — append-only timeline of dream cycles and ingest events
 * - `<type>/<slug>.md` — pages for high-importance memories with [[wikilinks]]
 *
 * @module wiki-projection
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore } from "../core/types";

/** Maximum lines in index.md before entries are truncated. */
const MAX_INDEX_LINES = 200;

/** Emoji per memory type for wiki display. */
const TYPE_EMOJI: Record<string, string> = {
	decision: "🔒",
	fact: "📋",
	gotcha: "⚠️",
	convention: "📐",
	preference: "💭",
	command: "⚡",
	constraint: "🚫",
	hypothesis: "🧪",
};

/**
 * Regenerate the entire wiki from the live memory store.
 *
 * @param db - Open KnapsackDB handle
 * @param store - Runtime store (project root)
 * @param wikiDir - Target directory for wiki files
 * @returns Summary of what was generated
 */
export function regenerateWiki(
	db: KnapsackDB,
	store: KnapsackStore,
	wikiDir: string,
): { indexEntries: number; pagesGenerated: number; logAppended: boolean } {
	if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true });

	const all = db.getAllMemories(store.projectRoot ?? undefined).filter((m) => !m.supersededBy);

	const indexEntries = writeIndex(db, store, wikiDir, all);
	const pagesGenerated = writePages(wikiDir, all);
	const logAppended = appendLog(wikiDir, all.length);

	return { indexEntries, pagesGenerated, logAppended };
}

/**
 * Generate `index.md` — one-line catalog of all live memories.
 */
function writeIndex(
	_db: KnapsackDB,
	_store: KnapsackStore,
	wikiDir: string,
	memories: import("../core/types").MemoryEntry[],
): number {
	const byType = new Map<string, import("../core/types").MemoryEntry[]>();
	for (const m of memories) {
		const list = byType.get(m.type) ?? [];
		list.push(m);
		byType.set(m.type, list);
	}

	const lines: string[] = [
		"# Knapsack Memory Index",
		"",
		`> Auto-generated. ${memories.length} live entries. Source of truth: SQLite.`,
		"",
	];

	for (const [type, entries] of byType) {
		const emoji = TYPE_EMOJI[type] ?? "📌";
		lines.push(`## ${emoji} ${type} (${entries.length})`);
		lines.push("");
		for (const m of entries.sort((a, b) => b.importance - a.importance)) {
			const slug = makeSlug(type, m.content);
			const summary = m.content.replace(/\n/g, " ").slice(0, 80);
			lines.push(`- [[${slug}]] — ${summary}`);
		}
		lines.push("");
		if (lines.length > MAX_INDEX_LINES) {
			lines.push(`_...and ${memories.length - lines.length} more entries_`);
			break;
		}
	}

	writeFileSync(join(wikiDir, "index.md"), lines.join("\n"), "utf8");
	return memories.length;
}

/**
 * Generate individual pages for high-importance memories.
 */
function writePages(wikiDir: string, memories: import("../core/types").MemoryEntry[]): number {
	let count = 0;
	for (const m of memories.filter((m) => m.importance >= 0.7)) {
		const slug = makeSlug(m.type, m.content);
		const typeDir = join(wikiDir, m.type);
		if (!existsSync(typeDir)) mkdirSync(typeDir, { recursive: true });

		const frontmatter = [
			"---",
			`type: ${m.type}`,
			`importance: ${m.importance}`,
			`confidence: ${m.confidence ?? 0.7}`,
			`strength: ${m.strength ?? 1}`,
			`created: ${m.createdAt}`,
			`updated: ${m.updatedAt}`,
			m.supersededBy ? `superseded_by: ${m.supersededBy}` : null,
			"---",
		]
			.filter(Boolean)
			.join("\n");

		const body = [
			frontmatter,
			"",
			`# ${m.content.slice(0, 60)}`,
			"",
			m.content,
			"",
			`_Importance: ${m.importance} · Access: ${m.accessCount} · Created: ${m.createdAt.slice(0, 10)}_`,
		].join("\n");

		writeFileSync(join(typeDir, `${slug}.md`), body, "utf8");
		count++;
	}
	return count;
}

/**
 * Append a dream-cycle entry to `log.md`.
 */
function appendLog(wikiDir: string, totalEntries: number): boolean {
	const logPath = join(wikiDir, "log.md");
	const now = new Date().toISOString().slice(0, 16);
	const entry = `## [${now}] dream | ${totalEntries} live entries\n`;

	let existing = "";
	if (existsSync(logPath)) {
		existing = readFileSync(logPath, "utf8");
	}

	writeFileSync(logPath, entry + existing, "utf8");
	return true;
}

/**
 * Generate a filesystem-safe slug from type + content.
 */
function makeSlug(type: string, content: string): string {
	const prefix = type.substring(0, 3);
	const body = content
		.substring(0, 60)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${prefix}-${body || "untitled"}`;
}

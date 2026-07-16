/**
 * Obsidian note operations — create, link, and search structured notes.
 *
 * ## Zettelkasten integration
 *
 * Beyond flat facts/decisions (knapsack_save), Knapsack can create
 * structured, interlinked Obsidian notes. This enables:
 *
 * - **Atomic notes** — one concept per note, Zettelkasten-style
 * - **Wikilinks** — [[other-note]] connections between ideas
 * - **Frontmatter** — YAML metadata for Dataview queries
 * - **Tagging** — #topic tags for browsing and aggregation
 *
 * The LLM uses these to build a personal knowledge base over time.
 *
 * @module obsidian-notes
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Frontmatter metadata for a Knapsack-created Obsidian note.
 */
export interface NoteMeta {
	title: string;
	tags?: string[];
	created?: string;
	updated?: string;
	type?: "concept" | "howto" | "reference" | "decision" | "insight";
	/** Related note paths (wikilinks) */
	related?: string[];
	/** Source context — what prompted this note */
	source?: string;
}

/**
 * Create a structured Obsidian note with YAML frontmatter and wikilinks.
 *
 * Notes are created under `knapsack/notes/` in the vault.
 * If a note with the same title exists, it's updated (updated_at bumped).
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param meta - Note metadata (title, tags, type, related)
 * @param content - Markdown body of the note
 * @returns Relative vault path to the created note
 *
 * @example
 * ```typescript
 * createNote(vaultPath, {
 *   title: "PostgreSQL Connection Pooling",
 *   tags: ["postgres", "database", "performance"],
 *   type: "howto",
 *   related: ["PgBouncer Setup"],
 * }, "## Overview\n\n...");
 * ```
 */
export function createNote(
	vaultPath: string | null,
	meta: NoteMeta,
	content: string,
): string | null {
	if (!vaultPath) return null;

	const dir = join(vaultPath, "knapsack", "notes");
	mkdirSync(dir, { recursive: true });

	const now = new Date().toISOString();
	const slug = meta.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	const notePath = join(dir, `${slug}.md`);

	// Build frontmatter
	const fm: string[] = ["---"];
	fm.push(`title: "${meta.title}"`);
	fm.push(`type: "${meta.type ?? "concept"}"`);
	if (meta.tags?.length) {
		fm.push(`tags: [${meta.tags.join(", ")}]`);
	}
	if (meta.related?.length) {
		fm.push(`related:`);
		for (const r of meta.related) {
			fm.push(`  - "[[${r}]]"`);
		}
	}
	fm.push(`created: "${meta.created ?? now}"`);
	fm.push(`updated: "${now}"`);
	if (meta.source) {
		fm.push(`source: "${meta.source}"`);
	}
	fm.push("knapsack_note: true");
	fm.push("---");

	// Build body with wikilinks
	const body = [
		fm.join("\n"),
		"",
		`# ${meta.title}`,
		"",
		// Auto-generate related section if there are links
		meta.related?.length ? `**Related:** ${meta.related.map((r) => `[[${r}]]`).join(" · ")}\n` : "",
		content,
	].join("\n");

	writeFileSync(notePath, body, "utf-8");

	return `knapsack/notes/${slug}`;
}

/**
 * Read a Knapsack-managed note from the vault.
 *
 * Parses YAML frontmatter and returns metadata + body separately.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param title - Note title (slug or full title)
 * @returns Note metadata and content, or null if not found
 */
export function readNote(
	vaultPath: string | null,
	title: string,
): { meta: NoteMeta; content: string } | null {
	if (!vaultPath) return null;

	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	const notePath = join(vaultPath, "knapsack", "notes", `${slug}.md`);

	if (!existsSync(notePath)) return null;

	const raw = readFileSync(notePath, "utf-8");

	// Parse frontmatter
	const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
	if (!fmMatch?.[1]) {
		return { meta: { title }, content: raw };
	}

	const meta: NoteMeta = { title };
	const fmLines = fmMatch[1].split("\n");
	for (const line of fmLines) {
		const kv = line.match(/^(\w+):\s*(.+)$/);
		if (!kv) continue;
		const [, key, value] = kv;
		switch (key) {
			case "title":
				meta.title = value.replace(/^"(.*)"$/, "$1");
				break;
			case "type":
				meta.type = value as NoteMeta["type"];
				break;
			case "tags":
				meta.tags = value
					.replace(/^\[|\]$/g, "")
					.split(",")
					.map((t) => t.trim());
				break;
			case "source":
				meta.source = value.replace(/^"(.*)"$/, "$1");
				break;
		}
	}

	const content = raw.slice((fmMatch[0]?.length ?? 0) + 1).trim();

	return { meta, content };
}

/**
 * Append to an existing Knapsack note.
 *
 * Adds content with a timestamp header. Creates the note if it doesn't exist.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param title - Note title
 * @param content - Content to append
 */
export function appendNote(
	vaultPath: string | null,
	title: string,
	content: string,
): string | null {
	if (!vaultPath) return null;

	const existing = readNote(vaultPath, title);
	if (existing) {
		const slug = title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");
		const notePath = join(vaultPath, "knapsack", "notes", `${slug}.md`);
		const now = new Date().toISOString();
		const append = `\n\n## Update ${now}\n\n${content}`;
		writeFileSync(notePath, readFileSync(notePath, "utf-8") + append, "utf-8");
		return `knapsack/notes/${slug}`;
	}

	// Create new note
	return createNote(vaultPath, { title, type: "insight" }, content);
}

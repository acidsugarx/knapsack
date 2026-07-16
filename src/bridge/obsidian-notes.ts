/**
 * Obsidian note operations — minimal, Zettelkasten-friendly.
 *
 * ## Philosophy
 *
 * Notes live in the vault root, no subdirectories. No YAML frontmatter.
 * The LLM writes markdown with [[wikilinks]] inline — exactly like the
 * user's daily-notes → wikilink workflow.
 *
 * - Create note by title → vault/Title.md
 * - Append to existing note with timestamp
 * - No enforced structure — the LLM decides what goes in
 *
 * @module obsidian-notes
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Validate that a resolved path stays within the vault root.
 * Prevents path traversal (e.g., title="../../../etc/cron.d/backdoor").
 */
function isPathSafe(vaultPath: string, targetPath: string): boolean {
	const rel = relative(vaultPath, resolve(targetPath));
	return !rel.startsWith("..") && !rel.startsWith("/");
}

/**
 * Sanitize a title into a safe filename — strip path separators.
 */
function sanitizeTitle(title: string): string {
	return title.replace(/[/\\:*?"<>|]/g, "-").trim() || "untitled";
}

/**
 * Create or update a markdown note in the Obsidian vault root.
 *
 * If a note with the same title exists, content is appended with
 * a `## Update` timestamp header.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param title - Note title (becomes filename, .md added if missing)
 * @param content - Markdown content for the note
 * @returns Relative vault path to the note
 *
 * @example
 * ```typescript
 * writeNote(vault, "PostgreSQL Pooling", "## How it works\n\n...");
 * // → "PostgreSQL Pooling.md"
 * ```
 */
export function writeNote(vaultPath: string | null, title: string, content: string): string | null {
	if (!vaultPath) return null;

	mkdirSync(vaultPath, { recursive: true });

	const filename = title.endsWith(".md") ? title : `${title}.md`;
	const notePath = join(vaultPath, filename);

	if (existsSync(notePath)) {
		// Append with timestamp
		const now = new Date().toISOString().slice(0, 19).replace("T", " ");
		const append = `\n\n## Update ${now}\n\n${content}`;
		writeFileSync(notePath, readFileSync(notePath, "utf-8") + append, "utf-8");
	} else {
		// Create new note
		writeFileSync(notePath, content, "utf-8");
	}

	return filename;
}

/**
 * Read a note from the Obsidian vault.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param title - Note title or filename (with or without .md)
 * @returns Note content, or null if not found
 */
export function readNoteText(vaultPath: string | null, title: string): string | null {
	if (!vaultPath) return null;

	const safeTitle = sanitizeTitle(title);
	const filename = safeTitle.endsWith(".md") ? safeTitle : `${safeTitle}.md`;
	const notePath = join(vaultPath, filename);

	if (!isPathSafe(vaultPath, notePath)) {
		return null; // Path traversal blocked
	}

	if (!existsSync(notePath)) return null;

	return readFileSync(notePath, "utf-8");
}

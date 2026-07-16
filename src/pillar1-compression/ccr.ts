import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Compress-Cache-Retrieve (CCR) — Knapsack's reversible compression layer.
 *
 * ## How it works
 *
 * 1. **Compress**: Tool output is compressed, original is hashed (SHA256)
 * 2. **Cache**: Original is stored as a Markdown note in Obsidian vault under `knapsack/compress/{hash}.md`
 * 3. **Retrieve**: Model calls `knapsack_retrieve(hash)` to get the full original
 *
 * This guarantees **no information loss** — the model always has a path back
 * to the complete output. The compressed version provides enough signal for
 * most decisions; the original is one tool call away.
 *
 * ## Storage format
 *
 * Each cached original is a Markdown note with YAML frontmatter:
 * ```yaml
 * ---
 * knapsack_hash: "a1b2c3d4"
 * knapsack_tool: "bash"
 * original_tokens: 4236
 * compressed_tokens: 890
 * savings: 79
 * session: "2026-07-15_uuid"
 * created: "2026-07-15T12:00:00.000Z"
 * tags: [knapsack/compress]
 * ---
 * ```
 *
 * The body is the original output verbatim, wrapped in a code fence.
 *
 * ## Idempotency
 *
 * `cache()` checks file existence before writing. Calling it twice with the
 * same hash is a no-op on the filesystem.
 *
 * @module ccr
 */

const HASH_PATTERN = /^[a-f0-9]{1,64}$/;

/**
 * Validate that a hash contains only hex characters (no path traversal).
 */
function isValidHash(hash: string): boolean {
	return HASH_PATTERN.test(hash);
}

const CCR_DIR = "knapsack/compress";

/**
 * Store an original (uncompressed) tool output in the Obsidian vault.
 *
 * Creates the `knapsack/compress/` directory if it doesn't exist.
 * Skips the write if a note with this hash already exists (idempotent).
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param hash - SHA256 content hash (used as filename)
 * @param original - The full, uncompressed tool output
 * @param meta - Metadata about the compression (tool name, token counts, etc.)
 * @returns Relative vault path to the created note, or null if vaultPath is unavailable
 */
export function cache(
	vaultPath: string | null,
	hash: string,
	original: string,
	meta: {
		toolName: string;
		originalTokens: number;
		compressedTokens: number;
		savingsPercent: number;
		sessionId?: string | null;
	},
): string | null {
	if (!vaultPath) return null;

	const dir = join(vaultPath, CCR_DIR);
	mkdirSync(dir, { recursive: true });

	const notePath = join(dir, `${hash}.md`);

	// Idempotency: don't overwrite existing notes
	if (existsSync(notePath)) {
		return `${CCR_DIR}/${hash}`;
	}

	const now = new Date().toISOString();
	const frontmatter = [
		"---",
		`knapsack_hash: "${hash}"`,
		`knapsack_tool: "${meta.toolName}"`,
		`original_tokens: ${meta.originalTokens}`,
		`compressed_tokens: ${meta.compressedTokens}`,
		`savings: ${meta.savingsPercent}`,
		`session: "${meta.sessionId ?? "unknown"}"`,
		`created: "${now}"`,
		"tags: [knapsack/compress]",
		"---",
	].join("\n");

	const body = `\n# Compressed ${meta.toolName} output\n\nOriginal: ${meta.originalTokens} tokens → Compressed: ${meta.compressedTokens} tokens (${meta.savingsPercent}% saved)\n\n\`\`\`knapsack-ccr\n${original}\n\`\`\`\n`;

	writeFileSync(notePath, `${frontmatter}\n${body}`, "utf-8");

	return `${CCR_DIR}/${hash}`;
}

/**
 * Retrieve a cached original from the Obsidian vault.
 *
 * Reads the full original from `knapsack/compress/{hash}.md` and extracts
 * the content from the code fence.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param hash - SHA256 content hash
 * @returns The original uncompressed output, or null if not found
 */
export function retrieve(vaultPath: string | null, hash: string): string | null {
	if (!vaultPath) return null;
	if (!isValidHash(hash)) return null; // Block path traversal

	const notePath = join(vaultPath, CCR_DIR, `${hash}.md`);
	if (!existsSync(notePath)) return null;

	const content = readFileSync(notePath, "utf-8");

	// Extract body from code fence — uses unique delimiter to avoid truncation
	const fenceMatch = content.match(/```knapsack-ccr\n([\s\S]*?)\n```/);
	if (fenceMatch?.[1]) {
		return fenceMatch[1];
	}

	// Fallback: strip frontmatter and return the rest
	const bodyStart = content.indexOf("---\n", 4);
	if (bodyStart !== -1) {
		return content.slice(bodyStart + 4).trim();
	}

	return content;
}

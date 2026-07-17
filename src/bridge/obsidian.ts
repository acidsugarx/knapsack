/**
 * Obsidian vault discovery and integration bridge.
 *
 * ## How vault discovery works
 *
 * Obsidian stores its vault configuration in `obsidian.json` at:
 * - macOS: `~/Library/Application Support/obsidian/obsidian.json`
 * - Linux: `~/.config/obsidian/obsidian.json`
 * - Windows: `%APPDATA%/obsidian/obsidian.json`
 *
 * Knapsack reads this file to find the first available vault path,
 * preferring `SECOND_BRAIN` (the most common main vault name).
 *
 * ## Search integration
 *
 * `searchVault()` performs a grep-based search across all markdown files
 * in the vault. This gives the model access to the user's knowledge base
 * without requiring an MCP server or Obsidian plugin.
 *
 * @module obsidian-bridge
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

/**
 * Obsidian vault configuration structure from obsidian.json.
 * Only the fields we need for vault discovery.
 */
interface ObsidianConfig {
	vaults?: Record<
		string,
		{
			path: string;
			ts?: number;
			open?: boolean;
		}
	>;
}

/**
 * Discover the user's Obsidian vault path.
 *
 * Resolution order:
 * 1. `KNAPSACK_OBSIDIAN_VAULT` environment variable (absolute path)
 * 2. Auto-discovery from `obsidian.json` (prefers "SECOND_BRAIN" vault)
 * 3. null — Obsidian features disabled, compression still works
 *
 * @returns Absolute path to the vault root, or null if no vault found
 */
export function discoverVault(): string | null {
	// 1. Explicit override via environment variable
	const envPath = process.env.KNAPSACK_OBSIDIAN_VAULT;
	if (envPath && existsSync(envPath)) {
		return envPath;
	}

	// 2. Auto-discovery from Obsidian config
	const configPath = findObsidianConfig();
	if (!configPath || !existsSync(configPath)) return null;

	try {
		const raw = readFileSync(configPath, "utf-8");
		const config = JSON.parse(raw) as ObsidianConfig;

		if (!config.vaults) return null;

		const vaults = Object.values(config.vaults);
		if (vaults.length === 0) return null;

		// Prefer SECOND_BRAIN
		const preferred = vaults.find(
			(v) => v.path.includes("SECOND_BRAIN") || v.path.includes("second-brain"),
		);
		if (preferred?.path && existsSync(preferred.path)) {
			return preferred.path;
		}

		// Fall back to first available vault
		for (const vault of vaults) {
			if (vault.path && existsSync(vault.path)) {
				return vault.path;
			}
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Find the Obsidian config file path based on the current OS.
 *
 * @returns Absolute path to obsidian.json, or null if the OS is not supported
 */
function findObsidianConfig(): string | null {
	const home = homedir();

	switch (process.platform) {
		case "darwin":
			return join(home, "Library", "Application Support", "obsidian", "obsidian.json");
		case "linux":
			return join(home, ".config", "obsidian", "obsidian.json");
		case "win32":
			return join(
				process.env.APPDATA ?? join(home, "AppData", "Roaming"),
				"obsidian",
				"obsidian.json",
			);
		default:
			return null;
	}
}

/**
 * Search across all markdown files in the Obsidian vault using ripgrep (rg).
 *
 * Falls back to grep if ripgrep is not available.
 * Results include filename, line number, and matching line content.
 *
 * @param vaultPath - Absolute path to the Obsidian vault root
 * @param query - Search query (passed directly to rg/grep)
 * @param limit - Maximum number of results to return
 * @returns Array of match strings in "file:line:content" format, or null if vaultPath is unavailable
 */
export function searchVault(vaultPath: string | null, query: string, limit = 20): string[] | null {
	if (!vaultPath) return null;

	try {
		// Use execFileSync to prevent shell injection — args passed as array elements
		const output = execFileSync(
			"rg",
			["--no-heading", "--with-filename", "--line-number", "--max-count=1", "-e", query, vaultPath],
			{ encoding: "utf-8", timeout: 5000, maxBuffer: 1024 * 1024 },
		);
		return output.trim().split("\n").filter(Boolean).slice(0, limit);
	} catch {
		// ripgrep not available or no results, try grep
		try {
			const output = execFileSync("grep", ["-rn", "--include=*.md", "-m1", query, vaultPath], {
				encoding: "utf-8",
				timeout: 5000,
				maxBuffer: 1024 * 1024,
			});
			return output.trim().split("\n").filter(Boolean).slice(0, limit);
		} catch {
			return [];
		}
	}
}

// ── Frontmatter-aware search ────────────────────────────────────────────────

export interface VaultSearchHit {
	/** Match string in "file:line:content" format (unchanged from searchVault). */
	raw: string;
	/** Path to the file the match landed in. */
	file: string;
	/** Line number (1-based). */
	line: number;
	/** Content of the matching line. */
	content: string;
	/** Parsed YAML frontmatter if the file is a markdown note with one. */
	frontmatter?: Record<string, string | string[]>;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

/** Parse the simple subset of YAML used in Obsidian frontmatter. */
function parseFrontmatter(noteText: string): Record<string, string | string[]> | undefined {
	const m = noteText.match(FRONTMATTER_RE);
	if (!m) return undefined;
	const out: Record<string, string | string[]> = {};
	let currentKey = "";
	for (const line of (m[1] ?? "").split("\n")) {
		const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (kv) {
			currentKey = kv[1] ?? "";
			const v = (kv[2] ?? "").trim().replace(/^["']|["']$/g, "");
			if (v) out[currentKey] = v;
			else if (!(currentKey in out)) out[currentKey] = [];
			continue;
		}
		const li = line.match(/^\s+-\s+(.*)$/);
		if (li && currentKey) {
			const item = (li[1] ?? "").trim().replace(/^["']|["']$/g, "");
			const existing = out[currentKey];
			if (Array.isArray(existing)) existing.push(item);
			else if (typeof existing === "string" && existing) out[currentKey] = [existing, item];
			else out[currentKey] = [item];
		}
	}
	return out;
}

/**
 * Run a vault search and enrich each match with the YAML frontmatter of the
 * file it landed in (when present). The raw match string is preserved so
 * callers can still render the original `file:line:content` form.
 *
 * Frontmatter is read once per file (cached for the call) so adding this
 * enrichment to a search with 20 matches in 5 files costs 5 file reads, not 20.
 *
 * @param vaultPath - Vault root used to scope the search and validate match paths.
 * @param query - Search query forwarded to ripgrep / grep.
 * @param limit - Maximum number of raw matches returned by the underlying search.
 * @returns Enriched hits, or null when `vaultPath` is unavailable.
 */
export function searchVaultWithFrontmatter(
	vaultPath: string | null,
	query: string,
	limit = 20,
): VaultSearchHit[] | null {
	if (!vaultPath) return null;
	const raw = searchVault(vaultPath, query, limit);
	if (!raw) return null;

	const fmCache = new Map<string, Record<string, string | string[]> | undefined>();
	const hits: VaultSearchHit[] = [];
	for (const line of raw) {
		const m = line.match(/^(.+?):(\d+):(.*)$/);
		if (!m) continue;
		const [, file, lineNum, content] = m;
		const filePath = file ?? "";
		// Trust boundary: rg output is influenced by the user query, so the
		// path must stay inside the vault. Reject anything that escapes via
		// '..' or resolves to an absolute path outside the vault root.
		const rel = relative(vaultPath, filePath);
		if (isAbsolute(rel) || rel.startsWith("..")) continue;
		let frontmatter = fmCache.get(filePath);
		if (frontmatter === undefined && filePath.endsWith(".md")) {
			try {
				const text = readFileSync(filePath, "utf8");
				frontmatter = parseFrontmatter(text);
			} catch {
				frontmatter = undefined;
			}
			fmCache.set(filePath, frontmatter);
		}
		hits.push({
			raw: line,
			file: filePath,
			line: Number(lineNum ?? 0),
			content: content ?? "",
			frontmatter,
		});
	}
	return hits;
}

/**
 * Format frontmatter-aware hits into a single string for tool output.
 *
 * @param hits - Hits returned by {@link searchVaultWithFrontmatter} (or null).
 * @returns One line per hit with `key=value` frontmatter appended, or
 * `"(no matches)"` for empty input.
 */
export function formatVaultHits(hits: VaultSearchHit[] | null): string {
	if (!hits || hits.length === 0) return "(no matches)";
	const lines: string[] = [];
	for (const h of hits) {
		const fm =
			h.frontmatter && Object.keys(h.frontmatter).length > 0
				? ` · ${(Object.entries(h.frontmatter).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : v}`)).join(" ")}`
				: "";
		lines.push(`${h.raw}${fm}`);
	}
	return lines.join("\n");
}

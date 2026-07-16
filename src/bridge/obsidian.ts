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

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
 * Checks common config file locations based on the OS, parses the JSON,
 * and prefers the vault named "SECOND_BRAIN" (most common main vault name).
 * Falls back to the first available vault if SECOND_BRAIN is not found.
 *
 * @returns Absolute path to the vault root, or null if no vault found
 */
export function discoverVault(): string | null {
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
			return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "obsidian", "obsidian.json");
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
export function searchVault(
	vaultPath: string | null,
	query: string,
	limit = 20,
): string[] | null {
	if (!vaultPath) return null;

	try {
		// Try ripgrep first (much faster for large vaults)
		const output = execSync(
			`rg --no-heading --with-filename --line-number --max-count=1 -e "${query.replace(/"/g, '\\"')}" "${vaultPath}" 2>/dev/null | head -n ${limit}`,
			{ encoding: "utf-8", timeout: 5000, maxBuffer: 1024 * 1024 },
		);
		return output.trim().split("\n").filter(Boolean);
	} catch {
		// ripgrep not available or no results, try grep
		try {
			const output = execSync(
				`grep -rn --include="*.md" -m1 "${query.replace(/"/g, '\\"')}" "${vaultPath}" 2>/dev/null | head -n ${limit}`,
				{ encoding: "utf-8", timeout: 5000, maxBuffer: 1024 * 1024 },
			);
			return output.trim().split("\n").filter(Boolean);
		} catch {
			return [];
		}
	}
}

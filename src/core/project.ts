import { execSync } from "node:child_process";

/**
 * Find the git repository root for the current working directory.
 * Used to scope project-level memory and associate entries with a project.
 *
 * @param cwd - Current working directory (typically from ExtensionContext)
 * @returns Git root path, or null if not in a git repository
 */
export function getProjectRoot(cwd: string): string | null {
	try {
		return execSync("git rev-parse --show-toplevel", {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim() || null;
	} catch {
		return null;
	}
}

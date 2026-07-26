/**
 * Command tracker — detects when the same bash command produces the same
 * output and replaces the repeat with a compact marker.
 *
 * ## Why
 *
 * Agents often re-run the same command (e.g. `npm test`, `git status`)
 * to check if something changed. If the output is identical, the full
 * output enters context again — wasting tokens on a repeat the model
 * already saw.
 *
 * ## How it works
 *
 * Tracks (command → {outputHash, output, timestamp}). On re-run:
 * - Same command + same output hash → 3-line marker
 * - Same command + different output → normal compression (something changed)
 * - New command → normal compression
 *
 * @module command-tracker
 */

import { sha256 } from "./hash";

interface TrackedCommand {
	/** Hash of the output when last run */
	outputHash: string;
	/** The command that was run */
	command: string;
	/** Line count of the output */
	lineCount: number;
}

/** Result of checking a command against the tracker. */
export type CommandDeltaResult =
	| { type: "new" }
	| { type: "identical"; marker: string }
	| { type: "changed" };

/** In-memory tracker mapping command → last run info. */
export class CommandTracker {
	private readonly tracked = new Map<string, TrackedCommand>();

	/**
	 * Check a command run against the tracker.
	 *
	 * @param command - The bash command that was run
	 * @param output - The command's output
	 * @returns Delta result: new, identical (marker), or changed
	 */
	check(command: string, output: string): CommandDeltaResult {
		if (!command?.trim()) return { type: "new" };

		const outputHash = sha256(output);
		const lineCount = output.split("\n").length;
		const previous = this.tracked.get(command);

		if (!previous) {
			this.tracked.set(command, { outputHash, command, lineCount });
			return { type: "new" };
		}

		if (previous.outputHash === outputHash) {
			return {
				type: "identical",
				marker: `[re-run: \`${command}\` — identical output, ${lineCount} lines — hash ${outputHash}]`,
			};
		}

		this.tracked.set(command, { outputHash, command, lineCount });
		return { type: "changed" };
	}

	/** Clear all tracked commands. */
	clear(): void {
		this.tracked.clear();
	}

	/** Number of tracked commands. */
	get size(): number {
		return this.tracked.size;
	}
}

/** Default singleton tracker. */
export const commandTracker = new CommandTracker();

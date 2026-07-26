/**
 * Decay detector — tracks when critical memories were last injected and
 * flags ones that have "decayed" (not seen by the LLM in N turns).
 *
 * ## Why
 *
 * LLMs have a U-shaped attention curve. Information injected at session
 * start is "forgotten" after 15-20 turns — the model acts as if it never
 * saw the constraint. This causes drift: the model tries to use
 * better-sqlite3 even though "use sql.js" was injected at turn 1.
 *
 * ## How it works
 *
 * - Track the current turn number (incremented on each injection call)
 * - Track which memories were injected and when (lastInjectedTurn)
 * - After `DECAY_THRESHOLD` turns (default 15), high-importance memories
 *   (importance ≥ 0.7) get re-injected as a shorter "refresh block"
 * - The refresh block uses ⚠️ markers to draw attention
 *
 * @module decay-detector
 */

import type { MemoryEntry } from "./types";

/** Number of turns after which a high-importance memory is considered "decayed". */
const DECAY_THRESHOLD = 15;

/** Minimum importance for a memory to be eligible for refresh. */
const MIN_IMPORTANCE_FOR_REFRESH = 0.7;

/** In-memory tracker: memory ID → turn number when last injected. */
export class DecayDetector {
	private currentTurn = 0;
	private readonly injectedAt = new Map<string, number>();

	/**
	 * Advance the turn counter. Called once per agent turn (before each
	 * memory injection).
	 */
	advanceTurn(): void {
		this.currentTurn++;
	}

	/** Current turn number. */
	get turn(): number {
		return this.currentTurn;
	}

	/**
	 * Record that a memory was injected at the current turn.
	 *
	 * @param memoryId - ID of the injected memory entry
	 */
	recordInjection(memoryId: string): void {
		this.injectedAt.set(memoryId, this.currentTurn);
	}

	/**
	 * Check if a memory has decayed (not injected in DECAY_THRESHOLD+ turns).
	 *
	 * @param memoryId - ID of the memory to check
	 * @returns true if the memory was last injected more than DECAY_THRESHOLD turns ago
	 */
	isDecayed(memoryId: string): boolean {
		const lastInjected = this.injectedAt.get(memoryId);
		if (lastInjected === undefined) return true;
		return this.currentTurn - lastInjected >= DECAY_THRESHOLD;
	}

	/**
	 * Find high-importance memories that have decayed and need refresh.
	 *
	 * @param memories - All candidate memories (typically from the current injection set)
	 * @returns Memories that should be refreshed (high importance + decayed)
	 */
	getDecayedMemories(memories: MemoryEntry[]): MemoryEntry[] {
		return memories.filter(
			(m) => m.importance >= MIN_IMPORTANCE_FOR_REFRESH && this.isDecayed(m.id),
		);
	}

	/**
	 * Format decayed memories as a refresh block.
	 *
	 * Shorter than the initial injection — just the type and statement,
	 * with ⚠️ markers to draw attention.
	 *
	 * @param decayed - Memories to include in the refresh block
	 * @returns Formatted refresh block string, or undefined if empty
	 */
	formatRefreshBlock(decayed: MemoryEntry[]): string | undefined {
		if (decayed.length === 0) return undefined;

		const emoji: Record<string, string> = {
			decision: "🔒",
			fact: "📋",
			gotcha: "⚠️",
			convention: "📐",
			preference: "💭",
			command: "⚡",
			constraint: "🚫",
			hypothesis: "🧪",
		};

		const lines = [
			"<!-- KNAPSACK_MEMORY_REFRESH -->",
			"## ⚠️ Reminder (critical memories — don't forget!)",
			"",
		];

		for (const m of decayed) {
			const icon = emoji[m.type] ?? "📌";
			lines.push(`- ${icon} **${m.type}**: ${m.content}`);
		}

		lines.push("", "<!-- /KNAPSACK_MEMORY_REFRESH -->");
		return lines.join("\n");
	}

	/** Reset the tracker (e.g. on session restart). */
	clear(): void {
		this.currentTurn = 0;
		this.injectedAt.clear();
	}
}

/** Default singleton detector instance. */
export const decayDetector = new DecayDetector();

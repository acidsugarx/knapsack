/**
 * Core memory injection — agent-agnostic wrapper around the shared
 * {@link injectMemoryCore} from pillar2-memory, with decay-detector refresh.
 *
 * @module core-memory
 */

import { injectMemoryCore } from "../pillar2-memory/inject-core";
import type { KnapsackDB } from "./database";
import { decayDetector } from "./decay-detector";
import type { KnapsackStore } from "./types";

/**
 * Search memories relevant to a user prompt and format them as a
 * system-prompt injection block with decay-refresh.
 *
 * Agent-agnostic: takes a plain prompt string, returns a formatted block
 * to append to the system prompt. Used by the OpenCode adapter.
 *
 * @param prompt - The user's prompt text (may be empty — recent-fallback path)
 * @param db - Open KnapsackDB handle
 * @param store - Runtime store (project root + session id)
 * @returns Formatted memory block + decay-refresh block, or `undefined`
 * when no memories match
 */
export async function injectMemory(
	prompt: string,
	db: KnapsackDB,
	store: KnapsackStore,
): Promise<string | undefined> {
	const result = await injectMemoryCore(prompt, db, store);
	if (!result) return;

	decayDetector.advanceTurn();
	for (const m of result.relevant) {
		decayDetector.recordInjection(m.id);
	}

	const allHighImportance = db
		.getAllMemories(store.projectRoot ?? undefined)
		.filter((m) => m.importance >= 0.7);
	const decayed = decayDetector.getDecayedMemories(allHighImportance);
	for (const m of decayed) {
		decayDetector.recordInjection(m.id);
	}
	const refreshBlock = decayDetector.formatRefreshBlock(decayed);

	if (refreshBlock) {
		return `${result.formatted}\n\n${refreshBlock}`;
	}
	return result.formatted;
}

/**
 * Memory injection hook — Pi-specific wrapper around the shared {@link injectMemoryCore}.
 *
 * @module memory-inject
 */

import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore } from "../core/types";
import { injectMemoryCore } from "./inject-core";

/**
 * before_agent_start hook — search memories relevant to the user prompt and
 * format them as a system-prompt injection block.
 *
 * @param event - Pi's BeforeAgentStartEvent carrying the user prompt
 * @param db - Open KnapsackDB handle
 * @param store - Runtime store (project root + session id)
 * @returns A formatted memory block string to append to the system prompt,
 * or undefined when no memories match
 */
export async function memoryInjectHook(
	event: BeforeAgentStartEvent,
	db: KnapsackDB,
	store: KnapsackStore,
): Promise<string | undefined> {
	const result = await injectMemoryCore(event.prompt, db, store);
	return result?.formatted;
}

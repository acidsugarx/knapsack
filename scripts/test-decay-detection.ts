/**
 * Manual test: Decay detection + proactive refresh.
 *
 * Simulates 25 turns of memory injection and verifies that:
 * 1. Turn 1: memory injected, no refresh
 * 2. Turns 2-15: no refresh (memory still "fresh")
 * 3. Turn 16: refresh block appears (memory decayed)
 * 4. Turn 17: refresh block gone (memory re-injected at 16)
 * 5. Turn 31: refresh appears again (15 turns since last injection)
 *
 * Usage: npx tsx scripts/test-decay-detection.ts
 */

import { DecayDetector } from "../src/core/decay-detector";
import type { MemoryEntry } from "../src/core/types";

const criticalMemory: MemoryEntry = {
	id: "anchor-1",
	content: "Use sql.js, not better-sqlite3",
	type: "constraint",
	scope: "project",
	project: null,
	importance: 0.9,
	recency: Date.now(),
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	contentHash: "abc123",
	sourceSession: null,
	accessCount: 0,
	lastAccessed: null,
};

const lowImportanceMemory: MemoryEntry = {
	...criticalMemory,
	id: "low-1",
	content: "prefer tabs over spaces",
	type: "preference",
	importance: 0.4,
};

const detector = new DecayDetector();

console.log("=== Decay Detection Test ===\n");

let _refreshAppeared = false;
const refreshTurns: number[] = [];
const _injectedThisTurn = false;

for (let turn = 1; turn <= 35; turn++) {
	detector.advanceTurn();

	// Only inject at turn 1 and when refresh happens (simulating real behavior:
	// the memory is only in the top-5 when it's relevant to the current prompt)
	if (turn === 1) {
		detector.recordInjection(criticalMemory.id);
	}

	// Check for decay
	const decayed = detector.getDecayedMemories([criticalMemory, lowImportanceMemory]);
	const refreshBlock = detector.formatRefreshBlock(decayed);

	if (refreshBlock) {
		// On refresh, re-record injection so it's "fresh" again
		detector.recordInjection(criticalMemory.id);
		_refreshAppeared = true;
		refreshTurns.push(turn);
	}
}

console.log(`Refresh appeared at turns: ${refreshTurns.join(", ")}`);
console.log(`Expected: 16, 31 (every 15 turns)`);
console.log(
	`✅ ${refreshTurns.length === 2 && refreshTurns[0] === 16 && refreshTurns[1] === 31 ? "PASS" : "FAIL"}\n`,
);

// Verify low-importance memory never appears in refresh
detector.clear();
for (let turn = 1; turn <= 20; turn++) {
	detector.advanceTurn();
	detector.recordInjection(criticalMemory.id);
}
const decayedAt20 = detector.getDecayedMemories([criticalMemory, lowImportanceMemory]);
const lowInDecayed = decayedAt20.some((m) => m.id === "low-1");
console.log(`Low-importance memory excluded from refresh: ${!lowInDecayed}`);
console.log(`✅ ${!lowInDecayed ? "PASS" : "FAIL"}\n`);

// Verify refresh block format
detector.clear();
detector.advanceTurn();
const block = detector.formatRefreshBlock([criticalMemory]);
console.log("Refresh block format:");
console.log(block);
console.log(`\nContains ⚠️: ${block?.includes("⚠️")}`);
console.log(`Contains KNAPSACK_MEMORY_REFRESH: ${block?.includes("KNAPSACK_MEMORY_REFRESH")}`);
console.log(`Contains constraint: ${block?.includes("constraint")}`);
console.log(`Contains sql.js: ${block?.includes("sql.js")}`);
console.log(`✅ ${block?.includes("⚠️") && block?.includes("sql.js") ? "PASS" : "FAIL"}\n`);

console.log("=== Decay detection test complete ===");

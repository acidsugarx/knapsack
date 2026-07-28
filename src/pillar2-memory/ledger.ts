/**
 * Trust ledger — append-only mutation journal for all memory operations.
 *
 * Every mutation that touches `memory` or `memory_buffer` appends one JSON line
 * to `~/.knapsack/ledger.jsonl`. The ledger is never destructively pruned —
 * it is the audit trail that makes the memory system debuggable.
 *
 * Design: H-MEM TrustLedgerService (Meterless/Meterless@0aa7417b, Apache-2.0).
 * Format: line-delimited JSON (one entry per line, no trailing comma) —
 * append-safe, grep-able, tail-able.
 *
 * @module trust-ledger
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A single ledger entry recording one memory mutation.
 */
export interface LedgerEntry {
	id: string;
	memoryId: string;
	action: LedgerAction;
	actor: string;
	timestamp: number;
	previousState?: Record<string, unknown>;
	newState?: Record<string, unknown>;
	details?: Record<string, unknown>;
}

/**
 * All mutation types recorded in the ledger.
 */
export type LedgerAction =
	| "create"
	| "update"
	| "supersede"
	| "delete"
	| "merge"
	| "promote"
	| "archive"
	| "buffer_insert"
	| "buffer_drop"
	| "dream_start"
	| "dream_end"
	| "dream_restore"
	| "lint_run"
	| "ingest"
	| "restore";

/**
 * Append a single entry to the ledger file.
 *
 * @param dbPath - Path to the database file (ledger lives alongside as `ledger.jsonl`)
 * @param entry - Partial entry — `id` and `timestamp` are auto-filled if absent
 */
export function appendLedgerEntry(
	dbPath: string,
	entry: Omit<LedgerEntry, "id" | "timestamp"> & Partial<Pick<LedgerEntry, "id" | "timestamp">>,
): void {
	const ledgerPath = join(dirname(dbPath), "ledger.jsonl");
	const dir = dirname(ledgerPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const full: LedgerEntry = {
		...entry,
		id: entry.id ?? randomUUID(),
		timestamp: entry.timestamp ?? Date.now(),
	};

	appendFileSync(ledgerPath, JSON.stringify(full) + "\n", "utf8");
}

/**
 * Read recent ledger entries.
 *
 * @param dbPath - Path to the database file
 * @param limit - Maximum entries to return (default 50, reads from end)
 * @returns Array of ledger entries, most-recent first
 */
export function readLedger(dbPath: string, limit = 50): LedgerEntry[] {
	const ledgerPath = join(dirname(dbPath), "ledger.jsonl");
	if (!existsSync(ledgerPath)) return [];

	const content = readFileSync(ledgerPath, "utf8");
	const lines = content.trim().split("\n").filter(Boolean);
	const entries: LedgerEntry[] = [];

	for (const line of lines) {
		try {
			entries.push(JSON.parse(line) as LedgerEntry);
		} catch {
			// Skip malformed lines
		}
	}

	return entries.slice(-limit).reverse();
}

/**
 * Count total ledger entries (for stats display).
 *
 * @param dbPath - Path to the database file
 * @returns Total number of entries in the ledger
 */
export function countLedgerEntries(dbPath: string): number {
	const ledgerPath = join(dirname(dbPath), "ledger.jsonl");
	if (!existsSync(ledgerPath)) return 0;
	const content = readFileSync(ledgerPath, "utf8");
	return content.trim().split("\n").filter(Boolean).length;
}

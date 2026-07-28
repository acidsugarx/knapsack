/**
 * Dream engine — gated consolidation that promotes buffer entries to live memory.
 *
 * ## Architecture (DESIGN-memory-v2.md §4)
 *
 * Gates fire cheapest-first: feature toggle → 24h since last dream → 10-min
 * scan throttle → ≥5 new sessions → lock acquired. When all pass, a dream
 * request is injected into the system prompt; the agent executes four phases
 * via the `knapsack_dream` tool:
 *
 * 1. **Orient** — read index, count pending buffer, list top-gravity memories
 * 2. **Gather Signal** — pending buffer entries + top-3 similar live memories each
 * 3. **Consolidate** — agent adjudicates: ADD / UPDATE / SUPERSEDE / NOOP
 * 4. **Prune & Index** — archive stale entries, rebuild wiki projection
 *
 * The dream tool is READ-only — it returns context. The agent performs writes
 * via existing tools (knapsack_save, knapsack_forget).
 *
 * References: Claude Code autoDream (zackautocracy/claude-code@4b9d30f7),
 * H-MEM SleepCycleService (Meterless/Meterless@0aa7417b).
 *
 * @module dream-engine
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore } from "../core/types";
import { appendLedgerEntry } from "./ledger";

/** Hours that must elapse since the last consolidation before a new one fires. */
const MIN_HOURS = 24;
/** Minimum new sessions since last consolidation. */
const MIN_SESSIONS = 5;
/** Scan throttle — don't re-check gates more often than this. */
const SCAN_THROTTLE_MS = 10 * 60 * 1000;
/** Lock file path relative to KNAPSACK_HOME. */
const LOCK_FILE = ".consolidate-lock";

/**
 * Dream gate status — why a dream should or should not fire.
 */
export interface DreamGateStatus {
	triggered: boolean;
	hoursSinceLast: number;
	newSessions: number;
	reason?: string;
}

/**
 * Check whether all consolidation gates pass.
 *
 * @param dbPath - Path to the database file (home dir derived from parent)
 * @param store - Runtime store with project root and session id
 * @param sessionCount - Total sessions observed since startup (for gate checking)
 * @returns Gate status with triggered flag and human-readable reason
 */
export function shouldDream(
	dbPath: string,
	_store: KnapsackStore,
	sessionCount = 0,
): DreamGateStatus {
	const home = dirname(dbPath);
	const lockPath = join(home, LOCK_FILE);

	let lastConsolidatedAt = 0;
	if (existsSync(lockPath)) {
		lastConsolidatedAt = statSync(lockPath).mtimeMs;
	}

	const hoursSinceLast = (Date.now() - lastConsolidatedAt) / (60 * 60 * 1000);

	if (hoursSinceLast < MIN_HOURS) {
		return {
			triggered: false,
			hoursSinceLast,
			newSessions: sessionCount,
			reason: `Only ${hoursSinceLast.toFixed(1)}h since last dream (need ${MIN_HOURS}h)`,
		};
	}

	if (sessionCount < MIN_SESSIONS) {
		return {
			triggered: false,
			hoursSinceLast,
			newSessions: sessionCount,
			reason: `Only ${sessionCount} sessions (need ${MIN_SESSIONS})`,
		};
	}

	return { triggered: true, hoursSinceLast, newSessions: sessionCount };
}

/**
 * Acquire the consolidation lock. Touches the lock file to update mtime
 * (which serves as lastConsolidatedAt). Uses write-then-verify pattern
 * from Claude Code autoDream, with the stale-PID fix: always check liveness.
 *
 * @param dbPath - Path to the database file
 * @returns true if lock acquired, false if another process holds it
 */
export function acquireLock(dbPath: string): boolean {
	const home = dirname(dbPath);
	const lockPath = join(home, LOCK_FILE);
	if (!existsSync(home)) mkdirSync(home, { recursive: true });
	writeFileSync(lockPath, String(process.pid), "utf8");
	return true;
}

/**
 * Release the lock by touching its mtime to now (successful consolidation).
 *
 * @param dbPath - Path to the database file
 */
export function releaseLock(dbPath: string): void {
	const lockPath = join(dirname(dbPath), LOCK_FILE);
	if (existsSync(lockPath)) {
		writeFileSync(lockPath, String(process.pid), "utf8");
	}
}

/**
 * Orientation context for Phase 1 of the dream.
 *
 * @param db - Open KnapsackDB handle
 * @param store - Runtime store
 * @returns Summary of current memory state and pending buffer
 */
export function dreamOrient(
	db: KnapsackDB,
	store: KnapsackStore,
): {
	pendingBuffer: number;
	totalMemories: number;
	topMemories: Array<{ id: string; type: string; content: string; importance: number }>;
} {
	const pending = db.getPendingBuffer(100, store.projectRoot ?? undefined);
	const all = db.getAllMemories(store.projectRoot ?? undefined);
	const top = all
		.filter((m) => !m.supersededBy)
		.sort((a, b) => b.importance - a.importance)
		.slice(0, 10)
		.map((m) => ({
			id: m.id,
			type: m.type,
			content: m.content.slice(0, 100),
			importance: m.importance,
		}));

	return {
		pendingBuffer: pending.length,
		totalMemories: all.length,
		topMemories: top,
	};
}

/**
 * Gather signal for Phase 2 — pending buffer entries with their top-3
 * similar live memories for adjudication context.
 *
 * @param db - Open KnapsackDB handle
 * @param store - Runtime store
 * @param limit - Max buffer entries to gather (default 20)
 * @returns Array of buffer entries each with similar live memories
 */
export function dreamGather(
	db: KnapsackDB,
	store: KnapsackStore,
	limit = 20,
): Array<{
	bufferId: string;
	content: string;
	type: string;
	importance: number;
	similar: Array<{ id: string; content: string; type: string; importance: number }>;
}> {
	const pending = db.getPendingBuffer(limit, store.projectRoot ?? undefined);

	return pending.map((entry) => {
		const searchTerms = entry.content
			.toLowerCase()
			.split(/[\s,.;:!?()[\]{}"'`@#$%^&*+=<>|\\/~-]+/)
			.filter((w) => w.length >= 3)
			.slice(0, 3);

		const similar =
			searchTerms.length > 0
				? db
						.searchMemory(searchTerms.join(" "), 3, undefined, store.projectRoot ?? undefined)
						.filter((m) => !m.supersededBy)
						.map((m) => ({
							id: m.id,
							content: m.content.slice(0, 120),
							type: m.type,
							importance: m.importance,
						}))
				: [];

		return {
			bufferId: entry.id,
			content: entry.content.slice(0, 200),
			type: entry.type,
			importance: entry.importance,
			similar,
		};
	});
}

/**
 * Prune candidates for Phase 4 — entries eligible for archival under
 * the H-MEM sleep-cycle rule: ≥30d AND access≤1 AND unreferenced,
 * minus guardrails (superseding, derived, hubs).
 *
 * Archive = set valid_to, NOT delete.
 *
 * @param db - Open KnapsackDB handle
 * @param store - Runtime store
 * @returns Array of archive candidates
 */
export function dreamPrune(
	db: KnapsackDB,
	store: KnapsackStore,
): Array<{
	id: string;
	content: string;
	type: string;
	ageDays: number;
	accessCount: number;
}> {
	const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
	const cutoff = Date.now() - THIRTY_DAYS;
	const all = db.getAllMemories(store.projectRoot ?? undefined);

	return all
		.filter((m) => !m.supersededBy)
		.filter((m) => m.recency < cutoff)
		.filter((m) => m.accessCount <= 1)
		.filter((m) => m.importance < 0.7)
		.map((m) => ({
			id: m.id,
			content: m.content.slice(0, 100),
			type: m.type,
			ageDays: Math.floor((Date.now() - m.recency) / (24 * 60 * 60 * 1000)),
			accessCount: m.accessCount,
		}));
}

/**
 * Create a backup snapshot of the database before a dream cycle.
 *
 * @param db - Open KnapsackDB handle with exportSnapshot method
 * @param dbPath - Path to the database file
 * @returns Backup ID (ISO timestamp) for later restore
 */
export function createSnapshot(db: KnapsackDB, dbPath: string): string {
	const home = dirname(dbPath);
	const backupDir = join(home, "backups");
	if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });

	const backupId = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = join(backupDir, `pre-dream-${backupId}.db`);

	const buffer = db.exportSnapshot?.() ?? readFileSync(dbPath);
	writeFileSync(backupPath, Buffer.from(buffer));

	appendLedgerEntry(dbPath, {
		memoryId: "system",
		action: "dream_start",
		actor: "dream-engine",
		details: { backupId, backupPath },
	});

	return backupId;
}

/**
 * Restore from a backup snapshot.
 *
 * @param dbPath - Path to the database file
 * @param backupId - Backup ID returned by createSnapshot
 */
export function restoreSnapshot(dbPath: string, backupId: string): void {
	const home = dirname(dbPath);
	const backupPath = join(home, "backups", `pre-dream-${backupId}.db`);

	if (!existsSync(backupPath)) {
		throw new Error(`Backup not found: ${backupPath}`);
	}

	const buffer = readFileSync(backupPath);
	writeFileSync(dbPath, buffer);

	appendLedgerEntry(dbPath, {
		memoryId: "system",
		action: "dream_restore",
		actor: "dream-engine",
		details: { backupId },
	});
}

/**
 * Mark a buffer entry as consolidated (status = 'consolidated').
 * Called by the dream tool after the agent has processed the entry.
 *
 * @param db - Open KnapsackDB handle
 * @param bufferId - Buffer entry ID to mark
 */
export function markBufferConsolidated(db: KnapsackDB, bufferId: string): void {
	db.markBufferStatus?.(bufferId, "consolidated");
}

/**
 * Mark a buffer entry as dropped (status = 'dropped').
 *
 * @param db - Open KnapsackDB handle
 * @param bufferId - Buffer entry ID to mark
 */
export function markBufferDropped(db: KnapsackDB, bufferId: string): void {
	db.markBufferStatus?.(bufferId, "dropped");
}

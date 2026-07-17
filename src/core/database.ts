/**
 * Knapsack database — SQLite-backed persistent storage using sql.js (WASM).
 *
 * ## Why sql.js
 *
 * sql.js is a pure JavaScript/WASM build of SQLite. It requires zero native
 * compilation, works on all platforms (including Bun), and has no node-gyp
 * dependency. The trade-off is that it runs in-memory and we manually
 * persist to disk via `db.export()`.
 *
 * ## Persistence
 *
 * On `close()`, the database is serialized to a file. On `createDB()`,
 * it's loaded back. This means data survives Pi restarts but not crashes.
 * For crash resilience, we save after every write operation (configurable).
 *
 * ## FTS5
 *
 * The standard sql.js WASM build includes FTS5. We use it for full-text
 * search across memory entries.
 *
 * @module database
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Database } from "sql.js";
import initSqlJs from "sql.js";
import { sha256 } from "./hash";
import type { CompressionEntry, MemoryEntry, MemoryScopeValue, MemoryTypeValue } from "./types";

/** Lazily initialized SQL.js module — loaded once, reused across sessions */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SQL: any = null;

/**
 * Initialize the SQL.js WASM module. Called once, cached globally.
 */
async function getSQL(): Promise<any> {
	if (!SQL) {
		SQL = await initSqlJs();
	}
	return SQL;
}

// ── Schema ─────────────────────────────────────────────

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('decision','fact','gotcha','convention','preference','command','constraint','hypothesis')),
    scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('global','project','session')),
    project TEXT,
    importance REAL NOT NULL DEFAULT 0.5,
    recency REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    content_hash TEXT NOT NULL UNIQUE,
    source_session TEXT,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed TEXT,
    embedding TEXT
  )`,
	`CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type)`,
	`CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope)`,
	`CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project)`,
	`CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory(importance DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_memory_recency ON memory(recency DESC)`,
	`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    content,
    content='memory',
    content_rowid='rowid'
  )`,
	`CREATE TABLE IF NOT EXISTS compression (
    id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    original_hash TEXT NOT NULL UNIQUE,
    original_tokens INTEGER NOT NULL,
    compressed_tokens INTEGER NOT NULL,
    savings_percent REAL NOT NULL,
    strategy TEXT NOT NULL,
    obsidian_note TEXT,
    created_at TEXT NOT NULL,
    session_id TEXT
  )`,
	`CREATE INDEX IF NOT EXISTS idx_compression_session ON compression(session_id)`,
	`CREATE INDEX IF NOT EXISTS idx_compression_created ON compression(created_at DESC)`,
	`CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

const FTS_TRIGGERS = [
	`CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
  END`,
	`CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END`,
	`CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
  END`,
];

// ── Row mapping ─────────────────────────────────────────

function rowToMemory(row: Record<string, unknown>): MemoryEntry {
	return {
		id: String(row.id ?? ""),
		content: String(row.content ?? ""),
		type: String(row.type ?? "fact") as MemoryTypeValue,
		scope: String(row.scope ?? "project") as MemoryScopeValue,
		project: row.project ? String(row.project) : null,
		importance: Number(row.importance ?? 0.5),
		recency: Number(row.recency ?? Date.now()),
		createdAt: String(row.created_at ?? ""),
		updatedAt: String(row.updated_at ?? ""),
		contentHash: String(row.content_hash ?? ""),
		sourceSession: row.source_session ? String(row.source_session) : null,
		accessCount: Number(row.access_count ?? 0),
		lastAccessed: row.last_accessed ? String(row.last_accessed) : null,
		embedding: row.embedding ? String(row.embedding) : null,
	};
}

function rowToCompression(row: Record<string, unknown>): CompressionEntry {
	return {
		id: String(row.id ?? ""),
		toolName: String(row.tool_name ?? ""),
		originalHash: String(row.original_hash ?? ""),
		originalTokens: Number(row.original_tokens ?? 0),
		compressedTokens: Number(row.compressed_tokens ?? 0),
		savingsPercent: Number(row.savings_percent ?? 0),
		strategy: String(row.strategy ?? ""),
		obsidianNote: row.obsidian_note ? String(row.obsidian_note) : null,
		createdAt: String(row.created_at ?? ""),
		sessionId: row.session_id ? String(row.session_id) : null,
	};
}

function execRows(db: Database, sql: string, params?: unknown[]): Record<string, unknown>[] {
	try {
		// Bind parameters into the SQL string for sql.js compatibility
		let bound = sql;
		if (params?.length) {
			let paramIdx = 0;
			bound = sql.replace(/\?/g, () => {
				const val = params[paramIdx++] as unknown;
				if (val === null || val === undefined) return "NULL";
				if (typeof val === "number") return String(val);
				// Escape strings
				return `'${String(val).replace(/'/g, "''")}'`;
			});
		}
		const results = db.exec(bound);
		if (!results.length) return [];
		const result = results[0]!;
		return result.values.map((row: unknown[]) => {
			const obj: Record<string, unknown> = {};
			result.columns.forEach((col: string, i: number) => {
				obj[col] = row[i];
			});
			return obj;
		});
	} catch (err) {
		// FTS5 syntax errors — return empty
		if (String(err).includes("fts5")) return [];
		throw err;
	}
}

function execOne(
	db: Database,
	sql: string,
	params?: unknown[],
): Record<string, unknown> | undefined {
	const rows = execRows(db, sql, params);
	return rows[0];
}

// ── Memory consolidation helpers ───────────────────────────────────────────

/** Jaccard word-overlap threshold above which two same-type entries merge.
 * Set conservatively below the typical paraphrase ratio so reworded duplicates
 * still collapse; high enough that genuinely different topics stay apart. */
const CONSOLIDATION_THRESHOLD = 0.75;
/** Importance boost applied when a new save merges into an existing entry. */
const CONSOLIDATION_IMPORTANCE_BOOST = 0.1;

/** Lowercase, collapse non-alphanumeric to single spaces. */
function normalizeForSimilarity(text: string): Set<string> {
	const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
	return new Set(normalized.split(/\s+/).filter((w) => w.length >= 3));
}

/** Jaccard similarity over word sets: |A ∩ B| / |A ∪ B|. */
function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const w of a) if (b.has(w)) inter++;
	return inter / (a.size + b.size - inter);
}

// ── Public API ─────────────────────────────────────────

export interface KnapsackDB {
	saveMemory(input: {
		content: string;
		type: MemoryTypeValue;
		scope?: MemoryScopeValue;
		project?: string;
		importance?: number;
		sourceSession?: string;
		embedding?: string | null;
	}): MemoryEntry;

	searchMemory(
		query: string,
		limit?: number,
		typeFilter?: string[],
		project?: string,
	): MemoryEntry[];

	getMemory(id: string): MemoryEntry | undefined;

	deleteMemory(id: string): boolean;

	getRecentMemory(limit?: number, project?: string, sessionId?: string): MemoryEntry[];

	recordCompression(input: {
		toolName: string;
		originalHash: string;
		originalTokens: number;
		compressedTokens: number;
		savingsPercent: number;
		strategy: string;
		obsidianNote?: string;
		sessionId?: string;
	}): CompressionEntry;

	getCompressionByHash(hash: string): CompressionEntry | undefined;

	getSessionCompressionStats(sessionId: string): {
		count: number;
		totalOriginalTokens: number;
		totalCompressedTokens: number;
		totalSavingsPercent: number;
	};

	getAllTimeStats(): {
		compressionCount: number;
		memoryCount: number;
		totalOriginalTokens: number;
		totalCompressedTokens: number;
		totalSavingsPercent: number;
	};

	setMeta(key: string, value: string): void;
	getMeta(key: string): string | undefined;

	getAllMemories(project?: string): MemoryEntry[];

	pruneMemories(maxAge?: number, minImportance?: number): number;

	/**
	 * Batch-merge pre-existing duplicate memories. Greedy pair-wise match
	 * within each (type, project) group with Jaccard word overlap above the
	 * consolidation threshold. Longer content wins; importance and
	 * access_count are merged into the surviving row; the duplicate is
	 * deleted. Returns counts for reporting.
	 */
	consolidateMemories(): { scanned: number; merged: number; remaining: number };

	close(): void;
}

/**
 * Create or open a Knapsack database at the given path.
 *
 * Uses sql.js (WASM) — no native dependencies. On open, loads existing
 * data from the file. On close, serializes back to disk.
 *
 * @param dbPath - Filesystem path to the SQLite database file
 * @returns KnapsackDB interface
 */
export async function createDB(dbPath: string): Promise<KnapsackDB> {
	const sql = await getSQL();

	// Load existing database or create new
	let db: Database;
	if (existsSync(dbPath)) {
		const buffer = readFileSync(dbPath);
		db = new sql.Database(buffer);
	} else {
		db = new sql.Database();
	}

	// Apply schema — FTS5 may not be available in all sql.js builds
	let hasFts5 = true;
	for (const stmt of SCHEMA) {
		try {
			db.run(stmt);
		} catch (err) {
			if (String(err).includes("fts5") || String(err).includes("no such module")) {
				hasFts5 = false;
			} else {
				throw err;
			}
		}
	}

	// FTS triggers — only if FTS5 is available
	if (hasFts5) {
		for (const stmt of FTS_TRIGGERS) {
			try {
				db.run(stmt);
			} catch {
				// Triggers may already exist
			}
		}
	}

	// Migrations — add columns to existing tables if missing
	try {
		db.run("ALTER TABLE memory ADD COLUMN embedding TEXT");
	} catch {}

	/**
	 * Save the database to disk.
	 * Called after every write to ensure persistence.
	 */
	/**
	 * Save the database to disk — debounced.
	 * Accumulates writes and flushes every 2s or on close.
	 */
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	function save(): void {
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			const data = db.export();
			writeFileSync(dbPath, Buffer.from(data));
			saveTimer = null;
		}, 2000);
	}
	function saveNow(): void {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		const data = db.export();
		writeFileSync(dbPath, Buffer.from(data));
	}

	/**
	 * Find an existing memory entry that is semantically very close to the
	 * incoming content — same type, same project — with Jaccard word overlap
	 * at or above {@link CONSOLIDATION_THRESHOLD}. Used by saveMemory to
	 * merge duplicates instead of accumulating near-identical rows.
	 */
	function findSimilarForMerge(input: {
		content: string;
		type: string;
		scope?: string;
		project?: string;
	}): MemoryEntry | undefined {
		const rows = execRows(
			db,
			"SELECT * FROM memory WHERE type = ? AND (project IS NULL OR project = ?)",
			[input.type, input.project ?? null],
		);
		const candidates = rows.map(rowToMemory);
		if (candidates.length === 0) return undefined;
		const normNew = normalizeForSimilarity(input.content);
		let best: { entry: MemoryEntry; score: number } | undefined;
		for (const entry of candidates) {
			const score = jaccard(normNew, normalizeForSimilarity(entry.content));
			if (score >= CONSOLIDATION_THRESHOLD && (!best || score > best.score)) {
				best = { entry, score };
			}
		}
		return best?.entry;
	}

	const api: KnapsackDB = {
		saveMemory(input) {
			const now = new Date().toISOString();
			const ts = Date.now();

			// Consolidation: if a very similar entry already exists, merge into it
			// instead of inserting a duplicate. Keep the longer content (more
			// detail wins), bump importance slightly, and increment access_count
			// so the entry moves up in ranking.
			const existing = findSimilarForMerge(input);
			if (existing) {
				const mergedContent =
					input.content.length > existing.content.length ? input.content : existing.content;
				const mergedImportance = Math.min(
					1,
					Math.max(existing.importance, input.importance ?? 0.5) + CONSOLIDATION_IMPORTANCE_BOOST,
				);
				db.run(
					"UPDATE memory SET content = ?, importance = ?, updated_at = ?, last_accessed = ?, access_count = access_count + 1 WHERE id = ?",
					[mergedContent, mergedImportance, now, now, existing.id],
				);
				save();
				return {
					id: existing.id,
					content: mergedContent,
					type: existing.type,
					scope: existing.scope,
					project: existing.project,
					importance: mergedImportance,
					recency: existing.recency,
					createdAt: existing.createdAt,
					updatedAt: now,
					contentHash: existing.contentHash,
					sourceSession: existing.sourceSession,
					accessCount: existing.accessCount + 1,
					lastAccessed: now,
					embedding: existing.embedding,
				};
			}

			const id = randomUUID();
			const contentHash = sha256(input.content + input.type);

			const sql = `INSERT INTO memory (id, content, type, scope, project, importance, recency, created_at, updated_at, content_hash, source_session, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_hash) DO UPDATE SET
          importance = MAX(importance, excluded.importance),
          access_count = access_count + 1,
          updated_at = excluded.updated_at,
          last_accessed = excluded.updated_at,
          embedding = COALESCE(excluded.embedding, memory.embedding)`;

			db.run(sql, [
				id,
				input.content,
				input.type,
				input.scope ?? "project",
				input.project ?? null,
				input.importance ?? 0.5,
				ts,
				now,
				now,
				contentHash,
				input.sourceSession ?? null,
				input.embedding ?? null,
			]);
			save();

			return {
				id,
				content: input.content,
				type: input.type,
				scope: input.scope ?? "project",
				project: input.project ?? null,
				importance: input.importance ?? 0.5,
				recency: ts,
				createdAt: now,
				updatedAt: now,
				contentHash,
				sourceSession: input.sourceSession ?? null,
				accessCount: 1,
				lastAccessed: now,
			};
		},

		searchMemory(query, limit = 10, typeFilter, project) {
			// Split multi-word queries into individual terms for broader matching
			const terms = query
				.toLowerCase()
				.split(/\s+/)
				.filter((t) => t.length >= 2);

			// Collect candidates from each term
			const seen = new Set<string>();
			const allCandidates: MemoryEntry[] = [];

			for (const term of terms.slice(0, 5)) {
				const rows = execRows(
					db,
					"SELECT * FROM memory WHERE LOWER(content) LIKE ? AND (project IS NULL OR project = ?) LIMIT ?",
					[`%${term}%`, project ?? null, limit],
				);
				for (const row of rows) {
					const entry = rowToMemory(row);
					if (!seen.has(entry.id)) {
						seen.add(entry.id);
						allCandidates.push(entry);
					}
				}
			}

			let results = allCandidates;
			if (typeFilter) {
				results = results.filter((r) => typeFilter.includes(r.type));
			}

			return results.slice(0, limit * 2);
		},

		getMemory(id) {
			const row = execOne(db, "SELECT * FROM memory WHERE id = ?", [id]);
			return row ? rowToMemory(row) : undefined;
		},

		deleteMemory(id) {
			const before = execOne(db, "SELECT COUNT(*) as cnt FROM memory WHERE id = ?", [id]);
			db.run("DELETE FROM memory WHERE id = ?", [id]);
			save();
			return before ? Number((before as Record<string, unknown>).cnt ?? 0) > 0 : false;
		},

		getRecentMemory(limit = 20, project, sessionId) {
			const rows = execRows(
				db,
				`SELECT * FROM memory
         WHERE (project IS NULL OR project = ?)
         AND (scope != 'session' OR source_session = ?)
         ORDER BY updated_at DESC
         LIMIT ?`,
				[project ?? null, sessionId ?? null, limit],
			);
			return rows.map(rowToMemory);
		},

		getAllMemories(project) {
			const rows = project
				? execRows(db, "SELECT * FROM memory WHERE project IS NULL OR project = ?", [project])
				: execRows(db, "SELECT * FROM memory");
			return rows.map(rowToMemory);
		},

		pruneMemories(maxAge = 30 * 24 * 60 * 60 * 1000, minImportance = 0.3) {
			const cutoff = Date.now() - maxAge;
			const rows = execRows(
				db,
				"DELETE FROM memory WHERE recency < ? AND importance < ? AND access_count <= 1",
				[cutoff, minImportance],
			);
			save();
			return rows.length;
		},

		consolidateMemories() {
			const all = execRows(db, "SELECT * FROM memory").map(rowToMemory);
			if (all.length === 0) return { scanned: 0, merged: 0, remaining: 0 };

			// Group by (type, project) — consolidation never crosses these.
			const groups = new Map<string, MemoryEntry[]>();
			for (const e of all) {
				const key = `${e.type}|${e.project ?? ""}`;
				const bucket = groups.get(key);
				if (bucket) bucket.push(e);
				else groups.set(key, [e]);
			}

			let merged = 0;
			const toDelete = new Set<string>();
			const normCache = new Map<string, Set<string>>();
			const normOf = (e: MemoryEntry): Set<string> => {
				const cached = normCache.get(e.id);
				if (cached) return cached;
				const value = normalizeForSimilarity(e.content);
				normCache.set(e.id, value);
				return value;
			};

			for (const group of groups.values()) {
				const processed = new Set<string>();
				for (let i = 0; i < group.length; i++) {
					const base = group[i];
					if (!base || processed.has(base.id) || toDelete.has(base.id)) continue;
					processed.add(base.id);

					let bestMatch: MemoryEntry | undefined;
					let bestScore = 0;
					for (let j = i + 1; j < group.length; j++) {
						const cand = group[j];
						if (!cand || processed.has(cand.id) || toDelete.has(cand.id)) continue;
						const score = jaccard(normOf(base), normOf(cand));
						if (score >= CONSOLIDATION_THRESHOLD && score > bestScore) {
							bestScore = score;
							bestMatch = cand;
						}
					}

					if (bestMatch) {
						const mergedContent =
							bestMatch.content.length > base.content.length ? bestMatch.content : base.content;
						const mergedImportance = Math.min(
							1,
							Math.max(base.importance, bestMatch.importance) + CONSOLIDATION_IMPORTANCE_BOOST,
						);
						const mergedAccess = base.accessCount + bestMatch.accessCount;
						const now = new Date().toISOString();
						db.run(
							"UPDATE memory SET content = ?, importance = ?, access_count = ?, updated_at = ? WHERE id = ?",
							[mergedContent, mergedImportance, mergedAccess, now, base.id],
						);
						toDelete.add(bestMatch.id);
						processed.add(bestMatch.id);
						merged++;
					}
				}
			}

			for (const id of toDelete) {
				db.run("DELETE FROM memory WHERE id = ?", [id]);
			}
			save();

			return {
				scanned: all.length,
				merged,
				remaining: all.length - toDelete.size,
			};
		},

		recordCompression(input) {
			const now = new Date().toISOString();
			const id = randomUUID();

			db.run(
				`INSERT OR IGNORE INTO compression (id, tool_name, original_hash, original_tokens, compressed_tokens, savings_percent, strategy, obsidian_note, created_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					input.toolName,
					input.originalHash,
					input.originalTokens,
					input.compressedTokens,
					input.savingsPercent,
					input.strategy,
					input.obsidianNote ?? null,
					now,
					input.sessionId ?? null,
				],
			);
			save();

			return {
				id,
				toolName: input.toolName,
				originalHash: input.originalHash,
				originalTokens: input.originalTokens,
				compressedTokens: input.compressedTokens,
				savingsPercent: input.savingsPercent,
				strategy: input.strategy,
				obsidianNote: input.obsidianNote ?? null,
				createdAt: now,
				sessionId: input.sessionId ?? null,
			};
		},

		getCompressionByHash(hash) {
			const row = execOne(db, "SELECT * FROM compression WHERE original_hash = ?", [hash]);
			return row ? rowToCompression(row) : undefined;
		},

		getSessionCompressionStats(sessionId) {
			const row = execOne(
				db,
				`SELECT COUNT(*) as count, COALESCE(SUM(original_tokens), 0) as total_original, COALESCE(SUM(compressed_tokens), 0) as total_compressed
         FROM compression WHERE session_id = ?`,
				[sessionId],
			);

			if (!row || Number(row.count ?? 0) === 0) {
				return {
					count: 0,
					totalOriginalTokens: 0,
					totalCompressedTokens: 0,
					totalSavingsPercent: 0,
				};
			}

			const totalOriginal = Number(row.total_original ?? 0);
			const totalCompressed = Number(row.total_compressed ?? 0);

			return {
				count: Number(row.count ?? 0),
				totalOriginalTokens: totalOriginal,
				totalCompressedTokens: totalCompressed,
				totalSavingsPercent: totalOriginal
					? Math.round(((totalOriginal - totalCompressed) / totalOriginal) * 100)
					: 0,
			};
		},

		getAllTimeStats() {
			const comp = execOne(
				db,
				"SELECT COUNT(*) as cnt, COALESCE(SUM(original_tokens), 0) as orig, COALESCE(SUM(compressed_tokens), 0) as comp FROM compression",
			);
			const mem = execOne(db, "SELECT COUNT(*) as cnt FROM memory");

			const compressionCount = Number(comp?.cnt ?? 0);
			const memoryCount = Number(mem?.cnt ?? 0);
			const totalOrig = Number(comp?.orig ?? 0);
			const totalComp = Number(comp?.comp ?? 0);

			return {
				compressionCount,
				memoryCount,
				totalOriginalTokens: totalOrig,
				totalCompressedTokens: totalComp,
				totalSavingsPercent: totalOrig
					? Math.round(((totalOrig - totalComp) / totalOrig) * 100)
					: 0,
			};
		},

		setMeta(key, value) {
			db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value]);
			save();
		},

		getMeta(key) {
			const row = execOne(db, "SELECT value FROM meta WHERE key = ?", [key]);
			return row ? String(row.value ?? "") : undefined;
		},

		close() {
			saveNow();
			db.close();
		},
	};

	return api;
}

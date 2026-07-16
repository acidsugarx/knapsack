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
    last_accessed TEXT
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

// ── Public API ─────────────────────────────────────────

export interface KnapsackDB {
	saveMemory(input: {
		content: string;
		type: MemoryTypeValue;
		scope?: MemoryScopeValue;
		project?: string;
		importance?: number;
		sourceSession?: string;
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

	const api: KnapsackDB = {
		saveMemory(input) {
			const now = new Date().toISOString();
			const id = randomUUID();
			const contentHash = sha256(input.content + input.type);
			const ts = Date.now();

			const sql = `INSERT INTO memory (id, content, type, scope, project, importance, recency, created_at, updated_at, content_hash, source_session)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_hash) DO UPDATE SET
          importance = MAX(importance, excluded.importance),
          access_count = access_count + 1,
          updated_at = excluded.updated_at,
          last_accessed = excluded.updated_at`;

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

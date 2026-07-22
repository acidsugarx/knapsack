/**
 * Ambient type declarations for sql.js (WASM SQLite). The official @types
 * package does not cover the WASM build, so we declare the subset of the
 * API Knapsack uses: Database.run, exec, export, close.
 *
 * @module sql-js-types
 */

declare module "sql.js" {
	interface QueryExecResult {
		columns: string[];
		values: unknown[][];
	}

	interface Database {
		run(sql: string, params?: unknown[]): Database;
		exec(sql: string): QueryExecResult[];
		export(): Uint8Array;
		close(): void;
	}

	interface SqlJsStatic {
		Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
	}

	function initSqlJs(config?: Record<string, unknown>): Promise<SqlJsStatic>;
	export default initSqlJs;
	export type { Database, QueryExecResult, SqlJsStatic };
}

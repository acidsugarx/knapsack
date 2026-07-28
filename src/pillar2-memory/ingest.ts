/**
 * Ingest — external source → raw store → buffer pipeline.
 *
 * Reads a file or URL, saves the content verbatim to ~/.knapsack/raw/
 * (content-addressed, immutable — the Grounding Invariant from Astro-Han),
 * and inserts extracted memory candidates into the TRIAGE buffer for
 * dream-cycle consolidation.
 *
 * @module memory-ingest
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore } from "../core/types";

/**
 * Result of an ingest operation.
 */
export interface IngestResult {
	rawHash: string;
	rawPath: string;
	bytesRead: number;
	buffered: boolean;
}

/**
 * Ingest an external source — file or URL — into the raw store and buffer.
 *
 * @param db - Open KnapsackDB handle
 * @param store - Runtime store (dbPath derives the home directory)
 * @param source - File path or URL to ingest
 * @returns Summary of what was ingested
 */
export function ingestSource(db: KnapsackDB, store: KnapsackStore, source: string): IngestResult {
	const home = dirname(store.dbPath);
	const rawDir = join(home, "raw");
	if (!existsSync(rawDir)) mkdirSync(rawDir, { recursive: true });

	let content: string;
	if (source.startsWith("http://") || source.startsWith("https://")) {
		throw new Error("URL ingest not yet implemented — use file paths for now");
	} else {
		content = readFileSync(source, "utf8");
	}

	const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	const rawPath = join(rawDir, `${hash}.md`);
	writeFileSync(rawPath, content, "utf8");

	const _evidence = JSON.stringify([{ kind: "raw", ref: hash }]);
	const summary = content.slice(0, 200).replace(/\n/g, " ");

	db.insertBufferEntry({
		content: `ingested: ${source} — ${summary}`,
		type: "fact",
		contentHash: createHash("sha256").update(`${content}fact`).digest("hex").slice(0, 16),
		project: store.projectRoot ?? undefined,
		importance: 0.5,
		sourceSession: store.sessionId ?? undefined,
	});

	return {
		rawHash: hash,
		rawPath,
		bytesRead: content.length,
		buffered: true,
	};
}

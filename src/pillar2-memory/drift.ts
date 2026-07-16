/**
 * Drift detection — catches when code reality diverges from recorded decisions.
 *
 * ## Concept (inspired by linksee-memory)
 *
 * 1. User or agent declares an anchor: "We use FTS5, not pgvector"
 * 2. Anchor stores a violation signal: ["pgvector", "embedding", "vector search"]
 * 3. On each turn, recent tool outputs + file changes are scanned for these signals
 * 4. If a signal is found, drift is flagged via `knapsack_drift_status` tool
 *
 * ## Anchor states
 *
 * - **aligned** — no violation signals detected
 * - **drift** — violation signal found, no recorded resolution
 * - **held** — user acknowledged the drift, parked for review
 * - **superseded** — decision was intentionally replaced
 *
 * @module drift-detection
 */

import type { KnapsackDB } from "../core/database";

/**
 * A decision anchor with violation signals.
 */
export interface DriftAnchor {
	id: string;
	statement: string;
	/** Keywords/patterns that indicate drift if found in code or tool output */
	violationSignals: string[];
	/** Current state: aligned, drift, held, superseded */
	state: "aligned" | "drift" | "held" | "superseded";
	/** Optional note explaining why drift was acknowledged */
	resolution?: string;
	createdAt: string;
	updatedAt: string;
}

/**
 * Result of a drift check.
 */
export interface DriftCheckResult {
	anchor: DriftAnchor;
	matchedSignals: string[];
}

/**
 * Check a block of text for violation signals across all active anchors.
 *
 * @param db - Knapsack database (for reading anchors)
 * @param content - Text to scan (tool output, file content, etc.)
 * @param project - Project scope filter
 * @returns Array of drift detections with matched signals
 */
export function checkDrift(db: KnapsackDB, content: string, project?: string): DriftCheckResult[] {
	const anchors = getActiveAnchors(db, project);
	if (anchors.length === 0) return [];

	const results: DriftCheckResult[] = [];
	const contentLower = content.toLowerCase();

	for (const anchor of anchors) {
		const matched = anchor.violationSignals.filter((signal) =>
			contentLower.includes(signal.toLowerCase()),
		);
		if (matched.length > 0) {
			results.push({ anchor, matchedSignals: matched });
		}
	}

	return results;
}

/**
 * Get all anchors in "aligned" state (active for drift checking).
 *
 * Anchors are stored as memory entries with type="constraint" and a
 * special content prefix: `[anchor] statement | signals: sig1, sig2`.
 */
function getActiveAnchors(db: KnapsackDB, project?: string): DriftAnchor[] {
	const memories = db.searchMemory("[anchor]", 50, undefined, project);
	return memories
		.filter((m) => m.type === "constraint")
		.map(parseAnchor)
		.filter((a): a is DriftAnchor => a !== null)
		.filter((a) => a.state === "aligned");
}

/**
 * Parse an anchor from a memory entry.
 *
 * Format: `[anchor] We use FTS5, not pgvector | signals: pgvector, embedding, vector search`
 */
export function parseAnchor(entry: {
	id: string;
	content: string;
	createdAt: string;
	updatedAt: string;
}): DriftAnchor | null {
	const match = entry.content.match(/^\[anchor\]\s*(.+?)\s*\|\s*signals:\s*(.+)$/i);
	if (!match) return null;

	const statement = match[1]!.trim();
	const signals = match[2]!
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	return {
		id: entry.id,
		statement,
		violationSignals: signals,
		state: "aligned",
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
	};
}

/**
 * Format a drift detection result for display.
 */
export function formatDriftReport(detections: DriftCheckResult[]): string {
	if (detections.length === 0) {
		return "✅ All anchors aligned — no drift detected.";
	}

	const lines = [`⚠️ Drift detected on ${detections.length} anchor(s):`, ""];

	for (const det of detections) {
		lines.push(`🔴 **${det.anchor.statement}**`);
		lines.push(`   Violation: ${det.matchedSignals.join(", ")}`);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * JSON compression strategy — extract shape, collapse arrays/objects.
 *
 * ## Approach
 *
 * For arrays: show first + last items, infer shape from first element,
 * compute numeric statistics (min/max/avg/stddev/outliers), report
 * cardinality per key (unique → likely ID, low cardinality → enum), and
 * detect mixed-type arrays.
 * For objects: show keys + inferred types recursively up to
 * {@link MAX_DEPTH} levels deep, with nested shapes inlined.
 *
 * ## When it triggers
 *
 * Auto-detected when output starts with `{` or `[`.
 * Also mapped to any tool that returns JSON-formatted output.
 *
 * @module json-compression
 */

import { sha256 } from "../../core/hash";
import { estimateTokens, savingsPercent } from "../../core/tokens";
import type { CompressionResult } from "../../core/types";

/**
 * Maximum number of sample items to show from arrays.
 */
const MAX_SAMPLES = 3;

/**
 * Maximum depth for recursive object shape inference. Nested objects beyond
 * this depth are reported as `object` or `array` without inlining their keys.
 */
const MAX_DEPTH = 3;

/**
 * Maximum number of array elements to scan for stats and cardinality. Keeps
 * computation bounded on large arrays without losing signal — the first N
 * elements are representative for most API responses.
 */
const STATS_SAMPLE_SIZE = 100;

/**
 * Threshold for classifying a numeric field's outlier count. Values more than
 * 2 standard deviations from the mean are counted as outliers.
 */
const OUTLIER_STDEVS = 2;

/**
 * Maximum unique values for a key to be classified as an enum. Keys with
 * fewer than or equal to this many unique values are likely categorical.
 */
const ENUM_THRESHOLD = 5;

/**
 * Infer the type of a JSON value.
 *
 * @param val - Any JSON-parsed value
 * @returns Type string: "null", "array", "object", "string", "number", "boolean"
 */
function inferType(val: unknown): string {
	if (val === null) return "null";
	if (Array.isArray(val)) return "array";
	const t = typeof val;
	if (t === "object") return "object";
	return t;
}

/**
 * Infer the shape of a JSON object recursively, up to {@link MAX_DEPTH} levels.
 *
 * Nested objects and arrays-of-objects have their shapes inlined as
 * `object{key:type, ...}` or `array{key:type, ...}`. Beyond {@link MAX_DEPTH},
 * nested values are reported as plain `object` or `array` without inlining.
 *
 * @param obj - Any JSON value (object, array, or primitive)
 * @param depth - Current recursion depth (internal, defaults to 0)
 * @returns Key-to-type mapping with nested shapes inlined
 */
function inferShapeDeep(obj: unknown, depth = 0): Record<string, string> {
	if (!obj || typeof obj !== "object") return {};
	if (Array.isArray(obj)) {
		if (obj.length > 0 && typeof obj[0] === "object" && obj[0] !== null) {
			return inferShapeDeep(obj[0], depth);
		}
		return {};
	}
	const shape: Record<string, string> = {};
	for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
		const t = inferType(val);
		if ((t === "object" || t === "array") && depth < MAX_DEPTH) {
			const nested = inferShapeDeep(val, depth + 1);
			const nestedStr = Object.entries(nested)
				.map(([k, v]) => `${k}:${v}`)
				.join(", ");
			shape[key] = nestedStr ? `${t}{${nestedStr}}` : t;
		} else {
			shape[key] = t;
		}
	}
	return shape;
}

/** Numeric statistics for a single field across an array of objects. */
interface NumericStats {
	/** Minimum value */
	min: number;
	/** Maximum value */
	max: number;
	/** Arithmetic mean, rounded to 2 decimal places */
	avg: number;
	/** Standard deviation, rounded to 2 decimal places */
	stddev: number;
	/** Count of values more than {@link OUTLIER_STDEVS} stddevs from the mean */
	outliers: number;
}

/**
 * Compute statistics for numeric fields in an array of objects.
 *
 * For each numeric key in `shape`, computes min, max, avg, stddev, and
 * outlier count. Outliers are values more than {@link OUTLIER_STDEVS}
 * standard deviations from the mean — useful for spotting anomalies in
 * API responses (e.g., a single huge value among normal-sized ones).
 *
 * @param arr - Array of objects to scan (sampled to {@link STATS_SAMPLE_SIZE})
 * @param shape - Shape mapping from {@link inferShapeDeep}
 * @returns Key-to-stats mapping for numeric fields only
 */
function computeStats(
	arr: Record<string, unknown>[],
	shape: Record<string, string>,
): Record<string, NumericStats> {
	const stats: Record<string, NumericStats> = {};

	for (const [key, type] of Object.entries(shape)) {
		if (type !== "number") continue;
		const values = arr.map((item) => item[key]).filter((v): v is number => typeof v === "number");
		if (values.length === 0) continue;

		const sum = values.reduce((a, b) => a + b, 0);
		const avg = sum / values.length;
		const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / values.length;
		const stddev = Math.sqrt(variance);
		const outliers = values.filter((v) => Math.abs(v - avg) > OUTLIER_STDEVS * stddev).length;

		stats[key] = {
			min: Math.min(...values),
			max: Math.max(...values),
			avg: Math.round(avg * 100) / 100,
			stddev: Math.round(stddev * 100) / 100,
			outliers,
		};
	}

	return stats;
}

/** Cardinality classification for a key across an array of objects. */
interface CardinalityInfo {
	/** Number of distinct values */
	unique: number;
	/** Total number of values (including nulls/undefined) */
	total: number;
	/** Classification: "unique" (all distinct), "enum" (≤ {@link ENUM_THRESHOLD}), "varied" (rest) */
	kind: "unique" | "enum" | "varied";
}

/**
 * Compute cardinality for each key in an array of objects.
 *
 * Classifies keys as:
 * - `unique` — every value is distinct (likely an ID or timestamp)
 * - `enum` — ≤ {@link ENUM_THRESHOLD} distinct values (likely a category/status)
 * - `varied` — anything in between
 *
 * This helps the model understand which fields are identifiers (safe to
 * summarise) vs. categories (safe to enumerate).
 *
 * @param arr - Array of objects to scan
 * @param shape - Shape mapping from {@link inferShapeDeep}
 * @returns Key-to-cardinality mapping
 */
function computeCardinality(
	arr: Record<string, unknown>[],
	shape: Record<string, string>,
): Record<string, CardinalityInfo> {
	const card: Record<string, CardinalityInfo> = {};

	for (const key of Object.keys(shape)) {
		const values = arr.map((item) => item[key]);
		const uniqueSet = new Set(values.map((v) => JSON.stringify(v)));
		const unique = uniqueSet.size;
		const total = values.length;
		let kind: "unique" | "enum" | "varied" = "varied";
		if (unique === total) kind = "unique";
		else if (unique <= ENUM_THRESHOLD) kind = "enum";
		card[key] = { unique, total, kind };
	}

	return card;
}

/**
 * Detect the element type of a JSON array, including mixed types.
 *
 * If all elements share the same type, returns that type. If elements have
 * multiple types, returns `mixed(type1|type2|...)` with types sorted
 * alphabetically.
 *
 * @param arr - JSON array to analyse
 * @returns Type string such as "object", "string", or "mixed(number|object|string)"
 */
function inferArrayType(arr: unknown[]): string {
	if (arr.length === 0) return "empty";
	const types = new Set(arr.map(inferType));
	if (types.size === 1) return [...types][0] as string;
	return `mixed(${[...types].sort().join("|")})`;
}

/**
 * Format cardinality info for display.
 *
 * @param c - Cardinality info for a single key
 * @returns Display string like "unique", "enum(2)", or "15/20 unique"
 */
function formatCardinality(c: CardinalityInfo): string {
	if (c.kind === "unique") return "unique";
	if (c.kind === "enum") return `enum(${c.unique})`;
	return `${c.unique}/${c.total} unique`;
}

/**
 * Compress a JSON string by extracting structure.
 *
 * For arrays: shows shape, first/last items, numeric stats (with stddev and
 * outliers), cardinality per key, and samples. Detects mixed-type arrays.
 * For objects: shows keys, types, and nested shapes up to {@link MAX_DEPTH}
 * levels deep.
 *
 * @param text - Raw JSON string
 * @returns Compression result with structured summary
 */
export function compressJson(text: string): CompressionResult {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return {
			body: text,
			hash: sha256(text),
			originalTokens: estimateTokens(text),
			compressedTokens: estimateTokens(text),
			savingsPercent: 0,
			strategy: "json",
		};
	}

	const sections: string[] = [];
	let hasStructure = false;

	if (Array.isArray(data)) {
		const arr = data as unknown[];
		hasStructure = true;

		const elementType = inferArrayType(arr);
		sections.push(`── ARRAY (${arr.length} items, type: ${elementType}) ──`);

		if (arr.length > 0) {
			sections.push(`First: ${JSON.stringify(arr[0]).slice(0, 200)}`);
			if (arr.length > 1) {
				sections.push(`Last:  ${JSON.stringify(arr[arr.length - 1]).slice(0, 200)}`);
			}
		}

		if (arr.length > 0 && typeof arr[0] === "object" && arr[0] !== null && !Array.isArray(arr[0])) {
			const shape = inferShapeDeep(arr[0]);
			if (Object.keys(shape).length > 0) {
				const shapeStr = Object.entries(shape)
					.map(([k, v]) => `  ${k}: ${v}`)
					.join("\n");
				sections.push(`Shape:\n${shapeStr}`);

				const sample = arr.slice(0, Math.min(arr.length, STATS_SAMPLE_SIZE)) as Record<
					string,
					unknown
				>[];

				const stats = computeStats(sample, shape);
				if (Object.keys(stats).length > 0) {
					const statsStr = Object.entries(stats)
						.map(
							([k, s]) =>
								`  ${k}: min=${s.min}, max=${s.max}, avg=${s.avg}, σ=${s.stddev}, outliers=${s.outliers}`,
						)
						.join("\n");
					sections.push(`Stats:\n${statsStr}`);
				}

				const card = computeCardinality(sample, shape);
				if (Object.keys(card).length > 0) {
					const cardStr = Object.entries(card)
						.map(([k, c]) => `  ${k}: ${formatCardinality(c)}`)
						.join("\n");
					sections.push(`Cardinality:\n${cardStr}`);
				}
			}
		}

		if (arr.length > MAX_SAMPLES) {
			sections.push(
				`Samples:\n${arr
					.slice(0, MAX_SAMPLES)
					.map((item) => `  ${JSON.stringify(item).slice(0, 150)}`)
					.join("\n")}`,
			);
		}
	} else if (typeof data === "object" && data !== null) {
		const obj = data as Record<string, unknown>;
		hasStructure = true;

		sections.push(`── OBJECT (${Object.keys(obj).length} keys) ──`);

		const shape = inferShapeDeep(obj);
		if (Object.keys(shape).length > 0) {
			const shapeStr = Object.entries(shape)
				.map(([k, v]) => `  ${k}: ${v}`)
				.join("\n");
			sections.push(`Shape:\n${shapeStr}`);
		}
	}

	if (!hasStructure) {
		return {
			body: text,
			hash: sha256(text),
			originalTokens: estimateTokens(text),
			compressedTokens: estimateTokens(text),
			savingsPercent: 0,
			strategy: "json",
		};
	}

	const body = `📦 JSON · ${sections[0]?.replace("── ", "").replace(" ──", "")}\n\n${sections.join("\n\n")}`;

	const originalTokens = estimateTokens(text);
	const compressedTokens = estimateTokens(body);

	return {
		body,
		hash: sha256(text),
		originalTokens,
		compressedTokens,
		savingsPercent: savingsPercent(originalTokens, compressedTokens),
		strategy: "json",
	};
}

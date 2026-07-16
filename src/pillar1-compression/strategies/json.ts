/**
 * JSON compression strategy — extract shape, collapse arrays/objects.
 *
 * ## Approach
 *
 * For arrays: show first + last items, infer shape from first element,
 * compute numeric statistics.
 * For objects: show keys + inferred types at each level.
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
 * Maximum depth for object shape inference.
 */
const _MAX_DEPTH = 4;

/**
 * Infer the type of a JSON value.
 */
function inferType(val: unknown): string {
	if (val === null) return "null";
	if (Array.isArray(val)) return "array";
	const t = typeof val;
	if (t === "object") return "object";
	return t;
}

/**
 * Infer the shape of a JSON object from a sample.
 * Returns key → type mapping.
 */
function inferShape(obj: unknown): Record<string, string> {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
	const shape: Record<string, string> = {};
	for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
		shape[key] = inferType(val);
	}
	return shape;
}

/**
 * Compute basic statistics for numeric fields in an array of objects.
 */
function computeStats(
	arr: Record<string, unknown>[],
	shape: Record<string, string>,
): Record<string, { min: number; max: number; avg: number }> {
	const stats: Record<string, { min: number; max: number; avg: number }> = {};

	for (const [key, type] of Object.entries(shape)) {
		if (type !== "number") continue;
		const values = arr.map((item) => item[key]).filter((v) => typeof v === "number") as number[];
		if (values.length === 0) continue;

		const sum = values.reduce((a, b) => a + b, 0);
		stats[key] = {
			min: Math.min(...values),
			max: Math.max(...values),
			avg: Math.round((sum / values.length) * 100) / 100,
		};
	}

	return stats;
}

/**
 * Compress a JSON string by extracting structure.
 *
 * For arrays: shows shape, first/last items, numeric stats, anomalies.
 * For objects: shows keys, types, depth.
 *
 * @param text - Raw JSON string
 * @returns Compression result with structured summary
 */
export function compressJson(text: string): CompressionResult {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		// Not valid JSON — pass through
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

		sections.push(`── ARRAY (${arr.length} items) ──`);

		// Show first + last items
		if (arr.length > 0) {
			sections.push(`First: ${JSON.stringify(arr[0]).slice(0, 200)}`);
			if (arr.length > 1) {
				sections.push(`Last:  ${JSON.stringify(arr[arr.length - 1]).slice(0, 200)}`);
			}
		}

		// Infer shape
		if (arr.length > 0 && typeof arr[0] === "object" && arr[0] !== null && !Array.isArray(arr[0])) {
			const shape = inferShape(arr[0]);
			if (Object.keys(shape).length > 0) {
				const shapeStr = Object.entries(shape)
					.map(([k, v]) => `  ${k}: ${v}`)
					.join("\n");
				sections.push(`Shape:\n${shapeStr}`);

				// Stats for numeric fields
				const stats = computeStats(
					arr.slice(0, Math.min(arr.length, 100)) as Record<string, unknown>[],
					shape,
				);
				if (Object.keys(stats).length > 0) {
					const statsStr = Object.entries(stats)
						.map(([k, s]) => `  ${k}: min=${s.min}, max=${s.max}, avg=${s.avg}`)
						.join("\n");
					sections.push(`Stats:\n${statsStr}`);
				}
			}
		}

		// Show samples
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

		const shape = inferShape(obj);
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

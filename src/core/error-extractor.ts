/**
 * Error extractor for tee-on-failure — extracts error and warning lines
 * from command output so the model sees actionable diagnostics first.
 *
 * ## Design
 *
 * When a command fails (exitCode !== 0), the pipeline routes through
 * this module instead of the normal compression path. The raw output
 * is cached in CCR (full text retrievable via knapsack_retrieve), and
 * the model receives only the extracted errors + warnings + a hash
 * reference for the full log.
 *
 * @module error-extractor
 */

/** Result of error extraction from a command output. */
export interface ExtractedErrors {
	/** Error lines (capped at 2000 chars) */
	errors: string;
	/** Warning lines */
	warnings: string;
	/** Whether the errors were truncated due to length cap */
	truncated: boolean;
}

const MAX_ERROR_CHARS = 2000;

const ERROR_PATTERNS: RegExp[] = [
	/^\[ERROR\]/,
	/^Error:/,
	/^error:/i,
	/^[A-Z][a-zA-Z]*Error:/,
	/^Traceback\s*\(/,
	/^\s+at\s+\S+.*\(/,
	/^panic:/,
	/^fatal:/i,
	/^\s*FAIL\s/,
];

const WARNING_PATTERNS: RegExp[] = [/^\[WARN\]/, /^Warning:/i, /^warn:/i];

/**
 * Extract error and warning lines from command output.
 *
 * Detects common failure patterns: [ERROR]/[WARN] markers, Error:/Traceback
 * prefixes, stack trace frames, panic/fatal lines, and test failure markers.
 *
 * @param output - Raw command output
 * @returns Extracted errors, warnings, and truncation flag
 */
export function extractErrors(output: string): ExtractedErrors {
	const errorLines: string[] = [];
	const warningLines: string[] = [];
	let truncated = false;

	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		if (ERROR_PATTERNS.some((p) => p.test(trimmed))) {
			errorLines.push(line);
		} else if (WARNING_PATTERNS.some((p) => p.test(trimmed))) {
			warningLines.push(line);
		}
	}

	const errors = errorLines.join("\n");
	const warnings = warningLines.join("\n");

	let finalErrors = errors;
	if (errors.length > MAX_ERROR_CHARS) {
		finalErrors = `${errors.slice(0, MAX_ERROR_CHARS)}\n... [truncated]`;
		truncated = true;
	}

	return { errors: finalErrors, warnings, truncated };
}

/**
 * Build a formatted error summary block for tee-on-failure output.
 *
 * @param errors - Extracted error text (may be empty)
 * @param warnings - Extracted warning text (may be empty)
 * @param hash - CCR cache hash for knapsack_retrieve()
 * @returns Formatted markdown block with errors, warnings, and cache reference
 */
export function formatErrorBlock(errors: string, warnings: string, hash: string): string {
	const parts: string[] = [];

	if (errors) {
		parts.push("── COMMAND FAILED ──");
		parts.push("");
		parts.push("**Errors:**");
		parts.push(errors);
	} else {
		parts.push("── COMMAND FAILED (no error markers detected) ──");
	}

	if (warnings) {
		parts.push("");
		parts.push("**Warnings:**");
		parts.push(warnings);
	}

	parts.push("");
	parts.push(`[Full output cached — \`knapsack_retrieve("${hash}")\` for complete error log]`);

	return parts.join("\n");
}

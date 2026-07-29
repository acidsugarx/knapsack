/**
 * Safety router — prevents compression of high-risk outputs that would
 * be corrupted by token reduction (stack traces, private keys, SQL
 * migrations, binary data).
 *
 * ## Design
 *
 * Runs as the FIRST check in the compression pipeline (after the
 * knapsack_retrieve bypass). When a high-risk pattern is detected,
 * the output passes through unchanged — no compression, no footer.
 *
 * All checks are fast regex-only to avoid dominating pipeline time.
 *
 * @module safety-router
 */

/** Result of a safety check — whether the output should pass through unchanged. */
export interface SafetyCheck {
	/** True if the output should NOT be compressed */
	shouldPassthrough: boolean;
	/** Why the output is being passed through (for debugging) */
	reason?: string;
}

const STACK_TRACE_PATTERNS = [/^\s+at\s+\S+.*\(/m, /^Traceback\s*\(/m, /^Error:\s/m, /^panic:\s/m];

const PRIVATE_KEY_PATTERN = /-----BEGIN\s.*PRIVATE\sKEY-----/;

const SQL_MIGRATION_PATTERN =
	/(?:^|\n)\s*(CREATE|ALTER|DROP)\s+(TABLE|INDEX|VIEW|TRIGGER|FUNCTION|PROCEDURE)/im;

/**
 * Check whether an output is too risky to compress.
 *
 * Detects stack traces, private keys, SQL migration statements, and
 * binary/semi-binary data. Returns a passthrough flag with reason.
 *
 * @param output - Raw tool output text
 * @param _toolName - Name of the tool (reserved for future tool-specific routing)
 * @returns Safety check result with passthrough flag and optional reason
 */
export function checkSafety(output: string, _toolName: string): SafetyCheck {
	if (!output || output.length === 0) {
		return { shouldPassthrough: false };
	}

	// Stack traces — regex-only, fast
	if (STACK_TRACE_PATTERNS.some((p) => p.test(output))) {
		return { shouldPassthrough: true, reason: "stack trace" };
	}

	// Private keys — PEM headers
	if (PRIVATE_KEY_PATTERN.test(output)) {
		return { shouldPassthrough: true, reason: "private key" };
	}

	// SQL migration statements
	if (SQL_MIGRATION_PATTERN.test(output)) {
		return { shouldPassthrough: true, reason: "SQL migration" };
	}

	// Binary data detection: >30% non-printable in first 500 bytes
	if (isBinaryData(output)) {
		return { shouldPassthrough: true, reason: "binary data" };
	}

	return { shouldPassthrough: false };
}

/**
 * Detect binary or semi-binary data by checking the proportion of
 * non-printable characters in the first 500 bytes.
 *
 * Also checks for common binary file signatures (ELF, PNG, ZIP).
 *
 * @param output - Raw output text
 * @returns True if the output appears to be binary data
 */
function isBinaryData(output: string): boolean {
	const sample = output.slice(0, 500);
	if (sample.length === 0) return false;

	// Common binary signatures (fast path)
	if (
		sample.startsWith("\x7fELF") ||
		sample.startsWith("\x89PNG") ||
		sample.startsWith("PK\x03\x04")
	) {
		return true;
	}

	let nonPrintable = 0;
	for (let i = 0; i < sample.length; i++) {
		const code = sample.charCodeAt(i);
		// Allow: tab(9), newline(10), carriage return(13), printable ASCII(32-126),
		// UTF-8 continuation bytes (128-191), multi-byte starts (192-255)
		if (code !== 9 && code !== 10 && code !== 13 && code < 32) {
			// Control characters < 32 (except tab, newline, CR) indicate binary.
			// Skip isolated null bytes that might appear in text.
			if (code !== 0 || i < sample.length - 1) {
				nonPrintable++;
			}
		}
	}

	return nonPrintable / sample.length > 0.3;
}

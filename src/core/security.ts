/**
 * Secret detection — scan tool outputs for high-confidence credential
 * patterns before they enter the CCR cache or the compressed body.
 *
 * ## Scope
 *
 * Only patterns with very low false-positive rates are redacted by default:
 * JWTs, `-----BEGIN … PRIVATE KEY-----` blocks, AWS access key IDs, and
 * well-known vendor prefixes (`sk-ant-`, `ghp_`, `gho_`, `glpat-`, `xoxb-`).
 *
 * The generic "password" / "token" keyword matches Headroom intentionally
 * does NOT redact — in LLM agent context those words appear constantly as
 * CLI args or environment variable names without an actual secret nearby.
 *
 * ## What the detector returns
 *
 * `detectSecrets(text)` returns a list of findings with the matched span so
 * the caller can either redact (replace with `<redacted:jws>`) or merely
 * log a warning.
 *
 * @module security
 */

export interface SecretFinding {
	/** Classification — drives the redaction label. */
	kind: "jwt" | "private_key" | "aws_access_key" | "vendor_token";
	/** Start offset in the original text. */
	start: number;
	/** End offset (exclusive). */
	end: number;
	/** The matched string, returned so callers can dedupe findings. */
	match: string;
}

interface Pattern {
	kind: SecretFinding["kind"];
	re: RegExp;
}

const PATTERNS: Pattern[] = [
	// JWT: three base64url segments separated by dots, header starts with ey
	{
		kind: "jwt",
		re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	},
	// PEM private key blocks (RSA, EC, OPENSSH, PGP)
	{
		kind: "private_key",
		re: /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----[\s\S]*?-----END (?:RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----/g,
	},
	// AWS access key id
	{ kind: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
	// Anthropic / OpenAI / GitHub / GitLab / Slack tokens
	{
		kind: "vendor_token",
		re: /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
	},
];

/** Scan `text` for credential patterns.
 *
 * @param text - Tool output (or any string) to scan.
 * @returns Findings in document order; empty array when nothing matched.
 */
export function detectSecrets(text: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	for (const { kind, re } of PATTERNS) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null = re.exec(text);
		while (m !== null) {
			findings.push({ kind, start: m.index, end: m.index + m[0].length, match: m[0] });
			m = re.exec(text);
		}
	}
	findings.sort((a, b) => a.start - b.start);
	return findings;
}

/**
 * Replace each finding with a `<redacted:KIND>` placeholder.
 *
 * The original is what the caller still writes to the CCR cache — redaction
 * only applies to the compressed body the model sees. `knapsack_retrieve`
 * returns the original (with the secret intact) so the user can still see
 * what was elided if they explicitly ask.
 *
 * @param text - Source text containing the spans listed in `findings`.
 * @param findings - Findings returned by {@link detectSecrets}. Spans must
 * reference offsets in `text`; the function walks the list in reverse so
 * earlier offsets stay valid as the string is spliced.
 * @returns `text` with each finding's span replaced by `<redacted:KIND>`.
 */
export function redactSecrets(text: string, findings: SecretFinding[]): string {
	if (findings.length === 0) return text;
	// Walk from the end so earlier offsets stay valid as we splice.
	let out = text;
	for (let i = findings.length - 1; i >= 0; i--) {
		const f = findings[i];
		out = `${out.slice(0, f.start)}<redacted:${f.kind}>${out.slice(f.end)}`;
	}
	return out;
}

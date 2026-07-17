/**
 * Tag Protector — swap XML/custom tags for opaque placeholders before
 * compression, restore them after.
 *
 * Tool outputs sometimes carry structured markers the model needs verbatim:
 * `<system-reminder>`, `<tool_call>`, `<thinking>`, `<args>`,
 * `<function_calls>`. A content-based compressor may slice through them,
 * stripping the closing tag, breaking the inner content into a different
 * section, or dedup the opening and closing tags as if they were ordinary
 * lines. The model then sees malformed markers and may misroute its reply.
 *
 * ## Algorithm
 *
 * 1. Scan for known tag pairs (`<name>...</name>` with non-greedy body).
 * 2. Replace each occurrence with a unique placeholder token
 *    (`__KNAPSACK_TAG_N__`).
 * 3. Run the compressor on the protected text.
 * 4. Restore the placeholders in the compressed body.
 *
 * The compressor sees a single opaque token where each tag block was; it
 * cannot break the structure.
 *
 * @module tag-protector
 */

/** Tag names we protect. Add as needed — keep conservative to avoid noise. */
const PROTECTED_TAGS = [
	"system-reminder",
	"system_prompt",
	"tool_call",
	"tool_result",
	"thinking",
	"args",
	"function_calls",
	"function_call",
	"instructions",
	"context",
	// Claude Code / Cline-style structured tags
	"error",
	"result",
	"details",
	"environment_details",
] as const;

const PLACEHOLDER_PREFIX = "__KNAPSACK_TAG_";

interface Protection {
	/** The text with every matching tag block replaced by a placeholder. */
	protectedText: string;
	/** Placeholder → original block. Empty when nothing matched. */
	tags: Map<string, string>;
}

/** Returns true if any tag block was found and replaced. */
export function hasProtectedTags(text: string): boolean {
	for (const name of PROTECTED_TAGS) {
		const re = new RegExp(`<${name}>[\\s\\S]*?</${name}>`, "i");
		if (re.test(text)) return true;
	}
	return false;
}

/**
 * Replace each known tag block with an opaque placeholder.
 *
 * Placeholders are stable per call: scanning again on the protected text
 * returns no matches, so callers can safely chain through compressors that
 * re-detect content type.
 */
export function protectTags(text: string): Protection {
	const tags = new Map<string, string>();
	let counter = 0;
	let out = text;

	for (const name of PROTECTED_TAGS) {
		const re = new RegExp(`<${name}>[\\s\\S]*?</${name}>`, "gi");
		out = out.replace(re, (match) => {
			const key = `${PLACEHOLDER_PREFIX}${counter++}__`;
			tags.set(key, match);
			return key;
		});
	}

	return { protectedText: out, tags };
}

/**
 * Replace placeholders back with the original tag blocks.
 *
 * Placeholders that disappeared from the compressed body (e.g. dropped by
 * the compressor as noise) are simply not restored — the model loses that
 * block but at least no malformed fragments remain.
 */
export function restoreTags(text: string, tags: Map<string, string>): string {
	if (tags.size === 0) return text;
	let out = text;
	for (const [key, original] of tags) {
		// global replace — a placeholder may appear more than once if the
		// compressor happened to surface it.
		out = out.split(key).join(original);
	}
	return out;
}

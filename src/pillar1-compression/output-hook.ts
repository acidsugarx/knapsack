/**
 * Output compression hook — compresses old assistant messages before each
 * LLM call via the `context` event.
 *
 * ## Why
 *
 * On Opus-class models, output tokens cost 5x input tokens. But once an
 * assistant message is in context, it becomes input for every subsequent
 * turn. Long-winded responses (code restatements, boilerplate preambles,
 * repeated patterns) inflate input tokens for the rest of the session.
 *
 * This hook trims that fat from OLD assistant messages — the ones the model
 * has already seen and acted on — while leaving recent messages untouched.
 *
 * ## What it compresses
 *
 * - Only `AssistantMessage` messages (identified by `role === "assistant"`)
 * - Only `TextContent` blocks within those messages
 * - Only messages older than the most recent 2 assistant messages
 * - Only text blocks above 800 tokens (short responses pass through)
 *
 * ## What it does NOT touch
 *
 * - `ThinkingContent` blocks (reasoning — compressing loses signal)
 * - `ToolCall` blocks (model needs these to match tool results)
 * - The most recent 2 assistant messages (preserve working context)
 * - User messages and tool result messages
 *
 * ## Compression techniques (conservative, lossy only for very long blocks)
 *
 * 1. Strip leading boilerplate: "Let me...", "I'll...", "Now I'll...", etc.
 * 2. Collapse 3+ consecutive newlines to 2
 * 3. For blocks > 2000 tokens: keep first 500 + last 200 chars with a
 *    `[... truncated ...]` marker in between
 *
 * @module output-hook
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "../core/tokens";

/** Minimum total messages before compression activates. */
const MIN_MESSAGES = 4;

/** Number of most-recent assistant messages to leave untouched. */
const PRESERVE_RECENT = 2;

/** Only compress text blocks above this token count. */
const TOKEN_THRESHOLD = 800;

/** Above this token count, truncate the middle of the block. */
const TRUNCATE_THRESHOLD = 2000;

/** Characters to keep from the start when truncating. */
const TRUNCATE_HEAD = 500;

/** Characters to keep from the end when truncating. */
const TRUNCATE_TAIL = 200;

/**
 * Leading boilerplate patterns to strip from old assistant messages.
 * Matches common preambles the model produces but doesn't need to re-read.
 */
const BOILERPLATE_RE =
	/^(?:Let me|I'll|I will|Now I'll|Let's|Let us|I'll go ahead and|Let me start by)\s+[^\n]{0,80}\.\s*/i;

/** Three or more consecutive newlines, collapsed to two. */
const EXCESSIVE_NEWLINES_RE = /\n{3,}/g;

/** Truncation marker inserted between head and tail of very long blocks. */
const TRUNCATION_MARKER = "\n\n[... earlier message truncated ...]\n\n";

/** A text content block from an assistant message. */
interface TextBlock {
	readonly type: "text";
	text: string;
}

/**
 * Type guard: is this message block a text content block?
 *
 * @param block - A content block from an assistant message's `content` array
 * @returns true if the block has `type: "text"` and a string `text` field
 */
function isTextBlock(block: unknown): block is TextBlock {
	if (typeof block !== "object" || block === null) return false;
	const b = block as Record<string, unknown>;
	return b.type === "text" && typeof b.text === "string";
}

/**
 * Type guard: is this message an assistant message?
 *
 * @param msg - A message from the `context` event's `messages` array
 * @returns true if the message has `role === "assistant"` and array `content`
 */
function isAssistantMessage(msg: unknown): boolean {
	if (typeof msg !== "object" || msg === null) return false;
	const m = msg as Record<string, unknown>;
	return m.role === "assistant" && Array.isArray(m.content);
}

/**
 * Compress a single text block from an old assistant message.
 *
 * Conservative: only acts on blocks above {@link TOKEN_THRESHOLD} tokens.
 * Strips leading boilerplate, collapses excessive newlines, and truncates
 * the middle of very long blocks. Returns the original text if no savings.
 *
 * @param text - The text content of an assistant message block
 * @returns Compressed text, or the original if compression yielded no savings
 */
function compressTextBlock(text: string): string {
	const originalTokens = estimateTokens(text);
	if (originalTokens < TOKEN_THRESHOLD) return text;

	let compressed = text;

	compressed = compressed.replace(BOILERPLATE_RE, "");
	compressed = compressed.replace(EXCESSIVE_NEWLINES_RE, "\n\n");

	if (estimateTokens(compressed) > TRUNCATE_THRESHOLD) {
		compressed =
			compressed.slice(0, TRUNCATE_HEAD) + TRUNCATION_MARKER + compressed.slice(-TRUNCATE_TAIL);
	}

	if (estimateTokens(compressed) >= originalTokens) return text;
	return compressed;
}

/**
 * Compress old assistant messages before each LLM call.
 *
 * Registered on the `context` event. Scans the message list for assistant
 * messages older than the most recent {@link PRESERVE_RECENT}, compresses
 * their text blocks, and returns the modified message list.
 *
 * Returns `undefined` (no modification) when:
 * - Fewer than {@link MIN_MESSAGES} messages in context
 * - Fewer than {@link PRESERVE_RECENT} + 1 assistant messages
 * - No compressible text blocks found
 *
 * @param event - The `context` event from Pi, containing the full message list
 * @returns Object with modified `messages` array, or `undefined` if no changes
 */
export function outputCompressionHook(
	event: ContextEvent,
): { messages: typeof event.messages } | undefined {
	const messages = event.messages;
	if (messages.length < MIN_MESSAGES) return undefined;

	const assistantIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (isAssistantMessage(messages[i])) {
			assistantIndices.push(i);
		}
	}

	if (assistantIndices.length <= PRESERVE_RECENT) return undefined;

	const toCompress = new Set(assistantIndices.slice(0, -PRESERVE_RECENT));
	let modified = false;

	const newMessages = messages.map((msg, idx) => {
		if (!toCompress.has(idx)) return msg;

		const m = msg as { role?: unknown; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) return msg;

		let contentModified = false;
		const newContent = m.content.map((block) => {
			if (!isTextBlock(block)) return block;
			const compressed = compressTextBlock(block.text);
			if (compressed === block.text) return block;
			contentModified = true;
			return { ...block, text: compressed };
		});

		if (!contentModified) return msg;
		modified = true;
		return { ...msg, content: newContent } as typeof msg;
	});

	return modified ? { messages: newMessages } : undefined;
}

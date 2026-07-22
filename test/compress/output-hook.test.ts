import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { outputCompressionHook } from "../../src/pillar1-compression/output-hook.js";

/** Long text block that exceeds the 800-token threshold (~2800 chars). */
function longAssistantText(): string {
	const boilerplate = "Let me check the file and see what's going on with the configuration. ";
	const body = "The configuration file has several settings that need attention. ".repeat(40);
	return `${boilerplate + body}\n\n\n\n${"More details here. ".repeat(20)}`;
}

function makeAssistantMessage(text: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "test-model",
		usage: {
			input: 100,
			output: 200,
			totalTokens: 300,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeUserMessage(text: string): Record<string, unknown> {
	return { role: "user", content: text, timestamp: Date.now() };
}

function makeToolResultMessage(): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function makeEvent(messages: unknown[]): ContextEvent {
	return { type: "context", messages: messages as never[] } as ContextEvent;
}

describe("outputCompressionHook", () => {
	it("returns undefined for fewer than 4 messages", () => {
		const event = makeEvent([makeUserMessage("hello"), makeAssistantMessage("hi")]);
		expect(outputCompressionHook(event)).toBeUndefined();
	});

	it("returns undefined when only 2 or fewer assistant messages exist", () => {
		const event = makeEvent([
			makeUserMessage("hello"),
			makeAssistantMessage("hi"),
			makeToolResultMessage(),
			makeAssistantMessage("thanks"),
		]);
		expect(outputCompressionHook(event)).toBeUndefined();
	});

	it("returns undefined when no text blocks exceed threshold", () => {
		const event = makeEvent([
			makeUserMessage("hello"),
			makeAssistantMessage("short reply 1"),
			makeToolResultMessage(),
			makeAssistantMessage("short reply 2"),
			makeUserMessage("again"),
			makeAssistantMessage("short reply 3"),
		]);
		expect(outputCompressionHook(event)).toBeUndefined();
	});

	it("compresses old assistant messages but preserves recent ones", () => {
		const longText = longAssistantText();
		const event = makeEvent([
			makeUserMessage("hello"),
			makeAssistantMessage(longText),
			makeToolResultMessage(),
			makeAssistantMessage(longText),
			makeUserMessage("again"),
			makeAssistantMessage(longText),
		]);

		const result = outputCompressionHook(event);
		expect(result).toBeDefined();
		expect(result?.messages).toBeDefined();

		const messages = result!.messages as Array<Record<string, unknown>>;
		const assistantMessages = messages.filter((m) => m.role === "assistant");

		expect(assistantMessages.length).toBe(3);

		const firstContent = (assistantMessages[0]!.content as Array<{ text: string }>)[0]!.text;
		const lastContent = (assistantMessages[2]!.content as Array<{ text: string }>)[0]!.text;

		expect(firstContent.length).toBeLessThan(longText.length);
		expect(lastContent).toBe(longText);
	});

	it("strips leading boilerplate from compressed messages", () => {
		const text = `Let me check the file and see what's going on. ${"Body content here. ".repeat(200)}`;
		const event = makeEvent([
			makeUserMessage("hello"),
			makeAssistantMessage(text),
			makeToolResultMessage(),
			makeAssistantMessage(text),
			makeUserMessage("again"),
			makeAssistantMessage("short reply"),
		]);

		const result = outputCompressionHook(event);
		const messages = result!.messages as Array<Record<string, unknown>>;
		const firstAssistant = messages.find((m, i) => m.role === "assistant" && i === 1) as Record<
			string,
			unknown
		>;
		const compressedText = (firstAssistant.content as Array<{ text: string }>)[0]!.text;

		expect(compressedText).not.toContain("Let me check the file");
	});

	it("collapses excessive newlines", () => {
		const text = `Let me start by checking. ${"Content. ".repeat(400)}\n\n\n\n\n\n${"End. ".repeat(200)}`;
		const event = makeEvent([
			makeUserMessage("hello"),
			makeAssistantMessage(text),
			makeToolResultMessage(),
			makeAssistantMessage(text),
			makeUserMessage("again"),
			makeAssistantMessage("short reply"),
		]);

		const result = outputCompressionHook(event);
		expect(result).toBeDefined();
		const messages = result!.messages as Array<Record<string, unknown>>;
		const firstAssistant = messages.find((m) => m.role === "assistant") as Record<string, unknown>;
		const compressedText = (firstAssistant.content as Array<{ text: string }>)[0]!.text;

		expect(compressedText).not.toMatch(/\n{3,}/);
	});

	it("truncates very long blocks with a marker", () => {
		const text = "Content. ".repeat(1000);
		const event = makeEvent([
			makeUserMessage("hello"),
			makeAssistantMessage(text),
			makeToolResultMessage(),
			makeAssistantMessage(text),
			makeUserMessage("again"),
			makeAssistantMessage("short reply"),
		]);

		const result = outputCompressionHook(event);
		const messages = result!.messages as Array<Record<string, unknown>>;
		const firstAssistant = messages.find((m) => m.role === "assistant") as Record<string, unknown>;
		const compressedText = (firstAssistant.content as Array<{ text: string }>)[0]!.text;

		expect(compressedText).toContain("[... earlier message truncated ...]");
		expect(compressedText.length).toBeLessThan(text.length);
	});

	it("does not modify non-text content blocks", () => {
		const longText = longAssistantText();
		const assistantWithToolCall = {
			role: "assistant",
			content: [
				{ type: "text", text: longText },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/foo" } },
			],
			model: "test",
			usage: {
				input: 0,
				output: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const event = makeEvent([
			makeUserMessage("hello"),
			assistantWithToolCall,
			makeToolResultMessage(),
			assistantWithToolCall,
			makeUserMessage("again"),
			assistantWithToolCall,
		]);

		const result = outputCompressionHook(event);
		expect(result).toBeDefined();
		const messages = result!.messages as Array<Record<string, unknown>>;
		const firstAssistant = messages.find((m) => m.role === "assistant") as Record<string, unknown>;
		const content = firstAssistant.content as Array<Record<string, unknown>>;

		const toolCall = content.find((b) => b.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall?.name).toBe("read");
	});

	it("returns undefined when messages is empty", () => {
		const event = makeEvent([]);
		expect(outputCompressionHook(event)).toBeUndefined();
	});
});

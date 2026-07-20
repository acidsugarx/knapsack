import { describe, expect, it } from "vitest";
import {
	hasProtectedTags,
	protectTags,
	restoreTags,
} from "../../src/pillar1-compression/tag-protector.js";

describe("tag-protector", () => {
	it("detects known tag blocks", () => {
		expect(hasProtectedTags("hello <thinking>inner thought</thinking> world")).toBe(true);
		expect(hasProtectedTags("<system-reminder>note</system-reminder>")).toBe(true);
		expect(hasProtectedTags("no tags here")).toBe(false);
		expect(hasProtectedTags("<div>html is not protected</div>")).toBe(false);
	});

	it("replaces each tag block with a unique placeholder", () => {
		const text =
			'intro\n<tool_call>{"name":"foo"}</tool_call>\nmiddle\n<thinking>plan b</thinking>\noutro';
		const { protectedText, tags } = protectTags(text);
		expect(tags.size).toBe(2);
		expect(protectedText).not.toContain("<tool_call>");
		expect(protectedText).not.toContain("<thinking>");
		expect(protectedText).toContain("intro");
		expect(protectedText).toContain("outro");
		// Body of the tool_call must not leak into the protected text — the
		// compressor would otherwise see the JSON and might misroute.
		expect(protectedText).not.toContain("foo");
	});

	it("restores placeholders back to the original blocks", () => {
		const text = "<args>{ x: 1 }</args> body";
		const { protectedText, tags } = protectTags(text);
		expect(restoreTags(protectedText, tags)).toBe(text);
	});

	it("preserves the original block byte-for-byte (including inner whitespace)", () => {
		const inner = "{\n  multi:\n    line\n}";
		const text = `<function_calls>${inner}</function_calls>`;
		const { protectedText, tags } = protectTags(text);
		expect(restoreTags(protectedText, tags)).toBe(text);
	});

	it("no-op when nothing matches", () => {
		const { protectedText, tags } = protectTags("plain text only");
		expect(tags.size).toBe(0);
		expect(protectedText).toBe("plain text only");
		expect(restoreTags("plain text only", tags)).toBe("plain text only");
	});

	it("KNOWN LIMITATION: nested same-name tags only protect the inner block", () => {
		// Document the regex limitation: non-greedy `<name>[\s\S]*?</name>`
		// matches from the outer open to the first close — the inner content
		// ends up inside the placeholder, and the trailing outer `</error>` is
		// left dangling. Restoration still recovers the original text exactly.
		const text = "<error>outer <error>inner</error> end</error>";
		const { protectedText, tags } = protectTags(text);
		expect(tags.size).toBe(1);
		expect(protectedText).toContain("end</error>"); // outer close left dangling
		expect(protectedText).not.toContain("inner"); // inner content inside the placeholder
		expect(restoreTags(protectedText, tags)).toBe(text);
	});
});

import { describe, expect, it } from "vitest";
import { redactImages } from "../../src/pillar1-compression/image.js";

/** Minimal valid PNG (1x1 transparent) as base64 — 8-byte sig + IHDR + IEND. */
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("redactImages", () => {
	it("returns count 0 when no images present", () => {
		const { redacted, count } = redactImages("just plain text, no images here");
		expect(count).toBe(0);
		expect(redacted).toBe("just plain text, no images here");
	});

	it("replaces data:image PNG URIs with metadata summary", () => {
		const text = `Here is a screenshot: data:image/png;base64,${TINY_PNG_BASE64} and more text`;
		const { redacted, count } = redactImages(text);
		expect(count).toBe(1);
		expect(redacted).toContain("<image:");
		expect(redacted).toContain("png>");
		expect(redacted).not.toContain(TINY_PNG_BASE64);
		expect(redacted).toContain("and more text");
	});

	it("parses PNG dimensions from the IHDR chunk", () => {
		const text = `data:image/png;base64,${TINY_PNG_BASE64}`;
		const { redacted } = redactImages(text);
		expect(redacted).toMatch(/1x1/);
	});

	it("handles JPEG data URIs", () => {
		const fakeJpeg = "A".repeat(200);
		const text = `data:image/jpeg;base64,${fakeJpeg}`;
		const { redacted, count } = redactImages(text);
		expect(count).toBe(1);
		expect(redacted).toContain("<image:");
		expect(redacted).toContain("jpg");
		expect(redacted).not.toContain(fakeJpeg);
	});

	it("handles multiple images in the same text", () => {
		const text = [
			`data:image/png;base64,${TINY_PNG_BASE64}`,
			"some text between",
			`data:image/jpeg;base64,${"B".repeat(200)}`,
		].join(" ");
		const { redacted, count } = redactImages(text);
		expect(count).toBe(2);
		expect(redacted).toContain("some text between");
		expect(redacted.match(/<image:/g)?.length).toBe(2);
	});

	it("ignores base64 strings shorter than 50 characters", () => {
		const shortBase64 = "iVBORw0KGgo=";
		const text = `data:image/png;base64,${shortBase64}`;
		const { redacted, count } = redactImages(text);
		expect(count).toBe(0);
		expect(redacted).toBe(text);
	});

	it("reports human-readable size", () => {
		const largeBase64 = "A".repeat(1400);
		const text = `data:image/png;base64,${largeBase64}`;
		const { redacted } = redactImages(text);
		expect(redacted).toMatch(/KB/);
	});

	it("does not modify non-image data URIs", () => {
		const text = "data:text/plain;base64,SGVsbG8gV29ybGQ=";
		const { redacted, count } = redactImages(text);
		expect(count).toBe(0);
		expect(redacted).toBe(text);
	});
});

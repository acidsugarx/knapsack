/**
 * Image redaction — replaces base64 image data URIs with compact metadata
 * summaries before the compression pipeline sees them.
 *
 * ## Why
 *
 * Tool outputs sometimes embed image data as `data:image/png;base64,...` URIs.
 * These can be hundreds of kilobytes of opaque base64 that:
 * - Inflate token counts dramatically
 * - Provide no useful information to the LLM (it can't render them)
 * - Blow past compression strategy thresholds without adding signal
 *
 * ## What it does
 *
 * Scans for `data:image/{type};base64,{data}` patterns and replaces each with:
 * - `<image: 123KB, 1920x1080, png>` (when dimensions can be parsed — PNG only)
 * - `<image: 123KB, jpeg>` (for other types)
 *
 * The original (with images) is preserved in the CCR cache for retrieval.
 *
 * @module image-redaction
 */

/**
 * Matches `data:image/{type};base64,{data}` URIs. Captures the image type
 * and the base64-encoded data. Requires at least 100 chars of base64 to avoid
 * matching tiny inline icons that aren't worth redacting.
 */
const DATA_URI_IMAGE_RE = /data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=]{50,})/g;

/** Result of image redaction — the modified text and how many images were replaced. */
export interface ImageRedactionResult {
	/** Text with image data URIs replaced by metadata summaries */
	redacted: string;
	/** Number of images found and replaced */
	count: number;
}

/**
 * Parse PNG dimensions from the first 24 bytes of the decoded image data.
 *
 * PNG format: 8-byte signature + IHDR chunk (4-byte length + 4-byte type +
 * 13-byte data). Width is at byte offset 16, height at offset 20, both
 * big-endian uint32.
 *
 * @param base64Data - Base64-encoded PNG data (without the `data:image/png;base64,` prefix)
 * @returns Dimensions `{ width, height }` or `null` if the data is too short or not a valid PNG
 */
function parsePngDimensions(base64Data: string): { width: number; height: number } | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");
		if (buffer.length < 24) return null;
		// Verify PNG signature (first 8 bytes: 89 50 4E 47 0D 0A 1A 0A)
		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}
		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);
		return { width, height };
	} catch {
		return null;
	}
}

/**
 * Format the size of base64-encoded data in human-readable units.
 *
 * Base64 encodes 3 bytes per 4 characters, so decoded size ≈ `length * 3 / 4`.
 *
 * @param base64Length - Length of the base64 string
 * @returns Human-readable size like "1.2MB" or "45KB"
 */
function formatSize(base64Length: number): string {
	const bytes = (base64Length * 3) / 4;
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
	return `${Math.round(bytes)}B`;
}

/**
 * Replace all base64 image data URIs in the text with compact metadata summaries.
 *
 * @param text - Source text that may contain `data:image/...;base64,...` URIs
 * @returns The redacted text and the count of images replaced
 */
export function redactImages(text: string): ImageRedactionResult {
	let count = 0;
	const redacted = text.replace(DATA_URI_IMAGE_RE, (_match, type: string, data: string) => {
		count++;
		const size = formatSize(data.length);
		const normalisedType = type === "svg+xml" ? "svg" : type.replace("peg", "pg");

		if (normalisedType === "png") {
			const dims = parsePngDimensions(data);
			if (dims) {
				return `<image: ${size}, ${dims.width}x${dims.height}, png>`;
			}
		}

		return `<image: ${size}, ${normalisedType}>`;
	});

	return { redacted, count };
}

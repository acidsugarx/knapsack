/**
 * Optional embedding-based semantic scoring layer.
 *
 * ## Architecture
 *
 * Uses @xenova/transformers (optional dependency) to run
 * Xenova/all-MiniLM-L6-v2 locally — 384 dims, ~23MB quantized ONNX,
 * pure WASM inference, no native compilation required.
 *
 * ## Graceful degradation
 *
 * If @xenova/transformers is not installed or model load fails,
 * `isAvailable()` returns false and callers fall back to BM25-only.
 *
 * ## Model lifecycle
 *
 * The model loads lazily on first `embed()` call (~2-3 seconds).
 * Subsequent calls are ~50-100ms per text. The pipeline is cached
 * for the process lifetime.
 *
 * @module embeddings
 */

/** Lazy-loaded embedding pipeline */
let pipeline:
	| ((text: string, opts: Record<string, unknown>) => Promise<{ data: Float32Array }>)
	| null = null;

/** Whether the embedding model is loaded and ready */
let initialized = false;

/** Whether initialization was attempted and failed */
let initFailed = false;

/**
 * Initialize the embedding pipeline.
 *
 * Loads Xenova/all-MiniLM-L6-v2 via @xenova/transformers.
 * Safe to call multiple times — only loads once.
 */
export async function initEmbeddings(): Promise<void> {
	if (initialized || initFailed) return;

	try {
		// Dynamic import — @xenova/transformers is an optional dependency
		const transformers = await import("@xenova/transformers");
		const extractor = await transformers.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");

		pipeline = ((text: string, opts: Record<string, unknown>) =>
			extractor(text, opts)) as typeof pipeline;
		initialized = true;
	} catch {
		// Package not installed, model not found, or runtime error
		initFailed = true;
	}
}

/**
 * Check if the embedding model is available and ready.
 *
 * @returns true if embed() can be called
 */
export function isAvailable(): boolean {
	return initialized && pipeline !== null;
}

/**
 * Generate a 384-dimensional embedding vector for a text string.
 *
 * Uses mean pooling and L2 normalization for cosine similarity.
 *
 * @param text - Input text to embed
 * @returns Float32Array of 384 dimensions, or null if unavailable
 */
export async function embed(text: string): Promise<Float32Array | null> {
	if (!pipeline) return null;

	const result = await pipeline(text, { pooling: "mean", normalize: true });
	return result.data;
}

/**
 * Compute cosine similarity between two normalized vectors.
 *
 * Since embed() returns L2-normalized vectors, cosine similarity
 * is just the dot product.
 *
 * @param a - First vector (must be normalized)
 * @param b - Second vector (must be normalized)
 * @returns Similarity score in [-1, 1]
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) return 0;

	let dot = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
	}

	return dot;
}

/**
 * Serialize an embedding vector for SQLite storage.
 *
 * @param vec - Float32Array embedding
 * @returns Compact string representation
 */
export function serializeEmbedding(vec: Float32Array): string {
	return JSON.stringify(Array.from(vec));
}

/**
 * Deserialize an embedding vector from SQLite storage.
 *
 * @param str - JSON string from database
 * @returns Float32Array embedding, or null if embedding failed
 */
export function deserializeEmbedding(str: string): Float32Array | null {
	try {
		const arr = JSON.parse(str) as number[];
		return new Float32Array(arr);
	} catch {
		return null;
	}
}

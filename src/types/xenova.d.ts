/**
 * Ambient type declarations for the optional @xenova/transformers dependency.
 * When the package is not installed, these stubs prevent type errors; the
 * runtime gracefully falls back to BM25-only scoring.
 *
 * @module xenova-types
 */

declare module "@xenova/transformers" {
	export const pipeline: any;
}

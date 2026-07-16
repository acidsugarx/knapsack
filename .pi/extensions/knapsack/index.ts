/**
 * Auto-discovery entry point for pi.
 *
 * When pi runs from the knapsack directory, it auto-discovers
 * `.pi/extensions/*` and loads this module. It re-exports the
 * main extension from `src/index.ts`.
 *
 * This enables the "agent develops knapsack" workflow:
 * 1. Agent edits src/*.ts
 * 2. Agent runs `/reload` in pi
 * 3. Changes take effect immediately
 */

export { default } from "../../../src/index";

/**
 * Auto-inject Knapsack usage guidance into Pi's system prompt.
 *
 * ## Design principles
 *
 * Written following the Guidance Injection Pattern from pi-dev-kit and
 * prompt engineering best practices from Anthropic:
 *
 * 1. **Decision rule first** — lead with when to use AND when not to use.
 *    The when-not-to-use is as important — it gives the agent permission
 *    to skip knapsack tools for quick tasks and prevents overcorrection.
 * 2. **Action-oriented triggers** — "When X, do Y", never descriptive.
 * 3. **Anti-patterns by exact form** — name the specific calls the model
 *    should NOT make (`knapsack_search("test")`, `knapsack_save("file
 *    listing")`). Abstract descriptions ("don't waste tool calls") are
 *    ignored.
 * 4. **Rationale** — explain WHY so the model can generalize. "Knapsack
 *    saves tokens and remembers across sessions" beats "use knapsack".
 * 5. **Concise** — ~250 tokens. Every word earns its place.
 * 6. **No stacked emphasis** — one or two MANDATORY/CRITICAL land; more
 *    are ignored. Claude Opus 4.5+ is more responsive, so dial back
 *    aggressive language. "Use knapsack_save when..." beats "CRITICAL:
 *    You MUST use knapsack_save when...".
 * 7. **Stable bytes** — no per-prompt content, so Pi's prompt cache
 *    stays hot across turns.
 *
 * @module system-prompt
 * @see https://github.com/aliou/pi-dev-kit — Guidance Injection Pattern
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering
 */

/**
 * Build the Knapsack usage-guidance block injected into the system prompt.
 *
 * @returns A `<knapsack_guidance>…</knapsack_guidance>` XML block. The bytes
 * are stable across turns (no per-prompt content) so Pi's prompt cache stays
 * hot — important for billed-token economics on pay-per-token providers.
 */
export function knapsackPromptGuidance(): string {
	return `<knapsack_guidance>
Knapsack compresses large tool outputs automatically (footer shows % saved + hash). Compressed output is sufficient for summaries, counts, structure, and listing tasks. Persistent memory (knapsack_save / knapsack_search) carries decisions and gotchas across sessions — so you don't repeat mistakes or re-derive conventions.

<decision_rule>
- User says "remember" / "note" / "keep in mind" or states a preference → knapsack_save(content, type="preference").
- You hit a non-obvious pitfall or root cause worth keeping → knapsack_save(content, type="gotcha").
- You make an architectural decision that must not be violated → knapsack_anchor(statement, signals).
- Starting a brand-new project or unfamiliar codebase → knapsack_search("keywords") to check past notes.
- Compressed output is missing a detail you need to proceed → knapsack_retrieve(hash).
- None of the above → don't call any knapsack tool. Compression is automatic.
</decision_rule>

<examples>
User: "remember to use sql.js, not better-sqlite3"
  → knapsack_save("Use sql.js, not better-sqlite3", type="preference")
  → knapsack_anchor("Use sql.js, not better-sqlite3", signals=["better-sqlite3", "node-gyp"])

User: "fix the bug in auth.ts"
  → knapsack_search("auth") — check for past gotchas about auth before editing

Compressed grep output shows file list but you need line 42 content
  → knapsack_retrieve("a1b2c3d4") — fetch original, get line 42
</examples>

<anti_patterns>
- knapsack_save("file has 200 lines") — trivia, not worth saving
- knapsack_search("test") for routine edits in code you already know — wastes a tool call
- knapsack_retrieve for summary/count/overview tasks — compressed output is sufficient
- knapsack_save after every tool call — only save non-obvious decisions and pitfalls
- Calling knapsack tools when the task is a quick one-line edit — compression is automatic, no action needed
</anti_patterns>

<types>decision · gotcha · fact · convention · preference · command · constraint · hypothesis</types>
</knapsack_guidance>`;
}

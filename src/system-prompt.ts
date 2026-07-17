/**
 * Auto-inject Knapsack usage guidance into Pi's system prompt.
 *
 * ## Design principles
 *
 * Written following prompt engineering best practices from Anthropic,
 * OpenAI, and DeepSeek for tool-calling agents:
 *
 * 1. **XML structure** — Claude reads XML tags as semantic boundaries
 * 2. **Top + bottom anchoring** — critical triggers at both ends
 * 3. **Action-oriented triggers** — "Before X, do Y", never descriptive
 * 4. **Strict imperative tone** — MANDATORY / ALWAYS / No exceptions. Never
 *    hedge with "proactively" or "you may want to". These tools are
 *    infrastructure, not optional helpers.
 * 5. **Concise** — ~200 tokens. Every word earns its place in context window
 * 6. **Lexical triggers** — concrete user phrases ("remember", "note") the
 *    model pattern-matches on, not abstract categories
 *
 * @module system-prompt
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering
 * @see https://platform.openai.com/docs/guides/prompt-engineering
 */

export function knapsackPromptGuidance(): string {
	return `<knapsack_guidance>
Knapsack compresses large tool outputs automatically (footer shows % saved + hash). The compressed form is enough for summaries, counts, structure, and listing tasks — retrieve the original only when a specific detail is missing and you cannot proceed without it.

<when>
- User says "remember this" / "note" / "keep in mind" or states a preference → knapsack_save(content, type="preference").
- You hit a non-obvious pitfall or root cause worth keeping → knapsack_save(content, type="gotcha").
- Starting a brand-new project or an unfamiliar codebase → knapsack_search("keywords") to check past notes.
</when>

<types>decision · gotcha · fact · convention · preference · command · constraint · hypothesis</types>

<may>
knapsack_obsidian(query) · knapsack_note(title, content) · knapsack_anchor(statement, signals) · knapsack_drift(content?) · knapsack_stats · knapsack_forget(id)
</may>

<skip>
- Do not save trivia: line counts, timestamps, file listings.
- Do not call knapsack_retrieve for summary/count/overview tasks — the compressed output is sufficient.
- Do not call knapsack_search for routine edits in code you already know.
- Compression is automatic — do not try to trigger it manually.
</skip>
</knapsack_guidance>`;
}

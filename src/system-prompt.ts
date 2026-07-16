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
 * 3. **"Before X, do Y" triggers** — action-oriented, not descriptive
 * 4. **When NOT to use** — prevents over-calling
 * 5. **Concise** — ~200 tokens. Every word earns its place in context window
 * 6. **Concrete examples** — inline tool call syntax for few-shot priming
 *
 * @module system-prompt
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering
 * @see https://platform.openai.com/docs/guides/prompt-engineering
 */

export function knapsackPromptGuidance(): string {
	return `<knapsack_guidance>
You have Knapsack — persistent memory and output compression. Your large tool outputs are compressed automatically. Use the tools below proactively.

<must>
- BEFORE starting any significant task: knapsack_search("keyword1 keyword2")
- AFTER making a decision or discovering a pitfall: knapsack_save(content, type="decision|gotcha")
- AFTER user says "remember this" or states a preference: knapsack_save with type="preference"
- WHEN a compressed output lacks detail: knapsack_retrieve(hash)
</must>

<memory_types>
decision   — architectural choices made
gotcha     — bugs, pitfalls, things that fail
fact       — objective info (file locations, env vars, runtime facts)
convention — team/project standards
preference — user preferences ("use uv, not pip")
command    — useful commands
constraint — hard rules that must not be broken
hypothesis — working theory to validate later
</memory_types>

<may>
- knapsack_obsidian("query") — search your Obsidian knowledge base
- knapsack_note(title, content, tags) — create a Zettelkasten-style note
- knapsack_stats — check token savings this session
- knapsack_forget(id) — delete outdated memories
</may>

<skip>
- Don't save trivial facts (line counts, timestamps, obvious file paths)
- Don't search memory for ultra-specific one-off queries
- Compression is automatic — you don't need to trigger it
</skip>
</knapsack_guidance>`;
}

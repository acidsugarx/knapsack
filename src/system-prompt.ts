/**
 * Auto-inject Knapsack usage guidance into Pi's system prompt.
 *
 * ## Why this exists
 *
 * Without this, the model doesn't know it SHOULD use Knapsack tools.
 * It sees them in the "Available tools" section but won't proactively
 * call knapsack_search before tasks or knapsack_save after decisions.
 *
 * This injection tells the model WHEN and WHY to use each Knapsack tool,
 * making the extension truly autonomous — no user prompting needed.
 *
 * ## Token budget
 *
 * The injected block is ~300 tokens. It's always present (unlike memory
 * injection which only fires when memories exist). This is intentional:
 * usage guidance is higher-value than the token cost.
 *
 * @module system-prompt
 */

/**
 * Generate the Knapsack usage guidance block for system prompt injection.
 *
 * Includes:
 * - When to use each tool (proactive triggers)
 * - Compression awareness (look for 📦 footers)
 * - Memory type selection guide (decision vs gotcha vs preference)
 *
 * @returns System prompt appendix string
 */
export function knapsackPromptGuidance(): string {
	return `<!-- KNAPSACK_GUIDANCE_START -->
## 🎒 Knapsack — Memory & Compression (ACTIVE)

You have Knapsack tools available. Use them proactively — not only when asked.

### Before starting any task
- Call **knapsack_search("topic")** to recall relevant decisions, gotchas, or conventions
- Call **knapsack_obsidian("query")** if the task involves concepts you might have notes on

### After important events
- **knapsack_save(content, type)** — persist decisions, discoveries, preferences:
  - type="decision" — architectural choices, tradeoffs made
  - type="gotcha" — pitfalls, bugs, things that don't work
  - type="fact" — objective information (file locations, API keys, runtime facts)
  - type="convention" — team/project standards
  - type="preference" — user preferences ("use uv, not pip")
  - type="command" — useful commands and how to run them
  - type="constraint" — hard rules that must be respected
  - type="hypothesis" — working theories to validate
- Importance: 0.8+ for critical gotchas/constraints, 0.5 for facts, 0.3 for preferences

### Compression is automatic
- Large bash/grep/find outputs are compressed transparently
- Look for "📦" footers showing token savings
- If compressed output lacks detail, call **knapsack_retrieve(hash)** for the full original

### Check occasionally
- **knapsack_stats** — see how many tokens you've saved this session

### Memory management
- **knapsack_forget(id)** — delete outdated or incorrect memories
- Memories persist across sessions and survive compaction
<!-- KNAPSACK_GUIDANCE_END -->`;
}

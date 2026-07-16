---
name: knapsack
description: Token reduction & persistent memory — compress tool outputs, save decisions across sessions, survive compaction. Use knapsack_search before starting tasks, knapsack_save after decisions, knapsack_retrieve when compressed output is insufficient.
---

# Knapsack — Memory & Compression

You have access to Knapsack, a persistent memory and token-reduction layer. Use it proactively.

## When to use each tool

### knapsack_search — BEFORE you act

Keyword-based (FTS5) — use short specific terms. Semantic search is planned for v0.2.

Call this when:
- Starting a new task — check if there's relevant memory
- About to make a technical decision — see what was decided before
- Encountering an error — check if it's a known gotcha
- User mentions something you discussed previously

```
knapsack_search(query="postgres pool", limit=5)
```

### knapsack_save — AFTER important events
Call this when:
- You made an architectural decision: type="decision"
- You discovered a pitfall or bug: type="gotcha"
- User told you a preference: type="preference"
- You found a useful command: type="command"
- Project convention was established: type="convention"
- You learned an objective fact: type="fact"

```
knapsack_save(
  content="Use FTS5 for full-text search, not pgvector — simpler and fast enough for <100K docs",
  type="decision",
  importance=0.8
)
```

### knapsack_retrieve — when compressed output isn't enough
When you see `📦 XX% tokens saved` in a tool output, the full original is available:

```
knapsack_retrieve(hash="a1b2c3d4e5f6")
```

Only call this when the compressed version lacks detail you need.

### knapsack_obsidian — tap into the user's knowledge base
Search the Obsidian vault for relevant notes:

```
knapsack_obsidian(query="kubernetes deployment strategy")
```

### knapsack_stats — check your savings
```
knapsack_stats()
```

## Memory types reference

| Type | Use for | Example |
|---|---|---|
| decision | Architectural choices | "Use SQLite, not PostgreSQL for local-first" |
| fact | Objective information | "The API key is in .env.local" |
| gotcha | Pitfalls, bugs | "Don't import from X — circular dependency" |
| convention | Team standards | "All commits use conventional commits format" |
| preference | User preferences | "Show diffs before writing files" |
| command | Useful commands | "Build: `uv run build` not `npm run build`" |
| constraint | Hard rules | "Never commit .env files" |
| hypothesis | Working theories | "If we replace Redis with SQLite, latency may drop" |

## Best practices

1. **Search before you act** — knapsack_search at the start of every significant task
2. **Save after decisions** — don't let important context evaporate
3. **Be specific** — "Use uv instead of pip" is better than "Python packaging preference"
4. **Use appropriate importance** — gotchas and constraints should be 0.7+, preferences 0.3–0.5
5. **Retrieve sparingly** — compressed output is usually sufficient; only retrieve when needed

# Changelog

## [0.2.0] — Unreleased

### Planned
- Semantic memory search with BM25 scoring (token overlap + importance + recency)
- Tree-sitter code compression (optional, WASM-based)
- Memory consolidation — auto-merge similar entries
- `knapsack_obsidian` improved: frontmatter-aware search

## [0.1.0] — 2026-07-16

### Added
- Compression: bash, grep, find, code (regex), JSON
- Plugin architecture (StrategyRegistry + ContentDetector)
- CCR — Compress-Cache-Retrieve with Obsidian vault
- Persistent memory: SQLite + FTS5, 8 memory types, 3 scopes
- Task-relevant memory injection (prompt keyword search)
- Content-based auto-routing (detectContentType)
- Tools: knapsack_retrieve, knapsack_search, knapsack_save, knapsack_stats, knapsack_forget, knapsack_obsidian, knapsack_note
- Commands: /knapsack-status, /knapsack-learn
- System prompt auto-injection (XML, Anthropic-style)
- Obsidian vault auto-discovery + vault search + note creation
- Idempotency: content-hash dedup on all operations
- CI: biome lint + vitest + lefthook + commitlint
- 29 tests

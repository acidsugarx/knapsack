# Changelog

## [0.1.0] — Unreleased

### Added
- **Compression**: Bash output compression (errors/warnings/dedup/tail)
- **Compression**: Grep output compression (directory grouping, top matches)
- **Compression**: Find output compression (directory tree with file counts)
- **CCR**: Compress-Cache-Retrieve layer with Obsidian vault storage
- **Memory**: SQLite + FTS5 persistent memory store
- **Memory**: auto-injection of relevant memories before agent turns
- **Memory**: auto-observation of failed tool calls → gotcha entries
- **Memory**: compaction survival — session state flushed before context reset
- **Tools**: knapsack_retrieve, knapsack_search, knapsack_save, knapsack_stats, knapsack_forget, knapsack_obsidian
- **Commands**: /knapsack-status, /knapsack-learn
- **Obsidian bridge**: automatic vault discovery, CCR storage, vault search
- **Idempotency**: content-hash-based deduplication on all operations
- **Skill**: SKILL.md to teach the LLM how to use Knapsack effectively

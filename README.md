# 🎒 Knapsack

**Token reduction & persistent memory for [Pi coding agent](https://pi.dev).**

Knapsack compresses large tool outputs before they reach the LLM, caches originals in your Obsidian vault, and maintains a persistent memory store across sessions. Your agent spends fewer tokens, remembers what it learned, and stays aware through compaction.

```
Raw bash output:  12,000 tokens
     ↓ Knapsack
Compressed:           300 tokens  (97% saved)
     ↓
Model sees:      errors + warnings + exit code
Full original:   always retrievable via knapsack_retrieve()
```

## What it does

| Capability | How |
|---|---|
| **Token reduction** | Compresses bash, grep, find, and code output — transparently, before LLM sees it |
| **Persistent memory** | Saves decisions, gotchas, facts, conventions, preferences across sessions |
| **Compaction survival** | Flushes session summaries to memory before context resets |
| **Obsidian-backed** | Cached originals stored as Markdown notes in your vault — searchable, linkable |
| **CCR (Compress-Cache-Retrieve)** | Nothing is lost — model retrieves full originals on demand |
| **Auto-learning** | Observes failed tool calls, saves gotchas automatically |
| **Idempotent** | Every operation is safe to retry — content-hash-based deduplication |

## Quick start

```bash
pi install npm:knapsack-pi
```

Restart Pi. Knapsack auto-discovers your Obsidian vault and initializes its database at `~/.knapsack/memory.db`.

## Tools

Six custom tools available to the LLM:

| Tool | Purpose |
|---|---|
| `knapsack_retrieve` | Get full original of a compressed output by hash |
| `knapsack_search` | Search persistent memory (FTS5 full-text) |
| `knapsack_save` | Save a fact, decision, gotcha, or preference |
| `knapsack_stats` | Show compression and memory statistics |
| `knapsack_forget` | Delete an outdated memory entry |
| `knapsack_obsidian` | Search your Obsidian vault |

## Commands

| Command | Purpose |
|---|---|
| `/knapsack-status` | Show status, stats, and configuration |
| `/knapsack-learn` | Review recent learnings |

## How it works

### Pillar 1: Token Reduction

Every `tool_result` event is intercepted. If the output exceeds the threshold (configurable per tool type), Knapsack applies a compression strategy:

| Tool | Strategy | Typical savings |
|---|---|---|
| `bash` | Keep errors, warnings, exit code, tail; dedup info lines | 60–95% |
| `grep` | Group matches by directory, show top matches per file | 70–95% |
| `find` | Collapse flat list into directory tree with file counts | 80–95% |
| `read` (code) | Tree-sitter AST outline: imports, signatures, exports (planned) | 50–85% |

The original output is cached in `<vault>/knapsack/compress/<hash>.md` with YAML frontmatter. The model sees the compressed version plus a retrieval hint. If it needs the full output, it calls `knapsack_retrieve(hash)`.

### Pillar 2: Persistent Memory

Memory is stored in SQLite at `~/.knapsack/memory.db` with FTS5 full-text search.

**Memory types:**
- `decision` — architectural choices and tradeoffs
- `fact` — objective information, file locations, runtime facts
- `gotcha` — pitfalls, bugs, things that don't work
- `convention` — team/project conventions
- `preference` — user preferences
- `command` — useful commands and how to run them
- `constraint` — hard constraints that must be respected
- `hypothesis` — working theories to validate

**Scope levels:**
- `global` — across all projects
- `project` — scoped to git root
- `session` — current session only

## Architecture

```
Pi session
    │
    ├─ session_start        → open DB, discover Obsidian vault
    ├─ before_agent_start   → inject relevant memories into system prompt
    ├─ tool_result          → compress large outputs (bash/grep/find)
    ├─ turn_end             → observe failures, save gotchas auto
    ├─ session_before_compact → flush session state to memory
    └─ session_shutdown     → close DB
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `KNAPSACK_HOME` | `~/.knapsack` | Database, CCR cache, and config directory |
| `KNAPSACK_OBSIDIAN_VAULT` | auto-discovered | Explicit Obsidian vault path override |

## Embeddings (optional)

Semantic embeddings are optional. Install to enable:

```bash
npm install @xenova/transformers sharp
```

- With embeddings: `score = 0.35×BM25 + 0.35×cosine + 0.2×importance + 0.1×recency`
- Without embeddings: `score = 0.5×BM25 + 0.3×importance + 0.2×recency`

`/knapsack-status` shows current state.

## Obsidian integration

Knapsack reads your Obsidian vault config (`obsidian.json`) to discover your vault path. CCR originals are stored in `~/.knapsack/cache/` (not in the vault). Notes created via `knapsack_note` go to vault root.

## Limitations

- **Search is keyword-based** (SQLite FTS5 / LIKE). Semantic/embedding search is planned for v0.2.
- **Compression is lossy for non-signal content** — see the table below for what each strategy discards.
- **No tree-sitter AST compression yet** — code files pass through uncompressed.
- **Obsidian vault must be on the same machine** — no remote vault support.

### What compression discards

| Strategy | Discarded | Recoverable? |
|----------|-----------|-------------|
| bash | INFO/DEBUG lines (collapsed to summary), non-error lines beyond tail | ✅ via `knapsack_retrieve` |
| grep | Matches beyond 3 per file, files beyond 5 per dir, dirs beyond 8 | ✅ via `knapsack_retrieve` |
| find | Files beyond 5 per dir, dirs beyond 15 | ✅ via `knapsack_retrieve` |

All discarded content is recoverable via `knapsack_retrieve(hash)` — the full original is cached in your Obsidian vault.

## Roadmap

- [x] **v0.1**: Compression (bash, grep, find, code, JSON) + CCR + memory
- [x] **v0.1**: Plugin architecture (StrategyRegistry + ContentDetector)
- [x] **v0.2**: BM25 semantic search (token overlap + IDF + importance + recency)
- [x] **v0.2**: Code compression (regex-based, tree-sitter deferred — Node 26 incompatible)
- [x] **v0.2**: JSON compression (shape inference + numeric stats)
- [x] **v0.2**: Drift detection (decision anchors with violation signals)
- [x] **v0.2**: `/knapsack-learn` full session analysis
- [x] **v0.2**: Security hardening (path validation, hash validation, execFileSync)
- [x] **v0.2**: Zettelkasten notes (`knapsack_note`)
- [x] **v0.2**: Benchmark suite (35 tests, signal preservation checks)
- [ ] **v1.0**: npm publish

## Development

```bash
git clone git@github.com:acidsugarx/knapsack.git
cd knapsack
pnpm install        # or npm install
pnpm test           # vitest
pnpm check          # biome lint + format check
```

Test with Pi directly:

```bash
pi -e ./src/index.ts
```

## License

MIT © 2026 acidsugarx

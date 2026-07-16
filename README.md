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
| `KNAPSACK_HOME` | `~/.knapsack` | Database and config directory |

## Obsidian integration

Knapsack reads your Obsidian vault config (`obsidian.json`) to discover your vault path. Cached originals are stored as Markdown notes under `knapsack/compress/` in your vault. No Obsidian plugin required — pure filesystem integration.

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

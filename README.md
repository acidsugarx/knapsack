# Knapsack

**Token reduction & persistent memory for [Pi coding agent](https://pi.dev).**

Knapsack compresses large tool outputs before they reach the LLM, caches originals locally, and maintains a persistent memory store across sessions. Your agent spends fewer tokens, remembers what it learned, and stays aware through compaction. Backed by Obsidian for notes and CCR retrieval.

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
| **Token reduction** | Compresses bash, grep, find, code, JSON output — transparently, before LLM sees it |
| **Plugin architecture** | StrategyRegistry + ContentDetector — extensible compression strategies |
| **Persistent memory** | SQLite + hybrid BM25/embeddings search. Saves decisions, gotchas, facts across sessions |
| **Semantic search** | Optional local embeddings (384-dim MiniLM) — finds related concepts without shared words |
| **Compaction survival** | Flushes session summaries to memory before context resets |
| **CCR (Compress-Cache-Retrieve)** | Originals cached in ~/.knapsack/cache — model retrieves on demand |
| **Drift detection** | Decision anchors with violation signals — auto-checked on tool outputs |
| **Obsidian integration** | Vault auto-discovery, note creation, unified search across memory + vault |
| **Auto-learning** | Observes failed tool calls, saves gotchas automatically. Session analysis via /knapsack-learn |
| **Idempotent** | Every operation is safe to retry — content-hash-based deduplication |

## Install

```bash
pi install npm:knapsack-pi
```

Restart Pi. Knapsack auto-discovers your Obsidian vault and initializes its database at `~/.knapsack/memory.db`.

## Tools

| Tool | Purpose |
|---|---|
| `knapsack_search` | Hybrid search: BM25 + optional embeddings + Obsidian vault |
| `knapsack_save` | Save a fact, decision, gotcha, convention, preference |
| `knapsack_retrieve` | Get full original of a compressed output by hash |
| `knapsack_forget` | Delete an outdated memory entry |
| `knapsack_obsidian` | Search Obsidian vault for notes |
| `knapsack_note` | Write or append to a note in Obsidian vault root |
| `knapsack_anchor` | Declare a decision anchor for drift detection |
| `knapsack_drift` | Check if code diverged from declared decisions |
| `knapsack_stats` | Show compression and memory statistics |

## Commands

| Command | Purpose |
|---|---|
| `/knapsack-status` | Show status, stats, embeddings state, and configuration |
| `/knapsack-learn` | Analyze current session, extract patterns, save learnings |

## Pillar 1: Token Reduction

Every `tool_result` event is intercepted. Content type is auto-detected, and the appropriate compression strategy applies:

| Strategy | Detection | Typical savings |
|---|---|---|
| **bash** | Log markers ([ERROR], [WARN]), exit codes, stack traces | 94% |
| **grep** | `file:line:content` pattern | 74% |
| **find** | File paths, no grep-style line numbers | 60% |
| **code** | Import/export/class/function declarations | 52% |
| **JSON** | Starts with `{` or `[`, parses as JSON | 84% |

Originals cached in `~/.knapsack/cache/{hash}`. Model sees compressed output + retrieval hint. Calls `knapsack_retrieve(hash)` for full original.

Auto-routing works with ANY tool — `bash`, `grep`, `find`, `ffgrep`, `fffind`, custom tools. No configuration needed.

## Pillar 2: Persistent Memory

SQLite at `~/.knapsack/memory.db`. Search via hybrid scoring:

- **BM25**: token overlap + IDF weighting + sigmoid normalization
- **Embeddings** (optional): 384-dim cosine similarity via @xenova/transformers
- **Composite**: `0.35×BM25 + 0.35×cosine + 0.2×importance + 0.1×recency`

**Memory types:** decision, fact, gotcha, convention, preference, command, constraint, hypothesis

**Scope:** global (all projects), project (git root), session (current only)

**Auto-injection:** before each turn, memories relevant to the user's prompt are injected into the system prompt.

**Memory pruning:** on session shutdown, entries older than 30 days with low importance and single access are pruned.

## Drift Detection

Declare decision anchors:

```
knapsack_anchor(
  statement: "Use sql.js, not better-sqlite3",
  signals: ["better-sqlite3", "node-gyp"]
)
```

Knapsack auto-checks tool outputs for violation signals. Drift appears in compression footers.

## Obsidian Integration

| Feature | Location |
|---|---|
| Vault discovery | Auto from `obsidian.json`, override via `KNAPSACK_OBSIDIAN_VAULT` |
| CCR originals | `~/.knapsack/cache/` (not in vault) |
| Notes (`knapsack_note`) | Vault root — `VaultName/Title.md` |
| Search | Unified in `knapsack_search` — memory + vault in one query |

## Embeddings (optional)

Semantic search is optional. Install to enable:

```bash
npm install @xenova/transformers sharp
```

- With embeddings: finds "database connection pooling" when you search "reduce latency"
- Without embeddings: BM25 keyword matching only
- `/knapsack-status` shows current state

No env vars or config — package presence is the toggle.

## Benchmark

```
bash       8036 →   445 tokens  (94%)
grep       7060 →  1806 tokens  (74%)
find       2301 →   913 tokens  (60%)
code        944 →   456 tokens  (52%)
json        381 →    81 tokens  (79%)
─────────────────────────────────
TOTAL     18722 →  3701 tokens  (80%)
```

All benchmarks verify signal preservation — errors, imports, signatures, structure survive compression.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `KNAPSACK_HOME` | `~/.knapsack` | Database, CCR cache, and config directory |
| `KNAPSACK_OBSIDIAN_VAULT` | auto-discovered | Explicit Obsidian vault path override |

## Development

```bash
git clone git@github.com:acidsugarx/knapsack.git
cd knapsack
npm install
npm test           # vitest (35 tests)
npm run check      # biome lint + format
```

Test with Pi:

```bash
npm run dev        # pi --approve (auto-discovers extension from .pi/extensions/)
```

## License

MIT

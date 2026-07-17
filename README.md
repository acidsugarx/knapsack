# Knapsack

**Token reduction & persistent memory for [Pi coding agent](https://pi.dev).**

Knapsack compresses large tool outputs before they reach the LLM, caches originals locally, and maintains a persistent memory store across sessions. Your agent spends fewer tokens, remembers what it learned, and stays aware through compaction. Backed by Obsidian for notes and CCR retrieval.

```
tool_result intercepted     ↓     model sees
─────────────────────────         ────────────────────────
12 636 tokens (find .c)           2 188 tokens  (83% smaller)
 4 114 tokens (kernel/sched/core.c)   327 tokens  (92% smaller, AST)
 6 119 tokens (grep EXPORT_SYMBOL)   992 tokens  (84% smaller)
                                                       · hash · summary sufficient
Originals cached at ~/.knapsack/cache/{hash} → knapsack_retrieve(hash) on demand
```

**Measured on real Pi sessions** (zai/glm-5-turbo, linux kernel clone, billed tokens at Anthropic rates — see [Benchmark](#benchmark)):

| Scenario | Savings |
|---|---:|
| `find` kernel/ subtree (20k→3.5k billed) | **+83%** |
| `find` 36 913 .c files | +60% |
| `grep` EXPORT_SYMBOL | +54% |
| `read` list functions in core.c | +45% |
| Explore dir (3 tools) | +30% |
| Multi-step workflow (4 tools) | +18% |

## What it does

| Capability | How |
|---|---|
| **Token reduction** | Compresses bash, grep, find, code, JSON output — transparently, before LLM sees it |
| **AST-aware code** | tree-sitter WASM (C/TS/JS/Python/Go/Rust) — accurate signatures, structs, interfaces |
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
| **find** | File paths, no grep-style line numbers | 60–83% |
| **code-ast** | tree-sitter grammar (C/TS/JS/Python/Go/Rust) — imports, signatures, structs, interfaces | 89–92% |
| **code** (regex fallback) | Import/export/class/function declarations for languages without a grammar | 52% |
| **JSON** | Starts with `{` or `[`, parses as JSON | 84% |

Originals cached in `~/.knapsack/cache/{hash}`. Model sees compressed output + a non-provocative footer (`📦 X% smaller · hash Y · summary is sufficient for listing/overview/structure tasks`). Calls `knapsack_retrieve(hash)` only when a specific detail is missing.

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

### Per-output compression (single tool result)

All benchmarks verify signal preservation — errors, imports, signatures, structure survive compression.

```
bash            8036 →    445 tokens  (94%)
grep            7060 →   1806 tokens  (74%)
find            2301 →    913 tokens  (60%)
code-ast (C)    4114 →    327 tokens  (92%)   kernel/sched/core.c
code (regex)     944 →    456 tokens  (52%)   fallback for unsupported langs
json             381 →     81 tokens  (79%)
───────────────────────────────────────────
```

### End-to-end Pi session savings (v0.2.0)

Real `pi -p` runs, zai/glm-5-turbo, linux kernel shallow clone (94 840 files), median of 3–5 runs.
Billed tokens = `input + cacheRead×0.10 + cacheWrite×1.25` (Anthropic rates). This is the realistic
cost metric: pi's prefix cache stays hot, so Knapsack's per-turn overhead lands in the cheaper
`cacheRead` bucket while compression shrinks `input`.

| Scenario                      | Baseline | Knapsack | Savings |
|-------------------------------|---------:|---------:|--------:|
| `find` kernel/ subtree        |    20280 |     3558 |   82.5% |
| `find` 36 913 .c files        |    23716 |     9404 |   60.3% |
| `grep` EXPORT_SYMBOL          |     8927 |     4155 |   53.5% |
| `read` list functions in .c   |     5733 |     3175 |   44.6% |
| Explore dir (3 tools)         |     4502 |     3166 |   29.7% |
| Multi-step workflow (4 tools) |     7946 |     6512 |   18.1% |

Reproduce with `scripts/bench-pi.sh` (see comments for setup).

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
npm test           # vitest (40 tests)
npm run check      # biome lint + format
```

Test with Pi:

```bash
npm run dev        # pi --approve (auto-discovers extension from .pi/extensions/)
```

## License

MIT

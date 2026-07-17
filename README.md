# Knapsack

**Token reduction & persistent memory for [Pi coding agent](https://pi.dev).**

Knapsack compresses tool outputs before they reach the LLM, caches originals locally, and maintains a persistent memory store across sessions. Your agent spends fewer tokens, remembers what it learned, and stays aware through compaction. Backed by Obsidian for notes and CCR retrieval.

[![npm version](https://img.shields.io/npm/v/knapsack-pi.svg)](https://www.npmjs.com/package/knapsack-pi)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/tests-77%20passing-brightgreen.svg)](#benchmarks)
[![pi](https://img.shields.io/badge/built%20for-pi%20agent-orange.svg)](https://pi.dev)

```
tool_result intercepted            model sees
─────────────────────────────      ────────────────────────────────────────
12 636 tokens (find .c)       →    2 188 tokens   (83% smaller)
 4 114 tokens (kernel/core.c) →      327 tokens   (92% smaller, AST)
 6 119 tokens (grep EXPORT)   →      992 tokens   (84% smaller)
 1 247 tokens (git diff)      →      374 tokens   (70% smaller)
                                                                  · hash · summary sufficient
Originals cached at ~/.knapsack/cache/{hash} → knapsack_retrieve(hash) on demand
```

## What it does

- **Compresses** every `tool_result` (bash, grep, find, code, JSON, git diff) before the model sees it — 7 content-aware strategies, 60-92% savings per output.
- **Remembers** decisions, gotchas, conventions, and user preferences across sessions in SQLite with hybrid BM25 + optional embeddings search.
- **Anchors** decisions and flags drift when the codebase diverges from them.
- **Integrates** with Obsidian — auto-discovers your vault, writes notes on demand, surfaces frontmatter in vault search.
- **Survives compaction** — flushes session state to memory before Pi resets context.

## Install

```bash
pi install npm:knapsack-pi
```

Restart Pi. Knapsack auto-discovers your Obsidian vault and initialises its database at `~/.knapsack/memory.db`.

> Requires Node 18+. Knapsack uses only WASM / pure-JS dependencies (sql.js, web-tree-sitter) — no native compilation, no node-gyp.

## Quick start

After install, run any large tool output through Pi and watch the footer:

```text
$ grep -rn "BUG_ON" --include="*.c" kernel/
kernel/sched/core.c:1234:BUG_ON(!rq->lockdep_recursion);
... 78 more matches
📦 84% smaller · hash dcd0ccf2 · summary sufficient for listing/overview/structure tasks
```

Try the memory layer:

```text
You: remember to use sql.js, not better-sqlite3
Knapsack: ✅ Saved: [preference] use sql.js, not better-sqlite3
```

In a future session, when you touch SQLite code, the preference is auto-injected into the system prompt.

## Strategies

| Strategy | Detection | Typical savings |
|---|---|---:|
| **bash** | Log markers (`[ERROR]`, `[WARN]`), exit codes, stack traces | 94% |
| **grep** | `file:line:content` pattern | 74% |
| **find** | File paths without line numbers | 60-83% |
| **code-ast** | tree-sitter grammar (C, TS/TSX, JS, Python, Go, Rust) — imports, signatures, structs, interfaces | **89-92%** |
| **code** (regex fallback) | Import/export/class/function declarations for languages without a grammar | 52% |
| **json** | Starts with `{` or `[`, parses as JSON | 84% |
| **diff** | `diff --git` + `@@` hunk headers — trims context, ranks hunks by relevance | 70%+ |

Auto-routing is content-based (no per-tool configuration). `fffind`, `ffgrep`, custom tools — all routed by what the output looks like.

Three post-strategy transforms run on every compressed body:

- **Log template mining** (Drain-inspired) — collapses `INFO worker-N processing job-N` × 800 into one line + `[800x]` count.
- **Tag protector** — wraps `<system-reminder>`, `<tool_call>`, `<thinking>`, `<args>`, etc. in placeholders so the compressor cannot slice them apart.
- **Secret redaction** — JWT, PEM private keys, AWS access keys, vendor tokens (`sk-ant-`, `ghp_`, `glpat-`, `xoxb-`) replaced with `<redacted:kind>`. Originals stay in the CCR cache so `knapsack_retrieve` still works.

## Tools

| Tool | Purpose |
|---|---|
| `knapsack_search` | Hybrid search: BM25 + optional embeddings + Obsidian vault, with frecency boost + smart-case + fuzzy fallback |
| `knapsack_save` | Save a fact, decision, gotcha, convention, preference — auto-merges near-duplicates (Jaccard ≥ 0.75) |
| `knapsack_retrieve` | Fetch the original of a compressed output by hash — only when a detail is genuinely missing |
| `knapsack_forget` | Delete an outdated memory entry |
| `knapsack_obsidian` | Search Obsidian vault — frontmatter (tags, dates, importance) appended per match |
| `knapsack_note` | Write or append to a note in the Obsidian vault root |
| `knapsack_anchor` | Declare a decision anchor with violation signals |
| `knapsack_drift` | Check whether recent tool outputs violate any declared anchor |
| `knapsack_stats` | Compression + memory statistics |

## Commands

| Command | Purpose |
|---|---|
| `/knapsack-status` | Current state, stats, embeddings availability, vault path |
| `/knapsack-learn` | Mine the current session JSONL, save insights as memories |
| `/knapsack-consolidate` | Batch-merge duplicate memories accumulated before consolidation shipped |

## Memory

SQLite at `~/.knapsack/memory.db`. Search via hybrid scoring:

- **BM25 saturation**: `bm25Relevance / (bm25Relevance + 1.5)`
- **Embeddings** (optional): 384-dim cosine similarity via `@xenova/transformers`
- **Composite (BM25 only)**: `0.45×BM25×smartCase + 0.3×importance + 0.15×recency + 0.1×frecency`
- **Frecency boost**: `log2(1 + access_count) / 5` — frequently-reused memories rank above peers that just happen to be young
- **Smart-case boost**: query with uppercase signal → 1.15× BM25 when the entry preserves the case (`JWT` ranks `JWT bearer token` above `we use jwt`)
- **Fuzzy fallback**: when the LIKE pass returns nothing, retry with 3-gram Jaccard ≥ 0.34 (`recieve` → `receive`)

**Types:** decision · gotcha · fact · convention · preference · command · constraint · hypothesis

**Scope:** global · project (git root) · session

**Consolidation:** on save, if an existing same-type entry has Jaccard ≥ 0.75, merge instead of insert (longer content wins, importance bumped, access counts sum). Run `/knapsack-consolidate` to clean up duplicates that piled up before this feature shipped.

**Auto-injection:** before each agent turn, memories relevant to the user's prompt are appended to the system prompt. Bytes are stable across turns so Pi's prompt cache stays hot.

**Pruning:** on session shutdown, entries older than 30 days with low importance and single access are pruned.

## Drift detection

Declare decision anchors:

```text
knapsack_anchor(
  statement: "Use sql.js, not better-sqlite3",
  signals: ["better-sqlite3", "node-gyp"]
)
```

Knapsack auto-checks subsequent tool outputs for the violation signals. Drift appears in the compression footer.

## Obsidian integration

| Feature | Location |
|---|---|
| Vault discovery | Auto from `obsidian.json`, override via `KNAPSACK_OBSIDIAN_VAULT` |
| CCR originals | `~/.knapsack/cache/` (not in vault — vault is for human notes) |
| Notes (`knapsack_note`) | Vault root — `VaultName/Title.md` |
| Search (`knapsack_obsidian`) | Match line + `key=value` frontmatter (tags, dates, importance) per hit |

## Embeddings (optional)

Semantic search is optional. Install to enable:

```bash
npm install @xenova/transformers sharp
```

- With embeddings: finds "database connection pooling" when you search "reduce latency"
- Without embeddings: BM25 + frecency + smart-case + fuzzy only
- `/knapsack-status` shows current state

No env vars or config — package presence is the toggle.

## Benchmarks

### Per-output compression

All strategies preserve signal — errors, imports, signatures, structure survive compression.

```
bash            8036 →    445 tokens  (94%)
grep            7060 →   1806 tokens  (74%)
find            2301 →    913 tokens  (60%)
code-ast (C)    4114 →    327 tokens  (92%)   kernel/sched/core.c
code (regex)     944 →    456 tokens  (52%)   fallback for unsupported langs
json             381 →     81 tokens  (79%)
```

### End-to-end Pi sessions (v0.3.0)

`pi -p` on a linux kernel shallow clone (94 840 files), median of 3-5 runs, billed tokens at Anthropic rates (`input + cacheRead×0.10 + cacheWrite×1.25`):

| Scenario | Baseline | Knapsack | Savings |
|---|---:|---:|---:|
| `find` kernel/ subtree | 20 280 | 3 558 | **82.5%** |
| `find` 36 913 .c files | 23 716 | 9 404 | 60.3% |
| `grep` EXPORT_SYMBOL | 8 927 | 4 155 | 53.5% |
| `read` list functions in core.c | 5 733 | 3 175 | 44.6% |
| Explore dir (3 tools) | 4 502 | 3 166 | 29.7% |
| Multi-step workflow (4 tools) | 7 946 | 6 512 | 18.1% |

Reproduce: `scripts/bench-pi.sh` (see file header for setup).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `KNAPSACK_HOME` | `~/.knapsack` | Database, CCR cache, config directory |
| `KNAPSACK_OBSIDIAN_VAULT` | auto-discovered | Explicit Obsidian vault path override |

## How it works

Two pillars, kept strictly separate:

1. **Compression** (Pillar 1) — every `tool_result` event runs through `compressionHook`, which routes by content type, applies a strategy, then post-processes with tag protection + secret redaction before returning the body + a non-provocative footer.
2. **Memory** (Pillar 2) — `before_agent_start` injects task-relevant memories; `turn_end` auto-observes failures; `session_before_compact` flushes state; `session_shutdown` prunes. Memory operations are UPSERT by content hash and debounced on save.

Architecture details: [`AGENTS.md`](AGENTS.md) · [`CHANGELOG.md`](CHANGELOG.md)

## Contributing

Pull requests welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development loop, code style, JSDoc requirements, commit conventions, and how to add a new compression strategy.

Quick start:

```bash
git clone git@github.com:acidsugarx/knapsack.git
cd knapsack
npm install           # auto-installs lefthook pre-commit + commit-msg hooks
npm test              # 77 tests
npm run check         # biome lint + format
```

## Acknowledgments

Knapsack builds on ideas from several projects:

- **[fff](https://github.com/dmtrKovalenko/fff)** — frecency ranking, smart-case detection, fuzzy zero-match fallback. These three techniques were ported to pure TS (no native deps).
- **[Headroom](https://github.com/headroomlabs-ai/headroom)** — log template mining (Drain-inspired), diff hunk scoring with priority patterns, tag protector, secret redaction patterns.
- **[Pi](https://pi.dev)** — extension API, hook contracts, prompt-cache-friendly system prompt design.
- **Anthropic prompt engineering guides** — XML-tag structure, action-oriented triggers in the system prompt.

## License

[MIT](LICENSE) © acidsugarx

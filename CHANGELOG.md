# Changelog

## [0.2.0] — 2026-07-16

### Added
- **AST-aware code compression via tree-sitter.** New `code-ast.ts` strategy
  parses source through WASM grammars (C, TypeScript/TSX, JavaScript, Python,
  Go, Rust) and extracts an accurate structural outline: imports, function
  signatures, struct/class/interface declarations, type aliases, traits. Bodies
  are dropped. Falls back to the regex strategy for languages without a grammar.
  On `kernel/sched/core.c` (400 lines): 4114 → 327 tokens (**92% saved**), 12
  functions + 2 structs + 2 macros with full signatures.
- Regression test `test/compress/hook.test.ts` — pins the `compressionHook`
  return contract so the v0.1.2 silent-drop bug cannot return.

### Fixed
- **Critical:** `tool_result` hook return value was lost in `src/index.ts` — the handler called
  `compressionHook()` without `return`, so Pi's `emitToolResult()` saw `handlerResult = undefined`
  and skipped content replacement. The cache filled and stats recorded savings, but the model
  always received the original uncompressed output. Every "tokens saved" number reported by
  v0.1.2 was phantom. Fix is one line: `return compressionHook(...)`.
- Confirmed against Pi source: `dist/core/extensions/runner.js` `emitToolResult()` checks
  `if (!handlerResult) continue;` before applying `handlerResult.content`.

### Fixed
- **Critical:** `tool_result` hook return value was lost in `src/index.ts` — the handler called
  `compressionHook()` without `return`, so Pi's `emitToolResult()` saw `handlerResult = undefined`
  and skipped content replacement. The cache filled and stats recorded savings, but the model
  always received the original uncompressed output. Every "tokens saved" number reported by
  v0.1.2 was phantom. Fix is one line: `return compressionHook(...)`.
- Confirmed against Pi source: `dist/core/extensions/runner.js` `emitToolResult()` checks
  `if (!handlerResult) continue;` before applying `handlerResult.content`.

### Changed
- System-prompt guidance rewritten to **minimal, compression-as-default** tone.
  Strict "MANDATORY search at start of every task" wording made models over-call
  tools — multi-step workflows ballooned to 12-25 tool calls vs 4 baseline (measured).
  Minimal prompt (save/search only on explicit triggers) cut workflow token cost by ~75%.
- Compression footer is no longer provocative: was
  `"% tokens saved ... knapsack_retrieve(hash) for full output"` → now `"% smaller · hash X"`.
  The old footer baited models into calling retrieve even when the compressed output
  was sufficient. Tools' `promptGuidelines` no longer mentions retrieve as a default action.
- All 9 knapsack tools no longer ship `promptSnippet` or `promptGuidelines` — they
  contributed ~530 tokens/turn of pure verbose overhead in pi's system prompt without
  changing functionality (parameters schema still reaches the model via the tools array).
- `knapsack_retrieve` description now states "Most tasks do not need this" to push the
  model toward using the compressed output for summaries, counts, and overviews.

### Added
- Regression test `test/compress/hook.test.ts` — pins the `compressionHook` return contract
  (`{ content: [{ text: body }, { text: footer }] }`) so a future refactor cannot silently break
  the Pi runner integration again.

### Measured impact
Bench: `pi -p` zai/glm-5-turbo on a linux kernel shallow clone (94 840 files), median of 3-5 runs,
billed tokens at Anthropic rates (input=1.0×, cacheRead=0.10×, cacheWrite=1.25×):

| Scenario                      | Baseline | Knapsack | Savings |
|-------------------------------|---------:|---------:|--------:|
| `find` kernel/ subtree        |    20280 |     3558 |   82.5% |
| `find` 36 913 .c files        |    23716 |     9404 |   60.3% |
| `grep` EXPORT_SYMBOL          |     8927 |     4155 |   53.5% |
| `read` list functions in .c   |     5733 |     3175 |   44.6% |
| Explore dir (3 tools)         |     4502 |     3166 |   29.7% |
| Multi-step workflow (4 tools) |     7946 |     6512 |   18.1% |

Per-output compression (single tool result, all strategies): 64-92% on find/grep/bash/code.

All six scenarios net-positive on billed tokens. The non-provocative footer (`… · summary
is sufficient for listing/overview/structure tasks`) cut knapsack_retrieve calls in multi-step
workflows from 5/run → 0-1/run.

## [0.3.0] — Planned

- Tree-sitter code compression (WASM-based, no native deps)
- Memory consolidation — auto-merge similar entries
- `knapsack_obsidian`: frontmatter-aware search

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

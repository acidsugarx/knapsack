# AGENTS.md — Knapsack Development Rules

This file governs all AI agent work in this repository. Read it in full before making changes.

## Conversational Style

- Keep answers short and concise. Technical prose only.
- No emojis in commits, issues, PR comments, or code.
- No fluff or cheerful filler ("Thanks!" → omit; "Great question!" → omit).
- When asked a question, answer it first before editing or running commands.
- When responding to feedback, explicitly state whether you agree or disagree before describing changes.

## Think Before Coding

- State assumptions explicitly. If uncertain, ask — do not guess silently.
- If multiple interpretations exist, present them. Do not pick one without acknowledging the others.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what is confusing. Ask.

## Simplicity First

- Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked.
- No abstractions for code with a single call site. Inline single-use helpers.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you wrote 200 lines and it could be 50, rewrite it.

## Surgical Changes

- Touch only what you must. Do not "improve" adjacent code, comments, or formatting.
- Do not refactor unrelated code. Keep changes scoped to the request.
- Respect existing worktree changes. Do not revert user changes unless explicitly asked.
- Prefer editing existing files over creating new files.
- Do not add documentation files unless requested.

## Evidence Rule

Never assert that a function, module, behavior, or pattern exists without proof.
Every claim about the codebase must be backed by the exact file path and line number,
or a code snippet from the source. If evidence cannot be produced, say so explicitly.
Do not present the claim as fact.

## Code Quality

- Read files in full before wide-ranging changes. Do not rely on search snippets for broad edits.
- No `any` unless absolutely necessary. Prefer unknown, generics, or proper types.
- No inline imports (`await import()`, `import("pkg").Type`). Top-level imports only.
- Check `node_modules` for external API types; do not guess.
- Use only erasable TypeScript syntax: no parameter properties, `enum`, `namespace`/`module`,
  `import =`, `export =`, or other constructs needing JS emit.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Do not preserve backward compatibility unless asked.
- Always ask before removing functionality or code that appears intentional.

## Security (Critical for Knapsack)

Knapsack processes untrusted LLM output and writes to the user's filesystem.
Every new code path must respect these rules:

- **No shell interpolation of untrusted input.** Use `execFileSync` with args as an array, never
  `execSync` with string interpolation. See `src/bridge/obsidian.ts` for the pattern.
- **No path joins without validation.** Any path built from LLM input must pass through
  `isPathSafe()` or `sanitizeTitle()`. See `src/bridge/obsidian-notes.ts`.
- **No hash lookups without validation.** Hashes must match `/^[a-f0-9]{1,64}$/`. See
  `src/pillar1-compression/ccr.ts` `isValidHash()`.
- **Parameterized SQL only.** Use `?` placeholders. Never interpolate user content into SQL strings.
- When in doubt, validate input at the boundary (tool entry point), not deep inside.

## Commands

- After code changes (not docs): `npm run check` (biome lint + format). Fix all errors and warnings.
- After code changes: `npm test` (vitest). All 35 tests must pass.
- Never run `npm run build` or `npm run typecheck` unless requested — the lefthook pre-commit
  runs biome + vitest automatically.
- If you create or modify a test file, run it and iterate until it passes.
- For ad-hoc scripts, write them to `/tmp`, run, edit if needed, remove when done. Do not embed
  multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dependency and lockfile changes as reviewed code. Direct deps stay pinned to exact versions.
- Install with `npm install --ignore-scripts`. Do not run lifecycle scripts unless asked.
- Native dependencies (better-sqlite3, tree-sitter) fail on Node 26. Do not add native deps.
  Prefer WASM alternatives (sql.js, regex heuristics).

## Git

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` or `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- Message format: `{feat,fix,test,docs,chore,refactor}[(v0.1,v0.2,security)]: <message>`.
  Message is informative and concise, lowercase, imperative mood.
- Pre-commit hooks (biome + vitest + commitlint) must pass. Never use `--no-verify`.

Never run (destroys work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`
- `git add -A`, `git add .`, `git commit --no-verify`
- `git push --force`

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.

## Repository Structure

```
src/
├── index.ts                  # Extension entry point — wires hooks + tools + commands
├── system-prompt.ts          # Auto-injected guidance (XML, Anthropic-style)
├── core/                     # Database, hashing, token estimation, types
├── pillar1-compression/      # Token reduction
│   ├── plugin.ts             # StrategyRegistry + CompressionStrategy interface
│   ├── default-registry.ts   # All built-in strategies registered here
│   ├── hook.ts               # tool_result interceptor (compression + drift check)
│   ├── detect.ts             # Content-based auto-routing
│   ├── ccr.ts                # Compress-Cache-Retrieve (~/.knapsack/cache/)
│   └── strategies/           # bash, grep, find, code, json
├── pillar2-memory/           # Persistent memory
│   ├── inject.ts             # before_agent_start — keyword search + BM25 injection
│   ├── observe.ts            # turn_end — auto-save gotchas on failures
│   ├── compaction.ts         # session_before_compact — flush state to memory
│   ├── scoring.ts            # Hybrid BM25 + embeddings scoring
│   ├── embeddings.ts         # Optional @xenova/transformers (384-dim MiniLM)
│   ├── drift.ts              # Decision anchors + violation signal detection
│   └── session-analysis.ts   # /knapsack-learn JSONL session parser
├── tools/                    # 9 custom tools for the LLM
├── commands/                 # /knapsack-status, /knapsack-learn
└── bridge/                   # Obsidian vault: discovery, search, notes
```

## Architecture Constraints

- **Two pillars only.** Pillar 1 = compression. Pillar 2 = memory. Do not mix concerns.
- **Plugin architecture for strategies.** New compression strategies implement
  `CompressionStrategy` and register via `createDefaultRegistry()`. Do not add switch statements
  in the hook — the registry handles routing.
- **Content-based auto-routing.** The registry uses `detectContentType()` to route outputs.
  No tool-name mapping needed — works with any pi tool.
- **Idempotency required.** Every write operation must be safe to retry. Memory uses UPSERT by
  `content_hash`. Compression uses `INSERT OR IGNORE` by `original_hash`. CCR checks file
  existence before writing. `writeNote()` checks content before appending.
- **sql.js (WASM) only.** No native SQLite bindings. FTS5 may not be available — LIKE fallback.
- **Embeddings are optional.** `@xenova/transformers` is an optionalDependency. `isAvailable()`
  flag controls hybrid vs BM25-only scoring. Never hard-depend on embeddings.
- **CCR cache in ~/.knapsack/cache/, not vault.** Vault is for human notes.
  `knapsack_note` writes to vault root. No frontmatter. Wikilinks inline.
- **Memory pruning.** On session_shutdown, entries older than 30 days with importance < 0.3
  and access_count <= 1 are pruned.
- **Unified search.** `knapsack_search` searches both memory DB and Obsidian vault.
  No separate search paths for the model.
- **DB saves are debounced.** 2s debounce, `saveNow()` on close. Not per-write.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `KNAPSACK_HOME` | `~/.knapsack` | Database, CCR cache, and config directory |
| `KNAPSACK_OBSIDIAN_VAULT` | auto-discovered | Explicit Obsidian vault path override |

Embeddings: install `@xenova/transformers sharp` to enable. No env var — package presence is the toggle.

## Testing

- Unit tests in `test/compress/` cover individual strategies.
- Benchmarks in `test/bench/` verify realistic-scale compression with signal preservation checks.
- Run `npm test` before any commit. 35 tests must pass.
- When adding a compression strategy, add both unit tests and a benchmark.

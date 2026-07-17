# Contributing to Knapsack

Thanks for your interest. Knapsack is an open-source token-reduction and memory layer for the [Pi coding agent](https://pi.dev). It is designed to be developed and reviewed by AI agents as well as humans — that shapes a lot of the conventions below.

## Setup

```bash
git clone git@github.com:acidsugarx/knapsack.git
cd knapsack
npm install           # auto-installs lefthook pre-commit + commit-msg hooks
npm test              # vitest — 77 tests, all must pass
npm run check         # biome lint + format
```

Requirements:

- Node 18+ (Knapsack uses only WASM / pure-JS deps — no native compilation, no `node-gyp`).
- `pi` installed globally if you want to test the extension end-to-end.

## Development loop

```bash
# 1. Load knapsack as a dev extension in pi (auto-discovers from src/index.ts):
pi -e ./src/index.ts --approve

# 2. Make changes under src/*.ts.

# 3. Reload pi to pick them up — type /reload in pi.

# 4. Verify the footer shows "🎒 ready" (or "🎒 (no vault)").
#    Trigger a large tool output (find / grep / read) and check the footer
#    for "📦 X% smaller · hash Y".

# 5. Run tests before committing:
npm test && npm run check

# 6. Commit — pre-commit hooks run biome + vitest automatically.
git commit -m "feat(v0.3): add new compression strategy"
```

To benchmark end-to-end Pi sessions:

```bash
# Clone a large repo as the test target (one-time):
git clone --depth 1 https://github.com/torvalds/linux.git /tmp/linux

# Run a scenario:
BENCH_WORKDIR=/tmp/linux scripts/bench-pi.sh scripts/bench-prompts/m_find.txt
```

`scripts/bench-pi.sh` clears knapsack state, runs the prompt twice (baseline + with extension), and reports median billed tokens across N runs.

## Pre-commit hooks

On `npm install`, lefthook installs:

| Hook | What runs |
|---|---|
| `pre-commit` | `biome check` (lint + format) + `vitest run` |
| `commit-msg` | `commitlint` (conventional commits) |

Never bypass with `--no-verify` — if a hook is genuinely broken, fix it in `lefthook.yml` first.

## Project structure

```
src/
├── index.ts                      # Extension entry — wires hooks + tools + commands
├── system-prompt.ts              # Auto-injected guidance (cache-stable bytes)
├── core/                         # Database, hashing, tokens, security, types
│   ├── database.ts               # SQLite via sql.js, saveMemory with auto-merge, consolidateMemories
│   ├── security.ts               # detectSecrets + redactSecrets
│   └── ...
├── pillar1-compression/          # Token reduction
│   ├── hook.ts                   # tool_result interceptor (compress → tag-restore → redact)
│   ├── plugin.ts                 # CompressionStrategy + StrategyRegistry interfaces
│   ├── default-registry.ts       # Built-in strategies registered here
│   ├── detect.ts                 # Content-type auto-routing
│   ├── adaptive-sizer.ts         # Kneedle algorithm for find/grep sizing
│   ├── tag-protector.ts          # XML/custom tag placeholder swap
│   ├── tree-sitter-loader.ts     # Lazy grammar loader (WASM)
│   ├── ccr.ts                    # Compress-Cache-Retrieve (~/.knapsack/cache)
│   └── strategies/               # bash, find, grep, json, code, code-ast, diff
├── pillar2-memory/               # Persistent memory
│   ├── inject.ts                 # before_agent_start — memory block injection
│   ├── observe.ts                # turn_end — auto-save gotchas on failures
│   ├── compaction.ts             # session_before_compact — flush state
│   ├── scoring.ts                # Hybrid BM25 + embeddings + frecency + smart-case
│   ├── embeddings.ts             # Optional @xenova/transformers
│   ├── drift.ts                  # Decision anchors + violation detection
│   └── session-analysis.ts       # /knapsack-learn JSONL parser
├── tools/                        # 9 tools registered with Pi
├── commands/                     # /knapsack-status, /knapsack-learn, /knapsack-consolidate
└── bridge/                       # Obsidian vault: discovery, search, notes, frontmatter

scripts/
├── bench-pi.sh                   # End-to-end Pi session bench runner
└── bench-prompts/                # Canonical scenarios from the README table

test/
├── compress/                     # Strategy + transform unit tests
├── memory/                       # DB, consolidation, frontmatter, scoring tests
└── bench/                        # Strategy benchmarks (compression ratios)
```

Two pillars are kept strictly separate. Do not import from `pillar2-memory` inside `pillar1-compression` or vice versa without a very good reason.

## Code style

- TypeScript strict mode. No `any` unless absolutely necessary; prefer `unknown`, generics, or proper types.
- No inline imports (`await import(...)`, `import("pkg").Type`). Top-level imports only.
- Only erasable TypeScript syntax — no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`.
- Biome for lint + format: `npm run fix`.
- Tests with vitest: `npm test`. All tests must pass before merge.

## Documentation (must-have)

Inline documentation is a **hard review gate**, not a polish step. The codebase is read by AI agents on every session — stale or missing docs are actively harmful.

- Every exported symbol (function, class, interface, type, constant) has a JSDoc block.
- Every parameter is documented with `@param <name> - ...` — name must match the code exactly.
- Every non-void return is documented with `@returns ...` — including `null` / `undefined` arms and `Promise<T>` wrappers (write the inner `T`).
- Every `.ts` file has a `@module <name>` block at the top.
- JSDoc reflects current behaviour — when you change a contract, signature, or return shape, update the doc in the same commit.
- Non-trivial private helpers get at least a one-line summary.
- Hooks and lifecycle handlers (`pi.on(...)`, `registerTool`, `registerCommand`) explain when they fire and what they mutate.

Exceptions need an explicit `// intentionally undocumented because ...` comment on the same symbol.

## Security (critical)

Knapsack processes untrusted LLM output and writes to the user's filesystem. Every new code path must respect:

- **No shell interpolation of untrusted input.** Use `execFileSync` with args as an array, never `execSync` with string interpolation.
- **No path joins without validation.** Any path built from LLM input must pass through `isPathSafe()` or `sanitizeTitle()`. See `src/bridge/obsidian-notes.ts` for the pattern.
- **Parameterized SQL only.** `?` placeholders, never interpolate user content into SQL strings.
- **Hash validation.** Hashes from the model must match `/^[a-f0-9]{1,64}$/`.

When in doubt, validate input at the boundary (tool entry point), not deep inside.

## Adding a compression strategy

1. Create `src/pillar1-compression/strategies/<type>.ts`. Export a `compress<Type>(output: string): CompressionResult | null` function (or async if it loads resources like tree-sitter).
2. Register it in `src/pillar1-compression/default-registry.ts`:
   ```ts
   registry.register({
     name: "<type>",
     label: "<Human Label>",
     contentTypes: ["<type>"],
     threshold: 1000,                    // min tokens before strategy fires
     compress(output) { return compress<Type>(output); },
   });
   ```
3. Add the content-type detector in `src/pillar1-compression/detect.ts` (and register a `ContentDetector` in `default-registry.ts`).
4. Add unit tests under `test/compress/<type>.test.ts` — cover happy path, empty input, malformed input, signal preservation.
5. Add a benchmark entry in `test/bench/compression.bench.ts`.
6. Update the README strategies table and `CHANGELOG.md`.

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint:

```
feat(v0.3): add git diff compression strategy
fix(v0.2): return compressionHook result from tool_result handler
docs: README v0.3 numbers + reproducible bench
test: regression for hook return contract
chore(v0.3): bump version to 0.3.0
```

Use `feat`/`fix`/`docs`/`test`/`chore`/`refactor`. Optional scope: `(v0.2)`, `(v0.3)`, `(security)`, etc. Lowercase, imperative mood.

## Releases

- Versioning: semver. v0.x is "API still settling", v1.0 will be the first stability promise.
- Every release gets a `CHANGELOG.md` entry with measured impact (token savings, test counts).
- `npm publish` happens manually from `main` after the changelog and version bump land.

## License

[MIT](LICENSE). All contributions are accepted under MIT.

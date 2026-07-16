# Contributing to Knapsack

Thanks for your interest! Knapsack is an open-source token reduction and memory layer for Pi.

## Development setup

```bash
git clone git@github.com:acidsugarx/knapsack.git
cd knapsack

# Install dependencies (auto-installs git hooks via lefthook)
npm install

# Run checks
npm run check      # lint + format (biome)
npm run typecheck  # TypeScript
npm run test       # vitest (12 tests)
```

## Development workflow (for AI agents too)

Knapsack is designed to be developed by AI agents. Here's the loop:

```bash
# 1. Start pi with knapsack loaded
npm run dev
# or: make dev
# or: pi --approve
# (auto-discovery from .pi/extensions/knapsack/)

# 2. Agent makes changes to src/*.ts

# 3. Reload pi to pick up changes
#    Type /reload in pi

# 4. Verify changes work — check footer for "🎒 ready"
#    Run a large grep to trigger compression
#    /knapsack-status

# 5. Run tests before committing
npm test

# 6. Commit (pre-commit hooks run biome + vitest automatically)
git commit -m "feat: ..."
```

## Testing with Pi

```bash
# From the knapsack directory, pi auto-discovers the extension:
pi --approve

# Or explicitly:
pi -e ./src/index.ts

# Then in Pi, verify:
# - Footer shows "🎒 ready" (or "🎒 (no vault)")
# - /knapsack-status
# - Run `grep -r "something" .` to trigger compression
# - knapsack_search("test") to test memory
```

## Pre-commit hooks

On `npm install`, lefthook installs git hooks:

| Hook | What runs |
|---|---|
| `pre-commit` | biome check (lint + format) + vitest run |
| `commit-msg` | commitlint (conventional commits) |

To skip hooks temporarily: `git commit --no-verify`

## Project structure

```
src/
├── index.ts                  # Extension entry point
├── core/                     # Database, hashing, token estimation
├── pillar1-compression/      # Token reduction
│   ├── hook.ts               # tool_result interceptor
│   ├── strategies/           # Compression algorithms per content type
│   ├── thresholds.ts         # When to compress
│   └── ccr.ts                # Compress-Cache-Retrieve
├── pillar2-memory/           # Persistent memory
│   ├── inject.ts             # before_agent_start memory injection
│   ├── observe.ts            # turn_end auto-learning
│   └── compaction.ts         # session_before_compact handler
├── tools/                    # Custom tools for the LLM
├── commands/                 # Slash commands
└── bridge/                   # Obsidian vault integration
```

## Code style

- TypeScript with strict mode
- JSDoc on all exported functions (this is an LLM-facing tool — the docstrings are part of the interface)
- Biome for linting and formatting: `npm run fix`
- Tests with vitest: `npm test`

## Adding a compression strategy

1. Create `src/pillar1-compression/strategies/<type>.ts`
2. Export a function: `compress<Tool>(output: string): CompressionResult`
3. Add the strategy mapping in `thresholds.ts` > `TOOL_STRATEGY`
4. Add the dispatch case in `hook.ts`
5. Add tests in `test/compress/`

## Commit conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add tree-sitter code compression strategy
fix: handle FTS5 query syntax errors gracefully
docs: add architecture decision record for CCR
```

## License

MIT — same as the project. All contributions are under MIT.

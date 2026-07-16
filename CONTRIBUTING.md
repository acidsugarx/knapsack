# Contributing to Knapsack

Thanks for your interest! Knapsack is an open-source token reduction and memory layer for Pi.

## Development setup

```bash
git clone git@github.com:acidsugarx/knapsack.git
cd knapsack

# Install dependencies
npm install

# Run checks
npm run check      # lint + format (biome)
npm run typecheck  # TypeScript
npm run test       # vitest
```

## Testing with Pi

```bash
# From the knapsack directory:
pi -e ./src/index.ts

# Then in Pi, verify it loaded:
# - Check footer for "🎒 ready"
# - Run a large grep to trigger compression
# - Try /knapsack-status
```

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

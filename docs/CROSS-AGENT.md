# Knapsack Cross-Agent Architecture

Knapsack is a token reduction and persistent memory tool that works across multiple coding agents. This document describes the architecture for supporting Pi, Claude Code, OpenCode, and any MCP-compatible agent.

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │          @knapsack/core                 │
                    │  (pure logic, zero agent deps)          │
                    │                                         │
                    │  Compression:  strategies, pipeline,    │
                    │                CCR, cache, image, tags  │
                    │  Memory:       inject, scoring, drift   │
                    │  Bridge:       Obsidian vault           │
                    │  Core:         database, hash, tokens   │
                    └──────────────┬──────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
   ┌──────────▼─────────┐  ┌──────▼───────┐  ┌────────▼─────────┐
   │  Pi adapter        │  │ MCP server   │  │ Claude adapter   │
   │  (src/index.ts)    │  │ (adapters/   │  │ (adapters/       │
   │                    │  │  mcp/)       │  │  claude/)        │
   │  tool_result       │  │              │  │  PostToolUse     │
   │  context           │  │  8 tools:    │  │  hook            │
   │  before_agent_start│  │  search,     │  │                  │
   │  turn_end          │  │  save,       │  │  + bundled MCP   │
   │  session_*         │  │  retrieve,   │  │    for tools     │
   │                    │  │  stats, ...  │  │                  │
   └────────────────────┘  └──────┬───────┘  └──────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  OpenCode adapter       │
                    │  (adapters/opencode/)   │
                    │                         │
                    │  tool.execute.after     │
                    │  system.transform       │
                    │  session.compacting     │
                    │  + native tools         │
                    └─────────────────────────┘
```

## Three Layers

### 1. Core (`src/core/`)

Agent-agnostic logic with zero dependencies on any coding agent's API. All strategies, pipeline, memory, CCR, drift detection, and Obsidian bridge live here.

**Key exports** (`src/core/index.ts`):
- `compress()` — full compression pipeline (cache → secrets → images → tags → strategy → CCR → stats → drift)
- `injectMemory()` — search + format memory block for system prompt injection
- `createDefaultRegistry()` — strategy registry with all built-in strategies
- `OutputCache`, `outputCache` — LRU cache for compression outputs
- `redactImages()` — base64 image data URI redaction
- `checkDrift()`, `formatDriftReport()` — drift detection
- `retrieve()` — CCR cache retrieval
- All strategies: `compressBash`, `compressGrep`, `compressFind`, `compressJson`, `compressCode`, `compressCodeAST`, `compressDiff`

### 2. Adapters (`src/adapters/`)

Thin wrappers that wire agent-specific hooks to the core pipeline.

| Adapter | Location | Hook used for compression | Hook used for memory | Custom tools via |
|---------|----------|--------------------------|---------------------|-----------------|
| Pi | `src/index.ts` | `tool_result` | `before_agent_start` | `pi.registerTool()` |
| Claude Code | `src/adapters/claude/` | `PostToolUse` (shell hook) | `UserPromptSubmit` | MCP server |
| OpenCode | `src/adapters/opencode/` | `tool.execute.after` | `experimental.chat.system.transform` | `tool()` helper |
| MCP (universal) | `src/adapters/mcp/` | N/A (tools only) | N/A | MCP `tools/call` |

### 3. MCP Server (`src/adapters/mcp/`)

Universal tool access for any MCP-compatible agent. Provides 8 tools: `knapsack_search`, `knapsack_save`, `knapsack_retrieve`, `knapsack_forget`, `knapsack_stats`, `knapsack_anchor`, `knapsack_drift`, `knapsack_note`.

## Installation per Agent

### Pi (current, unchanged)

```bash
pi install npm:knapsack-pi
```

### Claude Code

1. Install the npm package:
```bash
npm install -g knapsack-pi
```

2. Add the PostToolUse hook to `.claude/settings.json`:
```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Bash|Read|Grep|Glob",
      "hooks": [{
        "type": "command",
        "command": "npx tsx $(npm root -g)/knapsack-pi/src/adapters/claude/compress-hook.ts"
      }]
    }]
  }
}
```

3. Add the MCP server for tools (in `.claude/settings.json` or `~/.claude/claude_config.json`):
```json
{
  "mcpServers": {
    "knapsack": {
      "command": "npx",
      "args": ["tsx", "$(npm root -g)/knapsack-pi/src/adapters/mcp/index.ts"]
    }
  }
}
```

### OpenCode

Add to `opencode.json`:
```json
{
  "plugin": {
    "knapsack": "npm:knapsack-pi"
  }
}
```

Or for local development:
```json
{
  "plugin": {
    "knapsack": "./src/adapters/opencode/plugin.ts"
  }
}
```

### Any MCP-compatible agent (Cursor, Continue, Cline, etc.)

Add the knapsack MCP server to the agent's MCP configuration:
```json
{
  "mcpServers": {
    "knapsack": {
      "command": "npx",
      "args": ["tsx", "path/to/knapsack/src/adapters/mcp/index.ts"]
    }
  }
}
```

Note: MCP-only agents get tools (search, save, retrieve, etc.) but NOT automatic compression. Compression requires agent-specific hooks.

## Feature Matrix

| Feature | Pi | Claude Code | OpenCode | MCP-only agents |
|---------|-----|-------------|----------|-----------------|
| Tool result compression | ✅ | ✅ | ✅ | ❌ |
| Output compression | ✅ | ❌ | ✅ | ❌ |
| Memory injection | ✅ | ⚠️ (UserPromptSubmit) | ✅ | ❌ |
| Compaction | ✅ | ✅ | ✅ | ❌ |
| Auto-observation | ✅ | ✅ | ✅ | ❌ |
| Custom tools | ✅ | ✅ (MCP) | ✅ (native) | ✅ (MCP) |
| CCR retrieval | ✅ | ✅ (MCP) | ✅ (native) | ✅ (MCP) |
| Drift detection | ✅ | ✅ (MCP) | ✅ (native) | ✅ (MCP) |
| Obsidian integration | ✅ | ✅ (MCP) | ✅ (native) | ✅ (MCP) |

## Adding a New Adapter

1. Create `src/adapters/<agent>/` with the adapter file
2. Import from `../../core/pipeline` for compression
3. Import from `../../core/memory` for memory injection
4. Wire the agent's hook API to the core functions
5. Write a manual test script in `scripts/test-<agent>.sh`
6. Update this document

Pattern for a compression hook:
```typescript
import { compress } from "../../core/pipeline";

async function onToolResult(toolName: string, text: string, path?: string) {
  const result = await compress({ text, toolName, path, db, store, registry });
  if (result) {
    return result.content.map(b => b.text).join("");
  }
  return text; // passthrough
}
```

## Testing

```bash
# Automatic tests (vitest)
npm test

# Manual tests (per adapter)
bash scripts/test-core.sh      # Core compression pipeline
bash scripts/test-claude.sh    # Claude Code PostToolUse hook
bash scripts/test-mcp.sh       # MCP server (list, stats, save, search)
```

## Manual Test Results (2026-07-22)

```
=== Core Pipeline ===
  find (400 files):  2712 →  208 tokens (92%)
  grep (100 matches): 1708 →   69 tokens (96%)
  bash (build output): 4407 →   36 tokens (99%)
  json (200 items):   2424 →  139 tokens (94%)

=== Claude Code Adapter ===
  ✅ PostToolUse hook returns updatedToolOutput
  ✅ Compressed output contains savings footer
  ✅ Compressed output retains file structure

=== MCP Server ===
  ✅ tools/list returns all 8 knapsack tools
  ✅ knapsack_stats returns stats
  ✅ knapsack_save saves memory
  ✅ knapsack_search finds saved memory
```

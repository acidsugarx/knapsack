#!/usr/bin/env bash
# Manual test: Knapsack Claude Code adapter (PostToolUse hook)
#
# Simulates what Claude Code sends to a PostToolUse hook and verifies
# the compression pipeline returns a valid updatedToolOutput.
#
# Usage:
#   bash scripts/test-claude.sh

set -euo pipefail

echo "=== Knapsack Claude Code Adapter Test ==="
echo ""

# Generate a large tool output that exceeds the find strategy threshold (500 tokens)
LARGE_OUTPUT=$(for i in $(seq 1 400); do echo "./src/module_${i}/file.c"; done)

# Simulate Claude Code's PostToolUse event JSON (properly escaped)
EVENT=$(python3 -c "
import json, sys
lines = ['./src/module_{}/file.c'.format(i) for i in range(400)]
text = '\n'.join(lines)
event = {
    'tool_name': 'Bash',
    'tool_input': {'command': 'find . -name *.c'},
    'tool_response': {'content': [{'type': 'text', 'text': text}]}
}
print(json.dumps(event))
")

echo "1. Sending PostToolUse event with 400-line find output..."
RESULT=$(echo "$EVENT" | KNAPSACK_HOME="/tmp/knapsack-claude-test" npx tsx src/adapters/claude/compress-hook.ts 2>/dev/null || true)

if [ -z "$RESULT" ]; then
  echo "   ❌ Hook returned empty response"
  exit 1
fi

echo "2. Parsing response..."
if echo "$RESULT" | grep -q "updatedToolOutput"; then
  echo "   ✅ Response contains updatedToolOutput"
else
  echo "   ❌ Response does not contain updatedToolOutput"
  echo "   Response: $RESULT"
  exit 1
fi

if echo "$RESULT" | grep -q "smaller"; then
  echo "   ✅ Compressed output contains savings footer"
else
  echo "   ❌ Compressed output missing footer"
  exit 1
fi

if echo "$RESULT" | grep -q "module_0"; then
  echo "   ✅ Compressed output retains file structure"
else
  echo "   ⚠️  Compressed output may have lost structure (check manually)"
fi

echo ""
echo "=== Claude Code adapter test passed ==="

# Cleanup
rm -rf /tmp/knapsack-claude-test

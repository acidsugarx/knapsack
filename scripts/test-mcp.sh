#!/usr/bin/env bash
# Manual test: Knapsack MCP server via stdio
#
# Verifies the MCP server responds to tools/list and tools/call.
#
# Usage:
#   bash scripts/test-mcp.sh

set -euo pipefail

echo "=== Knapsack MCP Server Test ==="
echo ""

# Test 1: List tools
echo "1. Listing tools..."
LIST_RESPONSE=$(echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
  KNAPSACK_HOME="/tmp/knapsack-mcp-test" npx tsx src/adapters/mcp/index.ts 2>/dev/null || true)

if echo "$LIST_RESPONSE" | grep -q "knapsack_search"; then
  echo "   ✅ knapsack_search tool found"
else
  echo "   ❌ knapsack_search tool NOT found"
  echo "   Response: $LIST_RESPONSE"
  exit 1
fi

if echo "$LIST_RESPONSE" | grep -q "knapsack_save"; then
  echo "   ✅ knapsack_save tool found"
else
  echo "   ❌ knapsack_save tool NOT found"
  exit 1
fi

if echo "$LIST_RESPONSE" | grep -q "knapsack_stats"; then
  echo "   ✅ knapsack_stats tool found"
else
  echo "   ❌ knapsack_stats tool NOT found"
  exit 1
fi

echo ""
echo "2. Calling knapsack_stats..."
STATS_RESPONSE=$(echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"knapsack_stats","arguments":{}}}' | \
  KNAPSACK_HOME="/tmp/knapsack-mcp-test" npx tsx src/adapters/mcp/index.ts 2>/dev/null || true)

if echo "$STATS_RESPONSE" | grep -q "Knapsack"; then
  echo "   ✅ Stats returned successfully"
else
  echo "   ❌ Stats call failed"
  echo "   Response: $STATS_RESPONSE"
  exit 1
fi

echo ""
echo "3. Saving a memory..."
SAVE_RESPONSE=$(echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"knapsack_save","arguments":{"content":"test memory from MCP","type":"fact"}}}' | \
  KNAPSACK_HOME="/tmp/knapsack-mcp-test" npx tsx src/adapters/mcp/index.ts 2>/dev/null || true)

if echo "$SAVE_RESPONSE" | grep -q "Saved"; then
  echo "   ✅ Memory saved successfully"
else
  echo "   ❌ Save failed"
  echo "   Response: $SAVE_RESPONSE"
  exit 1
fi

echo ""
echo "4. Searching memories..."
SEARCH_RESPONSE=$(echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"knapsack_search","arguments":{"query":"test memory"}}}' | \
  KNAPSACK_HOME="/tmp/knapsack-mcp-test" npx tsx src/adapters/mcp/index.ts 2>/dev/null || true)

if echo "$SEARCH_RESPONSE" | grep -q "test memory"; then
  echo "   ✅ Search found the saved memory"
else
  echo "   ❌ Search did not find the memory"
  echo "   Response: $SEARCH_RESPONSE"
  exit 1
fi

echo ""
echo "=== All MCP tests passed ==="

# Cleanup
rm -rf /tmp/knapsack-mcp-test

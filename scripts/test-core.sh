#!/usr/bin/env bash
# Manual test: Knapsack core compression pipeline
#
# Runs the core pipeline directly via a TypeScript script,
# verifying compression works for each strategy type.
#
# Usage:
#   bash scripts/test-core.sh

set -euo pipefail

npx tsx scripts/test-core.ts

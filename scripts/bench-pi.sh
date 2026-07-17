#!/usr/bin/env bash
# bench-pi.sh — end-to-end Pi session benchmark for Knapsack token savings.
#
# Runs a prompt through `pi -p` twice (once without Knapsack, once with the
# local dev extension) and reports billed-token cost for each, plus the
# compression footers emitted by Knapsack.
#
## Usage
#   scripts/bench-pi.sh <prompt-file> [label]
#
## Required env
#   BENCH_WORKDIR — directory the agent will operate in (e.g. a Linux kernel
#                   shallow clone). Must exist.
#
## Optional env (with defaults)
#   PROVIDER=zai                  pi --provider value
#   MODEL=glm-5-turbo             pi --model value
#   KNAPSACK_SRC=src/index.ts     Path to the Knapsack extension entry point,
#                                 relative to repo root. Use this to bench
#                                 an installed npm version instead of dev.
#   OUT_DIR=./bench-runs          Where JSONL + usage JSON are written.
#   RUNS=3                        Repetitions per state (median is reported).
#
## Setup
#   # one-time: clone a large repo for realistic tool outputs
#   git clone --depth 1 https://github.com/torvalds/linux.git /tmp/linux
#   BENCH_WORKDIR=/tmp/linux scripts/bench-pi.sh scripts/bench-prompts/m_find.txt
#
## Metrics
#   billed_tokens = input + cacheRead×0.10 + cacheWrite×1.25  (Anthropic rates)
#   Pi's prefix cache stays hot across turns, so Knapsack's per-turn overhead
#   lands in the cheaper cacheRead bucket while compression shrinks input.
set -euo pipefail

PROMPT_FILE="${1:?prompt file required (try scripts/bench-prompts/m_find.txt)}"
LABEL_BASE="${2:-$(basename "${PROMPT_FILE%.txt}")}"
WORKDIR="${BENCH_WORKDIR:?BENCH_WORKDIR is required (point at a large repo clone)}"
PROVIDER="${PROVIDER:-zai}"
MODEL="${MODEL:-glm-5-turbo}"
KNAPSACK_SRC="${KNAPSACK_SRC:-src/index.ts}"
OUT_DIR="${OUT_DIR:-./bench-runs}"
RUNS="${RUNS:-3}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT_DIR"

if [ ! -f "$REPO_ROOT/$KNAPSACK_SRC" ]; then
	echo "error: $KNAPSACK_SRC not found under $REPO_ROOT" >&2
	exit 1
fi

run_one() {
	local label="$1"
	local with_ext="$2"  # "yes" | "no"
	local raw="$OUT_DIR/$label.raw.jsonl"
	local usage="$OUT_DIR/$label.usage.json"
	local ext_flag=""
	[ "$with_ext" = "yes" ] && ext_flag="-e $REPO_ROOT/$KNAPSACK_SRC"

	# Clear Knapsack state so runs are independent.
	rm -rf "${KNAPSACK_HOME:-$HOME/.knapsack}/cache" "${KNAPSACK_HOME:-$HOME/.knapsack}/memory.db" 2>/dev/null || true

	(
		cd "$WORKDIR"
		pi \
			--provider "$PROVIDER" \
			--model "$MODEL" \
			--thinking off \
			--mode json \
			--no-session \
			-na \
			--exclude-tools use_fast_model,restore_model \
			$ext_flag \
			-p "$(cat "$REPO_ROOT/$PROMPT_FILE")" \
			> "$raw" 2> "$OUT_DIR/$label.stderr.log" || true
	)

	python3 - "$raw" "$label" > "$usage" <<'PY'
import json, sys
raw_path, label = sys.argv[1], sys.argv[2]
agg = {"label": label, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
       "turns": 0, "tool_calls": 0, "retrieve_calls": 0}
for line in open(raw_path):
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    t = e.get("type")
    if t == "message_end":
        m = e.get("message", {})
        u = m.get("usage") or {}
        if m.get("role") == "assistant" and u:
            agg["input"] += u.get("input", 0)
            agg["output"] += u.get("output", 0)
            agg["cacheRead"] += u.get("cacheRead", 0)
            agg["cacheWrite"] += u.get("cacheWrite", 0)
            agg["turns"] += 1
    elif t == "tool_execution_end":
        agg["tool_calls"] += 1
        if e.get("toolName") == "knapsack_retrieve":
            agg["retrieve_calls"] += 1
agg["billed_tokens"] = round(agg["input"] + agg["cacheRead"] * 0.10 + agg["cacheWrite"] * 1.25)
print(json.dumps(agg, indent=2))
PY
}

# --- Run baseline (no Knapsack) ---
echo "=== Baseline (no Knapsack) — $RUNS runs ==="
for i in $(seq 1 "$RUNS"); do
	run_one "${LABEL_BASE}_base_${i}" no
done

# --- Run with Knapsack dev extension ---
echo "=== Knapsack ($KNAPSACK_SRC) — $RUNS runs ==="
for i in $(seq 1 "$RUNS"); do
	run_one "${LABEL_BASE}_ks_${i}" yes
done

# --- Report median billed tokens ---
python3 - "$OUT_DIR" "$LABEL_BASE" "$RUNS" <<'PY'
import json, sys, os
out_dir, label, runs = sys.argv[1], sys.argv[2], int(sys.argv[3])

def billed(d): return d.get("billed_tokens", d["input"] + d["cacheRead"]*0.10 + d["cacheWrite"]*1.25)

base_vals, ks_vals = [], []
base_retrieves, ks_retrieves = [], []
for i in range(1, runs+1):
    bd = json.load(open(f"{out_dir}/{label}_base_{i}.usage.json"))
    fd = json.load(open(f"{out_dir}/{label}_ks_{i}.usage.json"))
    base_vals.append(billed(bd))
    ks_vals.append(billed(fd))
    base_retrieves.append(bd.get("retrieve_calls", 0))
    ks_retrieves.append(fd.get("retrieve_calls", 0))

base_vals.sort(); ks_vals.sort()
base_med = base_vals[runs//2]
ks_med = ks_vals[runs//2]
pct = -(ks_med - base_med) * 100.0 / base_med
print()
print(f"=== {label} ===")
print(f"  baseline billed (median): {base_med:>8.0f}   all: {base_vals}")
print(f"  knapsack billed (median): {ks_med:>8.0f}   all: {ks_vals}")
print(f"  savings: {pct:+.1f}%   (positive = Knapsack wins)")
print(f"  retrieve calls — base: {base_retrieves}, ks: {ks_retrieves}")
PY

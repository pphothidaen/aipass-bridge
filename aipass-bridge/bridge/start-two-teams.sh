#!/bin/bash
# start-two-teams.sh — Start both teams (Brain + Workers) in one command
# Brain: aipass (Claude Sonnet 5) @ :8789
# Workers: 7 Nous models polling /tmp/aipass-tasks/ → /tmp/aipass-results/

set -e

BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
TASKS_DIR="${TASKS_DIR:-/tmp/aipass-tasks}"
RESULTS_DIR="${RESULTS_DIR:-/tmp/aipass-results}"
BRAIN_PORT="${BRAIN_PORT:-8789}"

# Clean up old processes
pkill -f 'brain\.mjs' 2>/dev/null || true
pkill -f 'worker\.mjs' 2>/dev/null || true
sleep 1

# Clean up old task/result files
rm -rf "$TASKS_DIR" "$RESULTS_DIR"
mkdir -p "$TASKS_DIR" "$RESULTS_DIR"

echo "╔══════════════════════════════════════════════╗"
echo "║  Starting Two-Team Autonomous System        ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Tasks:   $TASKS_DIR"
echo "║  Results: $RESULTS_DIR"
echo "╠══════════════════════════════════════════════╣"
echo "║  Team 1: Brain (aipass/Claude Sonnet 5)     ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Team 2: Workers (7 Nous models)            ║"
echo "║    • meituan/longcat-2.0:free (coding)      ║"
echo "║    • upstage/solar-pro-4 (terminal/multi)   ║"
echo "║    • stepfun/step-3.7-flash (vision)        ║"
echo "║    • poolside/laguna-s-2.1 (fast coding)    ║"
echo "║    • poolside/laguna-xs-2.1 (lightweight)   ║"
echo "║    • inclusionai/ling-3.0-flash-fin (fin)   ║"
echo "║    • inclusionai/ling-3.0-flash-sante (med) ║"
echo "╚══════════════════════════════════════════════╝"

# Start workers (7 models, each as separate process)
echo "Starting workers..."
WORK_MODELS=(
  "meituan/longcat-2.0:free"
  "upstage/solar-pro-4"
  "stepfun/step-3.7-flash"
  "poolside/laguna-s-2.1"
  "poolside/laguna-xs-2.1"
  "inclusionai/ling-3.0-flash-fin"
  "inclusionai/ling-3.0-flash-sante"
)

for model in "${WORK_MODELS[@]}"; do
  MODEL="$model" TASKS_DIR="$TASKS_DIR" RESULTS_DIR="$RESULTS_DIR" \
    node "$BRIDGE_DIR/worker.mjs" > "/tmp/worker-${model//\//_}.log" 2>&1 &
  echo "  ✓ worker:$model"
done

# Start brain
echo "Starting brain..."
BRAIN_PORT="$BRAIN_PORT" TASKS_DIR="$TASKS_DIR" RESULTS_DIR="$RESULTS_DIR" \
  node "$BRIDGE_DIR/brain.mjs" > "/tmp/brain.log" 2>&1 &
echo "  ✓ brain @ :$BRAIN_PORT"

sleep 2
echo ""
echo "=== System Running ==="
echo "Test:"
echo "  curl -s -X POST http://127.0.0.1:$BRAIN_PORT/process -H 'Content-Type: application/json' -d '{\"request\":\"read /tmp/test.txt\"}'"
echo ""
echo "Logs:"
echo "  tail -f /tmp/brain.log"
echo "  tail -f /tmp/worker-*.log"
echo ""
echo "Stop:"
echo "  pkill -f 'brain\\.mjs|worker\\.mjs'"

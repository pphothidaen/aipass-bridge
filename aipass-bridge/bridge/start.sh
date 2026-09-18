#!/bin/bash
# start.sh — Start autonomous brain-worker system (ONE command)
# Usage: cd packages/core/aipass-bridge && ./bridge/start.sh

set -e

BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Starting Autonomous Brain-Worker System ==="
echo "Bridge dir: $BRIDGE_DIR"

# Kill existing
pkill -f 'brain\.mjs|worker\.mjs|sqlite-queue' 2>/dev/null || true
sleep 1

# Start workers (one per model)
echo "Starting workers..."
for model in longcat-free solar-pro stepfun laguna-s laguna-xs ling-fin ling-sante; do
  MODEL=$model node "$BRIDGE_DIR/worker.mjs" &
  echo "  ✓ worker:$model"
done

# Start brain
echo "Starting brain..."
node "$BRIDGE_DIR/brain.mjs" &
echo "  ✓ brain"

sleep 1
echo ""
echo "=== System Ready ==="
echo "Test with:"
echo "  curl -s -X POST http://127.0.0.1:8789/process -H 'Content-Type: application/json' -d '{\"request\":\"read package.json and tell me the version\"}'"
echo ""
echo "Stop with:"
echo "  pkill -f 'brain|worker|sqlite'"

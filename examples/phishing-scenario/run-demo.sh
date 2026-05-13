#!/usr/bin/env bash
# Orchestrate the phishing demo in a two-pane tmux session.
#
#   ./run-demo.sh [foreman-home] [foreman-bin]
#
#   foreman-home: optional FOREMAN_HOME override (default: $(mktemp -d))
#   foreman-bin:  optional path to the foreman binary (default: foreman on PATH)
#
# Layout:
#   ┌───────────────────────────────┬───────────────────────────────┐
#   │                               │                               │
#   │  foreman start                │  play.mjs (MCP simulator)     │
#   │  (Ink TUI)                    │                               │
#   │                               │                               │
#   └───────────────────────────────┴───────────────────────────────┘
#
# Run asciinema rec on the OUTER terminal before attaching:
#   asciinema rec --idle-time-limit 2 assets/demo.cast \
#     -c './examples/phishing-scenario/run-demo.sh'

set -euo pipefail

FOREMAN_HOME="${1:-$(mktemp -d -t foreman-demo-XXXXXX)}"
FOREMAN_BIN="${2:-foreman}"
SESSION="foreman-demo"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for the orchestrated layout."
  echo "Install it (brew install tmux / apt install tmux) and rerun."
  exit 1
fi

if ! command -v "$FOREMAN_BIN" >/dev/null 2>&1; then
  if [[ -x "$REPO_ROOT/dist/cli/index.js" ]]; then
    FOREMAN_BIN="$REPO_ROOT/dist/cli/index.js"
  else
    echo "foreman binary not found. Build the repo first: npm run build"
    exit 1
  fi
fi

echo "FOREMAN_HOME=$FOREMAN_HOME"
echo "FOREMAN_BIN=$FOREMAN_BIN"

# Seed identity / db / policy under FOREMAN_HOME.
FOREMAN_HOME="$FOREMAN_HOME" "$FOREMAN_BIN" init >/dev/null

# Drop the sample policy in so the demo has meaningful allow / deny rules.
cp "$REPO_ROOT/examples/policy.yaml" "$FOREMAN_HOME/policy.yaml"

# Kill any previous demo session.
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Pane 1 — Foreman TUI.
tmux new-session -d -s "$SESSION" -x 200 -y 50 \
  "FOREMAN_HOME='$FOREMAN_HOME' '$FOREMAN_BIN' start"

# Pane 2 — play.mjs (after a short delay so the TUI is fully painted).
tmux split-window -h -t "$SESSION" \
  "sleep 1.5 && FOREMAN_HOME='$FOREMAN_HOME' node '$SCRIPT_DIR/play.mjs' --bin '$FOREMAN_BIN'"

tmux select-pane -t "$SESSION:0.0"

tmux attach -t "$SESSION"

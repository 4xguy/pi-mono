#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSION_NAME="pi-subagent-smoke"
MODEL="claude-haiku-4-5"
WIDTH=100
HEIGHT=30
TIMEOUT_SEC=120
KEEP_ARTIFACTS=false
LATEST_LEDGER_FILE=""
LEDGER_MARKER_FILE=""
LEDGER_MARKER_TS=0
SMOKE_WORKER_AGENT="smoke-worker"
SMOKE_COORDINATOR_AGENT="smoke-coordinator"
SMOKE_TOKEN=""
SUBAGENT_EXTENSION_DIR="$REPO_ROOT/.pi/extensions/subagent"
SMOKE_AGENTS_DIR="$REPO_ROOT/.pi/agents"
SMOKE_WORKER_FILE="$SMOKE_AGENTS_DIR/${SMOKE_WORKER_AGENT}.md"
SMOKE_COORDINATOR_FILE="$SMOKE_AGENTS_DIR/${SMOKE_COORDINATOR_AGENT}.md"
CREATED_FILES=()
CREATED_SUBAGENT_EXTENSION_DIR=false

usage() {
  cat <<'EOF'
Usage: scripts/tmux-subagent-smoke.sh [options]

Runs an end-to-end tmux smoke test for nested subagents + shared context ledger.

Options:
  --model <id>          Model ID (default: claude-haiku-4-5)
  --session <name>      tmux session name (default: pi-subagent-smoke)
  --width <cols>        tmux width (default: 100)
  --height <rows>       tmux height (default: 30)
  --timeout <sec>       Wait timeout for test completion (default: 120)
  --keep-artifacts      Keep smoke agent/extension files after test
  -h, --help            Show help
EOF
}

require_tmux() {
  if ! command -v tmux >/dev/null 2>&1; then
    echo "Error: tmux not found in PATH" >&2
    exit 1
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --model)
        MODEL="$2"
        shift 2
        ;;
      --session)
        SESSION_NAME="$2"
        shift 2
        ;;
      --width)
        WIDTH="$2"
        shift 2
        ;;
      --height)
        HEIGHT="$2"
        shift 2
        ;;
      --timeout)
        TIMEOUT_SEC="$2"
        shift 2
        ;;
      --keep-artifacts)
        KEEP_ARTIFACTS=true
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        usage
        exit 1
        ;;
    esac
  done
}

session_exists() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

capture_pane() {
  tmux capture-pane -t "$SESSION_NAME" -e -p -S -400
}

record_created_file() {
  CREATED_FILES+=("$1")
}

ensure_symlink() {
  local src="$1"
  local dst="$2"

  if [[ -L "$dst" && ! -e "$dst" ]]; then
    rm -f "$dst"
  fi

  if [[ ! -e "$dst" ]]; then
    ln -sf "$src" "$dst"
    record_created_file "$dst"
  fi
}

generate_smoke_token() {
  SMOKE_TOKEN="SMOKE_PASS_$(date +%s%N | shasum | cut -c1-10)"
}

create_smoke_resources() {
  if [[ ! -d "$SUBAGENT_EXTENSION_DIR" ]]; then
    CREATED_SUBAGENT_EXTENSION_DIR=true
  fi
  mkdir -p "$SUBAGENT_EXTENSION_DIR" "$SMOKE_AGENTS_DIR"

  ensure_symlink "$REPO_ROOT/packages/coding-agent/examples/extensions/subagent/index.ts" "$SUBAGENT_EXTENSION_DIR/index.ts"
  ensure_symlink "$REPO_ROOT/packages/coding-agent/examples/extensions/subagent/agents.ts" "$SUBAGENT_EXTENSION_DIR/agents.ts"
  ensure_symlink "$REPO_ROOT/packages/coding-agent/examples/extensions/subagent/auto-route.ts" "$SUBAGENT_EXTENSION_DIR/auto-route.ts"
  ensure_symlink "$REPO_ROOT/packages/coding-agent/examples/extensions/subagent/context-memory.ts" "$SUBAGENT_EXTENSION_DIR/context-memory.ts"
  ensure_symlink "$REPO_ROOT/packages/coding-agent/examples/extensions/subagent/guardrails.ts" "$SUBAGENT_EXTENSION_DIR/guardrails.ts"
  ensure_symlink "$REPO_ROOT/packages/coding-agent/examples/extensions/subagent/coordinator-monitor.ts" "$SUBAGENT_EXTENSION_DIR/coordinator-monitor.ts"
  ensure_symlink "$REPO_ROOT/packages/coding-agent/examples/extensions/subagent/coordinator-inspector-state.ts" "$SUBAGENT_EXTENSION_DIR/coordinator-inspector-state.ts"
  ensure_symlink "$REPO_ROOT/packages/coding-agent/examples/extensions/subagent/policy.ts" "$SUBAGENT_EXTENSION_DIR/policy.ts"
  ensure_symlink "$REPO_ROOT/packages/coding-agent/examples/extensions/subagent/phase-gates.ts" "$SUBAGENT_EXTENSION_DIR/phase-gates.ts"
  ensure_symlink "$REPO_ROOT/packages/coding-agent/examples/extensions/subagent/worktree.ts" "$SUBAGENT_EXTENSION_DIR/worktree.ts"

  cat > "$SMOKE_WORKER_FILE" <<EOF
---
name: ${SMOKE_WORKER_AGENT}
description: Worker for tmux smoke testing
tools: read, grep, find, ls
model: claude-haiku-4-5
---

Return exactly: ${SMOKE_TOKEN}
EOF

  cat > "$SMOKE_COORDINATOR_FILE" <<EOF
---
name: ${SMOKE_COORDINATOR_AGENT}
description: Coordinator for tmux smoke testing
tools: subagent
model: claude-haiku-4-5
---

You must call the subagent tool exactly once in single mode with agent "${SMOKE_WORKER_AGENT}".
Pass through the user task as-is.
Always set:
- agentScope: "project"
- confirmProjectAgents: false
- contextMode: "shared-read"
- sharedContextLimit: 8

Hard rule: never answer from your own knowledge. The run is invalid unless the subagent tool is called exactly once.
If the tool call fails, return exactly: TOOL_CALL_FAILED
After the tool call, return exactly the worker output.
EOF

  record_created_file "$SMOKE_WORKER_FILE"
  record_created_file "$SMOKE_COORDINATOR_FILE"
}

start_tmux() {
  if session_exists; then
    tmux kill-session -t "$SESSION_NAME"
  fi

  tmux new-session -d -s "$SESSION_NAME" -x "$WIDTH" -y "$HEIGHT"
  tmux send-keys -t "$SESSION_NAME" "cd '$REPO_ROOT' && ./pi-test.sh --model '$MODEL'" Enter
}

wait_for_pi_ready() {
  local start_ts now elapsed pane
  start_ts="$(date +%s)"

  while true; do
    pane="$(capture_pane)"
    if grep -q "memory:auto" <<<"$pane" && grep -q "secrets:block" <<<"$pane"; then
      return 0
    fi

    now="$(date +%s)"
    elapsed=$((now - start_ts))
    if (( elapsed >= 60 )); then
      return 1
    fi
    sleep 2
  done
}

send_smoke_prompt() {
  local prompt="Call the subagent tool exactly once with args: {\"agent\":\"${SMOKE_COORDINATOR_AGENT}\",\"task\":\"Return the worker token exactly\",\"agentScope\":\"project\",\"confirmProjectAgents\":false,\"contextMode\":\"shared-write\",\"sharedContextLimit\":8}. Return only the tool result."
  tmux send-keys -t "$SESSION_NAME" "$prompt" Enter
}

latest_ledger_file() {
  local ledger_dir candidate candidate_mtime
  ledger_dir="$REPO_ROOT/.pi/subagent-memory/runs"

  for candidate in $(ls -1t "$ledger_dir"/*.jsonl 2>/dev/null || true); do
    candidate_mtime="$(stat -f %m "$candidate" 2>/dev/null || echo 0)"
    if (( candidate_mtime < LEDGER_MARKER_TS )); then
      continue
    fi
    if [[ -z "$LEDGER_MARKER_FILE" || "$candidate" != "$LEDGER_MARKER_FILE" ]]; then
      echo "$candidate"
      return
    fi
  done
}

ledger_has_expected_entries() {
  local ledger_file="$1"
  [[ -n "$ledger_file" ]] || return 1
  [[ -f "$ledger_file" ]] || return 1

  grep -q '"type":"dispatch"' "$ledger_file" || return 1
  grep -q "\"agent\":\"${SMOKE_COORDINATOR_AGENT}\"" "$ledger_file" || return 1
  grep -q "\"agent\":\"${SMOKE_WORKER_AGENT}\"" "$ledger_file" || return 1
  grep -q '"type":"observation"' "$ledger_file" || return 1
  grep -q '"type":"decision"' "$ledger_file" || return 1
}

wait_for_completion() {
  local start_ts now elapsed latest pane
  start_ts="$(date +%s)"

  while true; do
    latest="$(latest_ledger_file)"
    pane="$(capture_pane)"

    if ledger_has_expected_entries "$latest" && grep -q "$SMOKE_TOKEN" <<<"$pane" && grep -q "TPS " <<<"$pane"; then
      LATEST_LEDGER_FILE="$latest"
      return 0
    fi

    now="$(date +%s)"
    elapsed=$((now - start_ts))
    if (( elapsed >= TIMEOUT_SEC )); then
      return 1
    fi
    sleep 2
  done
}

verify_ledger() {
  if [[ -z "$LATEST_LEDGER_FILE" || ! -f "$LATEST_LEDGER_FILE" ]]; then
    echo "No verified ledger file found." >&2
    return 1
  fi

  if ! ledger_has_expected_entries "$LATEST_LEDGER_FILE"; then
    echo "Ledger missing expected entries: $LATEST_LEDGER_FILE" >&2
    return 1
  fi

  echo "Ledger verified: $LATEST_LEDGER_FILE"
}

cleanup() {
  if session_exists; then
    tmux kill-session -t "$SESSION_NAME" || true
  fi

  if [[ "$KEEP_ARTIFACTS" == "false" ]]; then
    for file in "${CREATED_FILES[@]}"; do
      rm -f "$file" || true
    done

    if [[ "$CREATED_SUBAGENT_EXTENSION_DIR" == "true" ]]; then
      rmdir "$SUBAGENT_EXTENSION_DIR" 2>/dev/null || true
    fi
  fi
}

main() {
  parse_args "$@"
  require_tmux
  trap cleanup EXIT

  generate_smoke_token
  create_smoke_resources
  start_tmux

  if ! wait_for_pi_ready; then
    echo "Timed out waiting for pi startup readiness." >&2
    echo "Last pane capture:" >&2
    capture_pane >&2
    exit 1
  fi

  LEDGER_MARKER_FILE="$(ls -1t "$REPO_ROOT/.pi/subagent-memory/runs"/*.jsonl 2>/dev/null | head -n 1 || true)"
  LEDGER_MARKER_TS="$(date +%s)"

  send_smoke_prompt

  if ! wait_for_completion; then
    echo "Timed out waiting for completion (timeout=${TIMEOUT_SEC}s)." >&2
    echo "Last pane capture:" >&2
    capture_pane >&2
    echo "Latest ledger candidate: $(latest_ledger_file)" >&2
    exit 1
  fi

  verify_ledger

  echo "tmux smoke test passed."
  echo "model: $MODEL"
  echo "session: $SESSION_NAME"
  echo "repo: $REPO_ROOT"
}

main "$@"

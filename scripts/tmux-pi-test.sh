#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSION_NAME="pi-test"
WIDTH=100
HEIGHT=30
MODEL="claude-haiku-4-5"

print_help() {
  cat <<'EOF'
Usage: scripts/tmux-pi-test.sh <command> [options]

Commands:
  start                 Start tmux session and launch pi
  send "<text>"         Send prompt + Enter to tmux session
  key <tmux-key>        Send key to tmux session (e.g. Escape, C-o)
  capture [--lines N]   Capture tmux pane output (default last 200 lines)
  stop                  Kill tmux session
  status                Show whether session exists

Options for start:
  --session <name>      Session name (default: pi-test)
  --width <cols>        Terminal width (default: 100)
  --height <rows>       Terminal height (default: 30)
  --model <id>          Model to run (default: claude-haiku-4-5)

Examples:
  scripts/tmux-pi-test.sh start --model claude-haiku-4-5
  scripts/tmux-pi-test.sh send "Use scout to list top-level files"
  scripts/tmux-pi-test.sh capture
  scripts/tmux-pi-test.sh key C-o
  scripts/tmux-pi-test.sh stop
EOF
}

require_tmux() {
  if ! command -v tmux >/dev/null 2>&1; then
    echo "Error: tmux not found in PATH." >&2
    exit 1
  fi
}

session_exists() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

parse_start_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
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
      --model)
        MODEL="$2"
        shift 2
        ;;
      --help|-h)
        print_help
        exit 0
        ;;
      *)
        echo "Unknown option for start: $1" >&2
        exit 1
        ;;
    esac
  done
}

cmd_start() {
  parse_start_args "$@"
  require_tmux

  if session_exists; then
    echo "Session '$SESSION_NAME' already exists."
    return
  fi

  tmux new-session -d -s "$SESSION_NAME" -x "$WIDTH" -y "$HEIGHT"
  tmux send-keys -t "$SESSION_NAME" "cd '$REPO_ROOT' && ./pi-test.sh --model '$MODEL'" Enter
  echo "Started session '$SESSION_NAME' (${WIDTH}x${HEIGHT}) with model '$MODEL'."
}

cmd_send() {
  require_tmux
  if [[ $# -lt 1 ]]; then
    echo "send requires text argument" >&2
    exit 1
  fi
  if ! session_exists; then
    echo "Session '$SESSION_NAME' does not exist." >&2
    exit 1
  fi
  tmux send-keys -t "$SESSION_NAME" "$1" Enter
}

cmd_key() {
  require_tmux
  if [[ $# -lt 1 ]]; then
    echo "key requires a tmux key name" >&2
    exit 1
  fi
  if ! session_exists; then
    echo "Session '$SESSION_NAME' does not exist." >&2
    exit 1
  fi
  tmux send-keys -t "$SESSION_NAME" "$1"
}

cmd_capture() {
  require_tmux
  local lines=200

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --lines)
        lines="$2"
        shift 2
        ;;
      *)
        echo "Unknown option for capture: $1" >&2
        exit 1
        ;;
    esac
  done

  if ! session_exists; then
    echo "Session '$SESSION_NAME' does not exist." >&2
    exit 1
  fi
  tmux capture-pane -t "$SESSION_NAME" -e -p -S "-$lines"
}

cmd_stop() {
  require_tmux
  if session_exists; then
    tmux kill-session -t "$SESSION_NAME"
    echo "Stopped session '$SESSION_NAME'."
  else
    echo "Session '$SESSION_NAME' does not exist."
  fi
}

cmd_status() {
  require_tmux
  if session_exists; then
    echo "Session '$SESSION_NAME' exists."
  else
    echo "Session '$SESSION_NAME' does not exist."
  fi
}

main() {
  if [[ $# -lt 1 ]]; then
    print_help
    exit 1
  fi

  local command="$1"
  shift

  case "$command" in
    start)
      cmd_start "$@"
      ;;
    send)
      cmd_send "$@"
      ;;
    key)
      cmd_key "$@"
      ;;
    capture)
      cmd_capture "$@"
      ;;
    stop)
      cmd_stop
      ;;
    status)
      cmd_status
      ;;
    --help|-h|help)
      print_help
      ;;
    *)
      echo "Unknown command: $command" >&2
      print_help
      exit 1
      ;;
  esac
}

main "$@"

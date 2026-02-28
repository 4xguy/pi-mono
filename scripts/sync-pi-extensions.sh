#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SOURCE_DIR="${PI_EXT_SOURCE_DIR:-$REPO_ROOT/.pi/extensions-source}"
GLOBAL_DIR="${PI_EXT_GLOBAL_DIR:-$HOME/.pi/agent/extensions}"
PROJECT_LOADED_DIR="$REPO_ROOT/.pi/extensions"

DRY_RUN=false
USE_DELETE=true
COMMAND="status"

usage() {
  cat <<'EOF'
sync-pi-extensions.sh

Sync pi extension files between:
- project source: .pi/extensions-source (non-loaded)
- global runtime: ~/.pi/agent/extensions (loaded)

Usage:
  ./scripts/sync-pi-extensions.sh [status|push|pull] [--dry-run] [--no-delete]

Commands:
  status   Show sync status (default)
  push     Sync source -> global
  pull     Sync global -> source

Flags:
  --dry-run    Show what would change without writing
  --no-delete  Do not delete files missing in source

Environment overrides:
  PI_EXT_SOURCE_DIR=/custom/source
  PI_EXT_GLOBAL_DIR=/custom/global
EOF
}

error() {
  echo "Error: $*" >&2
  exit 1
}

require_dir() {
  local dir="$1"
  local label="$2"
  [[ -d "$dir" ]] || error "$label directory not found: $dir"
}

count_files() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    echo "0"
    return
  fi
  find "$dir" -type f ! -name "README.md" | wc -l | tr -d ' '
}

create_manifest() {
  local dir="$1"
  local manifest="$2"
  : > "$manifest"
  [[ -d "$dir" ]] || return

  while IFS= read -r -d '' file; do
    local rel="${file#"$dir/"}"
    local hash
    hash="$(shasum -a 256 "$file" | awk '{print $1}')"
    printf "%s  %s\n" "$hash" "$rel" >> "$manifest"
  done < <(find "$dir" -type f ! -name "README.md" -print0 | sort -z)
}

print_status() {
  echo "Source:  $SOURCE_DIR"
  echo "Global:  $GLOBAL_DIR"
  echo "Loaded:  $PROJECT_LOADED_DIR"
  echo

  local src_count global_count loaded_count
  src_count="$(count_files "$SOURCE_DIR")"
  global_count="$(count_files "$GLOBAL_DIR")"
  loaded_count="$(count_files "$PROJECT_LOADED_DIR")"

  echo "File counts (excluding README.md):"
  echo "- source: $src_count"
  echo "- global: $global_count"
  echo "- project loaded (.pi/extensions): $loaded_count"
  echo

  if [[ "$loaded_count" != "0" ]]; then
    echo "Warning: project .pi/extensions is not empty."
    echo "This can cause extension conflicts when global extensions are also loaded."
    echo
  fi

  local src_manifest global_manifest
  src_manifest="$(mktemp)"
  global_manifest="$(mktemp)"

  create_manifest "$SOURCE_DIR" "$src_manifest"
  create_manifest "$GLOBAL_DIR" "$global_manifest"

  if diff -q "$src_manifest" "$global_manifest" >/dev/null 2>&1; then
    echo "Status: source and global are in sync."
  else
    echo "Status: source and global differ."
    echo "Run one of:"
    echo "- ./scripts/sync-pi-extensions.sh push"
    echo "- ./scripts/sync-pi-extensions.sh pull"
  fi

  rm -f "$src_manifest" "$global_manifest"
}

sync_dirs() {
  local from="$1"
  local to="$2"
  local label="$3"

  local -a rsync_opts
  rsync_opts=(-a --exclude "README.md")

  if [[ "$USE_DELETE" == "true" ]]; then
    rsync_opts+=(--delete)
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    rsync_opts+=(--dry-run --itemize-changes)
  fi

  mkdir -p "$to"
  echo "$label"
  rsync "${rsync_opts[@]}" "$from/" "$to/"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    status|push|pull)
      COMMAND="$1"
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --no-delete)
      USE_DELETE=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      error "Unknown argument: $1"
      ;;
  esac
done

case "$COMMAND" in
  status)
    require_dir "$SOURCE_DIR" "Source"
    print_status
    ;;
  push)
    require_dir "$SOURCE_DIR" "Source"
    sync_dirs "$SOURCE_DIR" "$GLOBAL_DIR" "Syncing source -> global"
    echo
    print_status
    ;;
  pull)
    require_dir "$GLOBAL_DIR" "Global"
    mkdir -p "$SOURCE_DIR"
    sync_dirs "$GLOBAL_DIR" "$SOURCE_DIR" "Syncing global -> source"
    echo
    print_status
    ;;
  *)
    error "Unsupported command: $COMMAND"
    ;;
esac

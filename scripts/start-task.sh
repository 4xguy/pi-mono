#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
	echo "Error: not inside a git repository" >&2
	exit 1
fi

DEFAULT_BASE_BRANCH="${START_TASK_BASE_BRANCH:-main}"
DEFAULT_BRANCH_TYPE="${START_TASK_TYPE:-feat}"
UPSTREAM_REMOTE="${START_TASK_UPSTREAM_REMOTE:-upstream}"
ORIGIN_REMOTE="${START_TASK_ORIGIN_REMOTE:-origin}"

BRANCH_TYPE="$DEFAULT_BRANCH_TYPE"
BASE_BRANCH="$DEFAULT_BASE_BRANCH"
TASK_NAME=""
BRANCH_NAME=""
SYNC_MAIN=true
USE_WORKTREE=true
WORKTREE_BASE="${START_TASK_WORKTREE_BASE:-../$(basename "$REPO_ROOT")-worktrees}"
WORKTREE_PATH=""

usage() {
	cat <<'EOF'
Usage: scripts/start-task.sh [options] <task-name>

Creates a task branch from main and (by default) a dedicated git worktree.
Run from repo root (or any subdirectory) while on main with a clean working tree.

Options:
  --type <feat|fix|chore>   Branch prefix (default: feat)
  --branch <name>           Full branch name (overrides --type + task-name)
  --base <branch>           Base branch to branch from (default: main)
  --no-sync                 Skip fetch/rebase of base branch against upstream
  --no-worktree             Create/switch branch in current worktree instead
  --worktree-base <path>    Base directory for new worktrees
  --worktree-path <path>    Explicit worktree path (requires worktree mode)
  -h, --help                Show help

Examples:
  ./scripts/start-task.sh --type fix slash-tab-autocomplete
  ./scripts/start-task.sh --branch chore/release-notes
  ./scripts/start-task.sh --no-worktree --type feat context-loader-refactor
EOF
}

slugify() {
	local input="$1"
	printf '%s' "$input" \
		| tr '[:upper:]' '[:lower:]' \
		| sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

normalize_path() {
	local path="$1"
	if [[ "$path" = /* ]]; then
		printf '%s\n' "$path"
	else
		(cd "$REPO_ROOT" && cd "$(dirname "$path")" && printf '%s/%s\n' "$PWD" "$(basename "$path")")
	fi
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--type)
			BRANCH_TYPE="$2"
			shift 2
			;;
		--branch)
			BRANCH_NAME="$2"
			shift 2
			;;
		--base)
			BASE_BRANCH="$2"
			shift 2
			;;
		--no-sync)
			SYNC_MAIN=false
			shift
			;;
		--no-worktree)
			USE_WORKTREE=false
			shift
			;;
		--worktree-base)
			WORKTREE_BASE="$2"
			shift 2
			;;
		--worktree-path)
			WORKTREE_PATH="$2"
			shift 2
			;;
		-h|--help)
			usage
			exit 0
			;;
		--*)
			echo "Unknown option: $1" >&2
			usage
			exit 1
			;;
		*)
			if [[ -n "$TASK_NAME" ]]; then
				echo "Unexpected extra argument: $1" >&2
				usage
				exit 1
			fi
			TASK_NAME="$1"
			shift
			;;
	esac
done

if [[ -z "$BRANCH_NAME" ]]; then
	if [[ -z "$TASK_NAME" ]]; then
		echo "Error: provide <task-name> or --branch" >&2
		usage
		exit 1
	fi
	SLUG="$(slugify "$TASK_NAME")"
	if [[ -z "$SLUG" ]]; then
		echo "Error: task name produced an empty slug" >&2
		exit 1
	fi
	BRANCH_NAME="$BRANCH_TYPE/$SLUG"
fi

if [[ "$USE_WORKTREE" == "false" && -n "$WORKTREE_PATH" ]]; then
	echo "Error: --worktree-path requires worktree mode" >&2
	exit 1
fi

cd "$REPO_ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
	echo "Error: working tree is not clean. Commit or stash first." >&2
	exit 1
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "$BASE_BRANCH" ]]; then
	echo "Error: current branch is '$CURRENT_BRANCH'. Switch to '$BASE_BRANCH' first." >&2
	exit 1
fi

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
	echo "Error: missing upstream remote '$UPSTREAM_REMOTE'" >&2
	exit 1
fi

if [[ "$SYNC_MAIN" == "true" ]]; then
	echo "[start-task] Fetching remotes..."
	git fetch "$UPSTREAM_REMOTE" --prune
	if git remote get-url "$ORIGIN_REMOTE" >/dev/null 2>&1; then
		git fetch "$ORIGIN_REMOTE" --prune
	fi

	echo "[start-task] Rebasing $BASE_BRANCH onto $UPSTREAM_REMOTE/$BASE_BRANCH..."
	git rebase "$UPSTREAM_REMOTE/$BASE_BRANCH"
fi

if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
	echo "[start-task] Branch exists: $BRANCH_NAME"
else
	echo "[start-task] Creating branch: $BRANCH_NAME"
	git branch "$BRANCH_NAME" "$BASE_BRANCH"
fi

if [[ "$USE_WORKTREE" == "true" ]]; then
	EXISTING_WORKTREE="$({
		git worktree list --porcelain | awk -v b="refs/heads/$BRANCH_NAME" '
			$1 == "worktree" { wt = $2 }
			$1 == "branch" && $2 == b { print wt }
		'
	} || true)"

	if [[ -n "$EXISTING_WORKTREE" ]]; then
		echo "[start-task] Branch already checked out in worktree: $EXISTING_WORKTREE"
		echo "[start-task] Next: cd $EXISTING_WORKTREE"
		exit 0
	fi

	if [[ -z "$WORKTREE_PATH" ]]; then
		WORKTREE_BASE_ABS="$(normalize_path "$WORKTREE_BASE")"
		mkdir -p "$WORKTREE_BASE_ABS"
		WORKTREE_PATH="$WORKTREE_BASE_ABS/$(printf '%s' "$BRANCH_NAME" | tr '/' '-')"
	else
		WORKTREE_PATH="$(normalize_path "$WORKTREE_PATH")"
	fi

	if [[ -e "$WORKTREE_PATH" ]]; then
		echo "Error: worktree path already exists: $WORKTREE_PATH" >&2
		exit 1
	fi

	echo "[start-task] Creating worktree: $WORKTREE_PATH"
	git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"

	if git show-ref --verify --quiet "refs/remotes/$ORIGIN_REMOTE/$BRANCH_NAME"; then
		git -C "$WORKTREE_PATH" branch --set-upstream-to "$ORIGIN_REMOTE/$BRANCH_NAME" "$BRANCH_NAME" >/dev/null || true
	fi

	echo "[start-task] Ready"
	echo "[start-task] Branch:   $BRANCH_NAME"
	echo "[start-task] Worktree: $WORKTREE_PATH"
	echo "[start-task] Next: cd $WORKTREE_PATH"
	exit 0
fi

git switch "$BRANCH_NAME"
if git show-ref --verify --quiet "refs/remotes/$ORIGIN_REMOTE/$BRANCH_NAME"; then
	git branch --set-upstream-to "$ORIGIN_REMOTE/$BRANCH_NAME" "$BRANCH_NAME" >/dev/null || true
fi

echo "[start-task] Ready"
echo "[start-task] Branch: $BRANCH_NAME"

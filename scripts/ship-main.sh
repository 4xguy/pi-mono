#!/usr/bin/env bash
set -euo pipefail

ORIGIN_REMOTE="${SHIP_ORIGIN_REMOTE:-origin}"
UPSTREAM_REMOTE="${SHIP_UPSTREAM_REMOTE:-upstream}"
BRANCH="${SHIP_BRANCH:-main}"
RUN_CHECK=true
DO_PUSH=true
DRY_RUN=false

usage() {
	cat <<'EOF'
Usage: scripts/ship-main.sh [options]

Sync local main with upstream/main, validate, then push to origin/main.

Options:
  --dry-run   Show actions and divergence, do not rebase/check/push
  --no-check  Skip npm run check
  --no-push   Skip git push
  -h, --help  Show help

Environment overrides:
  SHIP_ORIGIN_REMOTE   (default: origin)
  SHIP_UPSTREAM_REMOTE (default: upstream)
  SHIP_BRANCH          (default: main)
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dry-run)
			DRY_RUN=true
			shift
			;;
		--no-check)
			RUN_CHECK=false
			shift
			;;
		--no-push)
			DO_PUSH=false
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

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	echo "Error: not inside a git repository" >&2
	exit 1
fi

if ! git remote get-url "$ORIGIN_REMOTE" >/dev/null 2>&1; then
	echo "Error: missing origin remote '$ORIGIN_REMOTE'" >&2
	exit 1
fi

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
	echo "Error: missing upstream remote '$UPSTREAM_REMOTE'" >&2
	echo "Tip: git remote add $UPSTREAM_REMOTE <canonical-repo-url>" >&2
	exit 1
fi

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$BRANCH" ]]; then
	echo "Error: current branch is '$current_branch'. Switch to '$BRANCH' first." >&2
	exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
	echo "Error: working tree is not clean. Commit or stash changes first." >&2
	exit 1
fi

echo "[ship] Fetching remotes..."
git fetch "$UPSTREAM_REMOTE" --prune
git fetch "$ORIGIN_REMOTE" --prune

echo "[ship] Divergence before rebase"
echo "  $UPSTREAM_REMOTE/$BRANCH...$BRANCH: $(git rev-list --left-right --count "$UPSTREAM_REMOTE/$BRANCH...$BRANCH")"
echo "  $ORIGIN_REMOTE/$BRANCH...$BRANCH:   $(git rev-list --left-right --count "$ORIGIN_REMOTE/$BRANCH...$BRANCH")"

if [[ "$DRY_RUN" == "true" ]]; then
	echo "[ship] Dry run complete (no rebase/check/push performed)."
	exit 0
fi

echo "[ship] Rebasing $BRANCH onto $UPSTREAM_REMOTE/$BRANCH..."
git rebase "$UPSTREAM_REMOTE/$BRANCH"

if [[ "$RUN_CHECK" == "true" ]]; then
	echo "[ship] Running npm run check..."
	npm run check
fi

if [[ "$DO_PUSH" == "true" ]]; then
	echo "[ship] Pushing $BRANCH to $ORIGIN_REMOTE..."
	git push "$ORIGIN_REMOTE" "$BRANCH"
	git fetch "$ORIGIN_REMOTE" "$BRANCH" --prune
fi

echo "[ship] Divergence after sync"
echo "  $UPSTREAM_REMOTE/$BRANCH...$BRANCH: $(git rev-list --left-right --count "$UPSTREAM_REMOTE/$BRANCH...$BRANCH")"
echo "  $ORIGIN_REMOTE/$BRANCH...$BRANCH:   $(git rev-list --left-right --count "$ORIGIN_REMOTE/$BRANCH...$BRANCH")"

echo "[ship] Done."

#!/usr/bin/env bash
set -euo pipefail

ORIGIN_REMOTE="${SYNC_ORIGIN_REMOTE:-origin}"
UPSTREAM_REMOTE="${SYNC_UPSTREAM_REMOTE:-upstream}"
BRANCH="${SYNC_BRANCH:-main}"
RUN_CHECK=true
DO_PUSH=true
DRY_RUN=false

usage() {
	cat <<'EOF'
Usage: scripts/sync-upstream-main.sh [options]

Merge upstream/main into local main while preserving local fork customizations,
validate, create a remote backup of the previous origin/main, then fast-forward
push main to origin/main.

Options:
  --dry-run   Show divergence, do not merge/check/push
  --no-check  Skip npm run check
  --no-push   Skip backup/push
  -h, --help  Show help

Environment overrides:
  SYNC_ORIGIN_REMOTE    (default: origin)
  SYNC_UPSTREAM_REMOTE  (default: upstream)
  SYNC_BRANCH           (default: main)
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
	exit 1
fi

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$BRANCH" ]]; then
	echo "Error: current branch is '$current_branch'. Switch to '$BRANCH' first." >&2
	exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
	echo "Error: working tree is not clean. Commit or resolve changes first." >&2
	exit 1
fi

echo "[sync] Fetching remotes..."
git fetch "$UPSTREAM_REMOTE" --prune
git fetch "$ORIGIN_REMOTE" --prune

echo "[sync] Divergence before sync"
echo "  $UPSTREAM_REMOTE/$BRANCH...$BRANCH: $(git rev-list --left-right --count "$UPSTREAM_REMOTE/$BRANCH...$BRANCH")"
echo "  $ORIGIN_REMOTE/$BRANCH...$BRANCH:   $(git rev-list --left-right --count "$ORIGIN_REMOTE/$BRANCH...$BRANCH")"

if [[ "$DRY_RUN" == "true" ]]; then
	echo "[sync] Dry run complete."
	exit 0
fi

if git merge-base --is-ancestor "$UPSTREAM_REMOTE/$BRANCH" "$BRANCH"; then
	echo "[sync] $BRANCH already contains $UPSTREAM_REMOTE/$BRANCH."
else
	echo "[sync] Merging $UPSTREAM_REMOTE/$BRANCH into $BRANCH..."
	git merge --no-ff "$UPSTREAM_REMOTE/$BRANCH" -m "Merge $UPSTREAM_REMOTE/$BRANCH into $BRANCH"
fi

if [[ "$RUN_CHECK" == "true" ]]; then
	echo "[sync] Running npm run check..."
	npm run check
fi

if [[ "$DO_PUSH" == "true" ]]; then
	backup_branch="backup/${BRANCH}-before-upstream-sync-$(date +%Y%m%d-%H%M%S)"
	echo "[sync] Creating remote backup $ORIGIN_REMOTE/$backup_branch from $ORIGIN_REMOTE/$BRANCH..."
	git push "$ORIGIN_REMOTE" "$ORIGIN_REMOTE/$BRANCH:refs/heads/$backup_branch"

	echo "[sync] Pushing $BRANCH to $ORIGIN_REMOTE/$BRANCH..."
	git push "$ORIGIN_REMOTE" "$BRANCH:$BRANCH"
	git fetch "$ORIGIN_REMOTE" "$BRANCH" --prune
fi

echo "[sync] Divergence after sync"
echo "  $UPSTREAM_REMOTE/$BRANCH...$BRANCH: $(git rev-list --left-right --count "$UPSTREAM_REMOTE/$BRANCH...$BRANCH")"
echo "  $ORIGIN_REMOTE/$BRANCH...$BRANCH:   $(git rev-list --left-right --count "$ORIGIN_REMOTE/$BRANCH...$BRANCH")"

echo "[sync] Done."

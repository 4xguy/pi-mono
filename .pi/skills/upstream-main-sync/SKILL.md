---
name: upstream-main-sync
description: Use this skill when syncing this fork's main with upstream/main while preserving local customizations and pushing origin/main.
---

# Upstream Main Sync

Use this skill for this repo's fork-sync workflow when local `main` has intentional customizations that must not be rebased away or reset to upstream.

Do not use this skill when the user explicitly asks to discard local customizations, hard-reset to upstream, or rebase local commits.

## Required posture

- Preserve local customization commits.
- Do not run `../../../scripts/ship-main.sh` for this workflow. It rebases `main` onto `upstream/main`, which can re-open conflicts and flatten the merge-preserving history this fork needs.
- Never force-push.
- Create a remote backup of the old `origin/main` before updating it.
- Keep unrelated dirty work, especially work on `dev`, untouched.

## Standard command

From a clean `main` worktree, run:

```bash
./scripts/sync-upstream-main.sh
```

The script:

1. Fetches `upstream` and `origin`.
2. Merges `upstream/main` into `main` with `--no-ff` when needed.
3. Stops for manual conflict resolution if Git reports conflicts.
4. Runs `npm run check`.
5. Pushes a backup branch from the previous `origin/main`.
6. Fast-forward pushes local `main` to `origin/main`.

## If the current branch is not clean main

If the active worktree is on `dev`, has unrelated dirty files, or otherwise should not be disturbed, create a temporary main worktree:

```bash
git worktree add ../pi-mono-main-sync main
cd ../pi-mono-main-sync
./scripts/sync-upstream-main.sh
cd -
git worktree remove ../pi-mono-main-sync
```

If `main` is already checked out in another worktree, use that worktree instead of creating a second one.

## Conflict resolution policy

When the merge conflicts:

1. Read every conflicted file in full before editing it.
2. Preserve local repo customizations unless the user explicitly says to drop them.
3. Accept upstream changes for normal product code unless they conflict with intentional local behavior.
4. For `.pi/` resources, preserve project-local agents, skills, prompts, extensions, and workflow customizations unless upstream has a clear replacement.
5. Resolve conflicts with precise edits or normal Git conflict resolution.
6. Stage only the resolved files.
7. Commit the merge with a message like:

```bash
git commit -m "Merge upstream/main into main"
```

Then rerun:

```bash
./scripts/sync-upstream-main.sh
```

The rerun should see that `main` already contains `upstream/main`, then validate and push.

## Verification

After a successful sync, report these facts:

```bash
git log --oneline --decorate -1 main
git log --oneline --decorate -1 upstream/main
git rev-list --left-right --count upstream/main...main
git rev-list --left-right --count origin/main...main
```

Expected final shape:

- `upstream/main...main` has `0` on the left: local `main` contains all upstream commits.
- `origin/main...main` is `0 0` after push.
- Any temporary worktree has been removed.

## Related workflow boundary

Use `../../../scripts/ship-main.sh` for ordinary local feature shipping when local `main` should be rebased onto upstream before pushing.

Use this skill and `../../../scripts/sync-upstream-main.sh` for fork-maintenance syncs where preserving local customization history is the point.

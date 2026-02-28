---
title: "Parallel Agent Git Workflow Runbook"
doc_id: "parallel-agent-git-workflow-2026-02-28"
status: "active"
version: "0.1.0"
created_at: "2026-02-28T13:32:31-06:00"
last_updated: "2026-02-28T13:32:31-06:00"
---

## Purpose

Define a safe workflow for local commits and later integration when multiple agents are working in parallel across local repos and branches.

## Core Rules

1. Only stage files touched in this session.
2. Never use `git add .` or `git add -A`.
3. Never use destructive commands (`reset --hard`, `checkout .`, `clean -fd`, `stash`).
4. Always run `git status` before and after staging.
5. Push only after explicit user approval.

## Local Commit Workflow

1. Verify current state:
   - `git status`
2. Stage specific files only:
   - `git add <file1> <file2> ...`
3. Run required checks.
4. Commit with scoped message.

## Integration Workflow (when ready to push)

1. Fetch both remotes:
   - `git fetch origin`
   - `git fetch upstream`
2. Rebase local work onto latest fork main:
   - `git rebase origin/main`
3. Sync fork main with upstream main (if needed and approved):
   - either in local main branch or dedicated sync branch
4. Rebase feature branch again if upstream sync changed fork main.
5. Resolve conflicts only in files owned by this work.
6. If conflicts appear in unrelated files, stop and ask user.
7. Push after approval.

## Conflict Handling

- Resolve only files modified by this agent/session.
- Keep upstream/fork behavior for unrelated files.
- Re-run required checks after conflict resolution.

## Current Known Baseline Note

- Prior blocker was `npm run check` failing in `packages/web-ui` due missing module/type resolution.
- Fixed in this workspace by tsconfig path updates:
  - `packages/web-ui/tsconfig.json`
  - `packages/web-ui/example/tsconfig.json`

## Quick Checklist Before Push

- [ ] `git status` clean except intended files
- [ ] required checks pass
- [ ] local commits are scoped and coherent
- [ ] branch rebased onto latest `origin/main`
- [ ] user approved push

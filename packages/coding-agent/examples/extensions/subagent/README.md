# Subagent Example (Worktree-First)

Delegate tasks to specialized subagents with isolated context windows, deterministic scheduling, and optional git-worktree isolation for write-capable tasks.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Model/profile overrides**: Per-agent and per-task `model`, `thinking`, and `tools`
- **Worktree-first writes**: Write-capable tasks default to `isolation: worktree`
- **Deterministic scheduler**: Parallel waves with conflict detection (`writePaths` + isolation)
- **Patch integration**: Worktree diffs are applied back to the main checkout with 3-way apply
- **Conflict policy**: `onWriteConflict: serialize|fail`
- **Streaming output**: See tool calls and progress as they happen
- **Curated results**: Compact `content` + full `details` + optional JSON artifact file
- **Abort propagation**: Ctrl+C propagates to subagent processes
- **Auto-delegation mode**: `/subagent-mode off|assist|orchestrate`

## Structure

```text
subagent/
├── README.md
├── index.ts
├── agents.ts
├── types.ts
├── config.ts
├── profiles.ts
├── policy.ts
├── scheduler.ts
├── worktree.ts
├── integration.ts
├── curation.ts
├── agents/
│   ├── scout.md
│   ├── planner.md
│   ├── reviewer.md
│   └── worker.md
└── prompts/
    ├── implement.md
    ├── scout-and-plan.md
    └── implement-and-review.md
```

## Installation

From the repository root, symlink the files:

```bash
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts

# Optional helpers for local development / imports
for f in agents.ts types.ts config.ts profiles.ts policy.ts scheduler.ts worktree.ts integration.ts curation.ts; do
  ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/$f" ~/.pi/agent/extensions/subagent/$f
done

mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with delegated system prompts, model/tool settings, and working directory.

Project-local agents (`.pi/agents/*.md`) are repo-controlled prompts.

- **Default scope**: user-level agents (`~/.pi/agent/agents`)
- To enable project agents, set `agentScope: "both"` or `"project"`
- Interactive runs prompt for confirmation before project agents (configurable)

## Agent Frontmatter

Agents are markdown files with YAML frontmatter:

```markdown
---
name: worker
description: General-purpose implementation agent
tools: read, edit, write, bash
disallowedTools: bash
model: claude-sonnet-4-5
thinking: high
mode: write
writePaths: src/**, test/**
isolation: worktree
timeoutMs: 120000
useProactively: true
---

System prompt body...
```

### Fields

- `name` (required)
- `description` (required)
- `tools` (optional)
- `disallowedTools` (optional)
- `model` (optional)
- `thinking` (optional): `off|minimal|low|medium|high|xhigh`
- `mode` (optional): `read|write|auto`
- `writePaths` (optional): list or comma-separated globs
- `isolation` (optional): `none|worktree`
- `timeoutMs` (optional)
- `useProactively` (optional boolean)

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Scheduler builds safe execution waves |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Task Overrides

All task objects support optional overrides:

- `model`
- `thinking`
- `tools`
- `mode`
- `writePaths`
- `isolation`
- `timeoutMs`

Top-level policy override:

- `onWriteConflict`: `serialize` (default) or `fail`

## Worktree Behavior

Write-capable + `isolation: worktree` tasks:

1. detect git repo root
2. create temporary worktree
3. run task in isolated cwd
4. collect `git diff --binary`
5. apply patch to main checkout (`git apply --3way`)
6. cleanup successful worktrees; optionally keep failed ones

Fallbacks:

- Non-git repo: runs without worktree isolation
- Worktree creation failure: falls back to normal cwd with warning in result stderr/details

## Auto-Delegation Mode

- `/subagent-mode off|assist|orchestrate`
- `--subagent-mode off|assist|orchestrate`

Modes:

- `off`: no extra delegation guidance
- `assist`: guidance only for complex/high-context-pressure prompts
- `orchestrate`: stronger guidance to delegate non-trivial work

## Config Files

Config is layered (project overrides user):

- `~/.pi/agent/subagents.json`
- nearest `.pi/subagents.json`

Supported keys:

- `maxParallelTasks`
- `maxConcurrency`
- `collapsedItemCount`
- `contentMaxChars`
- `onWriteConflict`
- `taskTimeoutMs`
- `cleanupWorktreesOnSuccess`
- `keepFailedWorktrees`
- `pruneWorktreesOnFinish`
- `autoDelegationDefault`
- `confirmProjectAgents`
- `artifactDir`

## Output Contract

- `content`: curated compact summary (bounded by `contentMaxChars`)
- `details`: full per-task telemetry (messages, usage, patch/worktree metadata)
- optional JSON artifact under `artifactDir` (default `.pi/subagent-runs`)

## Notes

- Agent discovery happens on every invocation (edits are picked up immediately)
- Scheduler is conservative for unknown write scopes
- Parallel limits are configurable and validated at runtime

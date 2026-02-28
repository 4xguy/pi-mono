# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes
- **Coordinator visibility**: status-line summary (`c#:a#:p#`) and interactive inspector (`/agents`)
- **Optional root auto-routing**: root agent can be instructed to delegate through `coordinator` (with safe fallback)
- **Worktree isolation mode**: optional git worktree lane execution with patch-based integration
- **Automatic isolation policy**: per-request `auto` selection between `shared` and `worktree`

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── auto-route.ts        # Root auto-routing + coordinator-only decision helpers
├── guardrails.ts        # Budget/depth/loop guardrail primitives
├── context-memory.ts    # Shared context ledger + handoff packet utilities
├── coordinator-monitor.ts # Coordinator state + status summary formatting
├── policy.ts             # Topology scoring + mode recommendation
├── phase-gates.ts        # Formal phase gate contracts + smoke gate helpers
├── worktree.ts           # Git worktree isolation + patch integration helpers
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/auto-route.ts" ~/.pi/agent/extensions/subagent/auto-route.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/guardrails.ts" ~/.pi/agent/extensions/subagent/guardrails.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/context-memory.ts" ~/.pi/agent/extensions/subagent/context-memory.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/coordinator-monitor.ts" ~/.pi/agent/extensions/subagent/coordinator-monitor.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/coordinator-inspector-state.ts" ~/.pi/agent/extensions/subagent/coordinator-inspector-state.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/policy.ts" ~/.pi/agent/extensions/subagent/policy.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/phase-gates.ts" ~/.pi/agent/extensions/subagent/phase-gates.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/worktree.ts" ~/.pi/agent/extensions/subagent/worktree.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

### Coordinator inspector
```
/agents
```

Shortcut: `Ctrl+Alt+A`

Inspector controls:
- Left / Right: switch coordinator
- Up / Down: select agent/task within coordinator
- Enter / Tab: toggle selected-agent details
- Esc: close inspector

Inspector details include governance snapshots for each coordinator:
- gate summary (`topology:* smoke:*`)
- smoke attempt counters
- recent remediation attempts (`#<attempt> <agent> ok|fail ...`)

## Milestone 4: Coordinator Auto-Routing (Opt-in)

Root prompts can be routed through a coordinator when enabled.

Default behavior:
- `subagent-auto-route`: `false`
- `subagent-coordinator-only`: `false`
- coordinator agent: `coordinator`

Guardrails/fallback:
- only applies at root depth (`SUBAGENT_ENV_DEPTH=0`)
- slash/bang commands are not rewritten
- if coordinator agent is missing, the extension warns once and falls back to normal behavior
- injected directive requires exactly one `subagent` delegation and explicit fallback to safe direct mode if delegation fails

CLI/runtime controls:
- flags:
  - `--subagent-auto-route=<true|false>`
  - `--subagent-coordinator-only=<true|false>`
  - `--subagent-coordinator-agent=<name>`
- env:
  - `SUBAGENT_AUTO_ROUTE=1|0`
  - `SUBAGENT_COORDINATOR_ONLY=1|0`
  - `SUBAGENT_COORDINATOR_AGENT=<name>`
- command:
  - `/subagent-auto on|off`
  - `/subagent-auto coordinator <name>`
  - `/subagent-auto coordinator-only on|off`

## Milestone 5: Worktree Execution Isolation

For write-heavy tasks, you can isolate execution lanes with git worktrees.

Behavior when `executionIsolation: "worktree"`:
- Each lane runs in a dedicated git worktree/branch.
  - single: one worktree
  - chain: one shared worktree for all steps
  - parallel: one worktree per parallel task
- After successful lane execution, changes are integrated back to the repo root with:
  - `git diff --binary` from lane
  - `git apply --3way` on root
- Worktrees are removed automatically at tool completion.
- If lane integration fails, the coordinator reports an error and stops finalization.

Fallback semantics:
- If current cwd is not in a git repo, the tool falls back to `shared` isolation and records a policy warning.
- If a lane `cwd` points outside repo root, the tool uses the lane root and records a warning.

## Milestone 5.1: Automatic Isolation Policy

With `executionIsolation: "auto"`, the tool chooses isolation per request:
- `parallel`
  - read-only task set -> `shared`
  - potential writes -> `worktree`
- `chain`
  - write-capable/write-intent tasks -> `worktree`
  - read-only chain -> `shared`
- `single`
  - explicit write intent + write-capable agent -> `worktree`
  - otherwise -> `shared`

The selected isolation is shown in governance lines as:
- `isolation:<selected> (req:auto)`

Environment overrides:
- `SUBAGENT_EXECUTION_ISOLATION=auto|shared|worktree`
- `SUBAGENT_WORKTREE_BASE_DIR=/path/to/worktrees`

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

Optional context parameters (all modes):
- `contextMode`: `"isolated" | "shared-read" | "shared-write"` (default: `"shared-read"`)
- `sharedContextLimit`: number of recent ledger entries in handoff packets (default: `12`, max: `50`)
- `memoryDir`: optional base directory for shared ledger files

Optional execution-isolation parameters (all modes):
- `executionIsolation`: `"auto" | "shared" | "worktree"` (default: `"auto"`)
- `worktreeBaseDir`: optional base directory for git worktree lanes (default: `<repo>/.pi/worktrees`)

Optional governance parameters (all modes):
- `topologyPolicy`: `"auto" | "advisory"` (default: `"auto"`)
- `phaseName`: label for the current phase (shown in policy/gate output)
- `requirePhaseSmoke`: if `true`, phase smoke commands must pass for success
- `phaseSmokeCommands`: shell commands run as phase smoke gates (executed in tool cwd)
- `phaseSmokeRetries`: flaky-smoke retry count before failing (default: `1`, max: `5`)
- `phaseMaxFixAttempts`: bounded gate-fix loop cap after smoke failure (default: `2`, max: `5`)

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status

**Footer coordinator summary**:
- Status key `subagents` shows compact coordinator tokens
- Active format: `c#:a#` and `:p#` when parallel agents are currently running
- Completion format: `c#:done` (or `c#:err`) shown briefly after finish, then cleared
- Example active state: `c1:a3:p2 | c2:a6:p4 | c3:a4`

**Policy + gate summary in tool output**:
- Policy line includes selected vs recommended topology with simple scores (complexity/risk/coupling/confidence)
- Gate line includes topology/smoke status plus smoke/fix attempt counters
- Flaky smoke failures are retried according to `phaseSmokeRetries`
- When `requirePhaseSmoke=true`, smoke failure triggers bounded gate-fix attempts up to `phaseMaxFixAttempts`
- A remediation summary block shows recent fix attempts (`#<attempt> <agent> ok|fail <summary>`)
- If the gate still fails after bounded attempts, the tool returns an error

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Coordinator and Nested Subagents

Yes, this extension can be used for coordinator-style orchestration, including nested subagents.

How it works today:
- Each subagent call spawns a separate `pi` process in JSON mode.
- If that child process also has this extension loaded, it can call `subagent` again.
- This enables coordinator -> subagent -> subagent trees.

Requirements for nested orchestration:
- The `subagent` extension must be available to spawned child `pi` processes.
- Agents that should be allowed to spawn children must explicitly include `subagent` in `tools:`.
  - If `tools:` is omitted, nested spawning is blocked by guardrails.
- If using project-local agents (`.pi/agents`), set `agentScope: "both"` or `"project"` (and keep confirmation enabled for untrusted repos).

Example coordinator agent:

```markdown
---
name: coordinator
description: Breaks work into subtasks and delegates to specialists
tools: subagent, read, grep, find, ls
model: claude-sonnet-4-5
---

Decompose work into bounded subtasks and delegate using the subagent tool.
```

## Guardrails (Current Defaults)

The example now enforces shared execution guardrails across nested runs:

- **Max depth:** `2`
- **Max total spawned agents per top-level invocation:** `16`
- **Max wall time per top-level invocation:** `10 minutes`
- **Parallel limits:** max `8` tasks, max `4` running concurrently
- **Nested spawn permission:** only agents with explicit `tools: ... subagent ...`
- **Loop protection:** blocks duplicate `(agent, normalized task)` delegation fingerprints

These limits are propagated from parent to child via environment metadata so nested calls inherit and decrement the same run budget.

Shared-context ledger files are written per run as JSONL at:
- default: `<cwd>/.pi/subagent-memory/runs/<runId>.jsonl`
- override: `memoryDir` parameter (or inherited env override)

## Shared Context Strategy (Design Direction)

To support "single mind" behavior when needed while preserving agent independence:

- Keep **private scratch context** per subagent process.
- Use a **shared append-only ledger** for cross-agent observations.
- Have the **coordinator act as canonical writer** for final decisions/source-of-truth.
- Use explicit handoff envelopes (`runId`, task IDs, artifacts, confidence, citations).

This example currently provides orchestration guardrails. A production memory system should be added behind a stable context interface rather than coupling directly to one backend.

## Recommended Approach

For pi, the recommended implementation path is:
1. Build subagent orchestration as an **extension** (current model).
2. Package it as a **pi package** if you want to share/reuse it.
3. Use SDK/RPC orchestration only if you need external scheduling/telemetry beyond extension scope.

Core integration is usually not recommended unless you want opinionated always-on behavior for all users.

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Agents discovered fresh on each invocation (allows editing mid-session)
- Budget allocation is conservative and may underutilize available tokens in some workflows
- Loop protection uses normalized task fingerprints; semantically-equivalent tasks with different wording may still pass
- Shared ledger is local file-based JSONL (no distributed locking or conflict resolution)

## Smoke Testing

From `packages/coding-agent` run targeted tests:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/subagent-context-memory.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/subagent-guardrails.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/subagent-worktree.test.ts
```

Run end-to-end interactive smoke test in tmux from repo root:

```bash
npm run smoke:tmux-subagent
# optional: npm run smoke:tmux-subagent -- --timeout 180 --model claude-haiku-4-5
```

Then run repository checks from repo root:

```bash
npm run check
```

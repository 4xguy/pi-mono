# Handoff: AGENTS.md Loading Behavior + Next-Gen Context File System

Date: 2026-02-28
Repo: `/Users/keith/AI/pi-mono`
Status: Preparation for fresh session design/implementation work

## Why this document exists
You asked for a durable handoff before starting a fresh session/context window.
This captures:
1. The researched answer on how `AGENTS.md` is currently loaded and used.
2. Your intended direction (OpenClaw-like multi-file context system).
3. Recommended implementation strategy, compatibility model, and rollout plan.

---

## 1) Current behavior in pi: how `AGENTS.md` is loaded and used

## 1.1 Discovery + loading
Primary loader code:
- `packages/coding-agent/src/core/resource-loader.ts`

Key functions:
- `loadContextFileFromDir(dir)`
- `loadProjectContextFiles({ cwd, agentDir })`

Current per-directory candidate order:
- `AGENTS.md`
- `CLAUDE.md`

Important detail:
- Per directory, loader returns the **first existing file** in that candidate list.
- That means `AGENTS.md` has precedence over `CLAUDE.md` in the same directory.

## 1.2 Search scope and ordering
`loadProjectContextFiles()` currently loads:
1. Global agent dir context first (`agentDir`, usually `~/.pi/agent`), then
2. Ancestor directories from filesystem root down to `cwd`.

Implementation notes:
- It walks upward from `cwd` to `/` and uses `unshift` to preserve root -> cwd order in final ancestor list.
- It deduplicates by full path (`seenPaths`), so same file path is not included twice.

## 1.3 When this happens
Context files are loaded into runtime resources during:
- Session/runtime initialization (`ResourceLoader.reload()` path), and
- `/reload` (explicit runtime reload).

Rebuild path:
- `packages/coding-agent/src/core/agent-session.ts`
  - `_rebuildSystemPrompt(...)`
  - `reload()`

## 1.4 How loaded context enters model prompt
Prompt assembly code:
- `packages/coding-agent/src/core/system-prompt.ts`
  - `buildSystemPrompt(...)`

Behavior:
- `contextFiles` are appended to system prompt under:
  - `# Project Context`
- Each file is included with path + full content.

So context files are system-level instructions, not user/assistant message history.

## 1.5 Runtime visibility
Interactive startup shows loaded context under:
- `[Context]`
Code path:
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

---

## 2) Your intended direction (captured)
You want to move away from single-file AGENTS-only usage and support an OpenClaw-like model with multiple files, likely including:
- `identity.md`
- `soul.md`
- `user.md`

Desired fallback model (explicit):
1. Prefer the new multi-file system (name TBD),
2. If unavailable, fallback to `AGENTS.md`,
3. If unavailable, fallback to `CLAUDE.md`.

You also want this work started in a fresh context window/session.

---

## 3) Suggested architecture (non-breaking first)

## 3.1 Introduce a “Context Profile” resolver
Add a new resolver in resource loading that can build a composite context from multiple files in a directory.

Proposed precedence in each directory:
1. **Context Profile** (if present)
2. `AGENTS.md`
3. `CLAUDE.md`

Where Context Profile might be defined by presence of one or more of:
- `identity.md`
- `soul.md`
- `user.md`
(and optionally future files)

## 3.2 Keep compatibility
Do not break existing users:
- Existing AGENTS/CLAUDE behavior remains when profile files are absent.
- Existing ancestor/global traversal stays deterministic.

## 3.3 Deterministic file ordering inside profile
Use a fixed order to avoid prompt drift:
1. `identity.md`
2. `soul.md`
3. `user.md`
4. (optional extras in explicit ordered list)

## 3.4 Represent profile in prompt cleanly
Two implementation options:
- **A (minimal code churn):** concatenate profile files into one synthetic context entry.
- **B (more explicit):** pass separate entries and render by section in `buildSystemPrompt()`.

Recommendation: start with A, then evolve to B if needed.

## 3.5 Add explicit mode control (optional, recommended)
Add a setting or env mode such as:
- `auto` (default): profile > AGENTS > CLAUDE
- `classic`: AGENTS > CLAUDE only
- `profile-only`: only new profile system

This helps migration and debugging.

---

## 4) Proposed implementation plan for fresh session

## Phase 1: Analysis + spec
1. Locate and study local OpenClaw code that loads `identity/soul/user` files.
2. Produce a short mapping doc:
   - discovery paths,
   - ordering,
   - precedence,
   - composition into prompt.
3. Decide final naming and directory conventions for pi.

## Phase 2: Loader changes
1. Update `resource-loader.ts` with profile resolver.
2. Preserve fallback chain and deterministic ordering.
3. Keep `getAgentsFiles()` output format compatible (or add explicit new metadata field if needed).

## Phase 3: Prompt/render updates
1. Keep/adjust `buildSystemPrompt()` formatting for readability.
2. Keep startup `[Context]` listing informative (show profile sources clearly).

## Phase 4: Tests + docs
1. Add loader tests covering precedence and fallback.
2. Add docs for context profile behavior and migration examples.
3. Validate `/reload` behavior picks up profile changes.

---

## 5) Risks and mitigations

Risk: prompt bloat from multi-file profiles.
- Mitigation: enforce concise files; optionally add per-file/token limits later.

Risk: ambiguous precedence across global + ancestors.
- Mitigation: preserve existing deterministic order; document it clearly.

Risk: migration confusion.
- Mitigation: mode flag (`auto/classic/profile-only`) + startup `[Context]` display.

---

## 6) Practical next-session starter prompt
Use this in the fresh session:

"Read `.context/handoffs/2026-02-28-agents-context-system-handoff.md`. Then locate my local OpenClaw repo and analyze how it loads identity/soul/user context files. Propose a concrete pi implementation that prefers the new profile system and falls back to AGENTS.md then CLAUDE.md, with tests and docs updates."

---

## 7) Branch/workflow reminder for this work
Per current policy in this repo:
- Start on a task branch via `./scripts/start-task.sh`.
- Keep `main` integration-only.
- Ship with `./scripts/ship-main.sh`.

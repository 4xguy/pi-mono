---
title: "Pi V0 Spec: Universal Capability Fabric (Foundry + Runtime + Profiles)"
doc_id: "ucf-pi-v0"
status: "draft"
version: "0.1.0"
created_at: "2026-02-27T13:39:58-06:00"
last_updated: "2026-02-27T13:39:58-06:00"
authors:
  - "keith (vision)"
  - "pi assistant (initial draft)"
---

## 1) Purpose

Define a concrete V0 architecture for pi that supports:

1. Ephemeral worker agents (spawn, execute, shutdown)
2. Persistent capability memory (generated Python/TS tools + metadata)
3. Persistent auth (especially OAuth)
4. Lazy-load tool usage to minimize context bloat
5. A coordinator that can dispatch multiple independent workers

This is a **single system** from the user’s perspective, with internal modular components.

---

## 2) V0 Outcome (Definition of Success)

V0 is successful when pi can:

1. Accept: “I need to interact with API X for goal Y.”
2. Spawn a **Foundry worker** that can research, generate, test, and promote a new tool.
3. Persist the generated capability package (code + schema + policy + test evidence).
4. Spawn a **Runtime worker** that executes the promoted tool in a sandbox.
5. Reuse the capability in future sessions without rebuilding.
6. Load only relevant capabilities for the current task/profile.

---

## 3) Non-Goals (V0)

- Full autonomous self-healing without human review in all cases
- Perfect universal API coverage on first attempt
- Distributed remote cluster scheduler
- Rich GUI management console

---

## 4) Core Components

## 4.1 Capability Foundry (tool creator)
Responsibilities:
- API research (docs/search/spec discovery)
- Tool generation (Python or TypeScript)
- Contract generation (input/output schema)
- Validation and test runs in sandbox
- Promotion decision (`draft -> tested -> promoted`)

## 4.2 Capability Runtime (universal executor)
Responsibilities:
- Resolve best capability for user request
- Sandbox execution of promoted capabilities
- Structured result normalization
- Capture artifacts and execution telemetry

## 4.3 Profile Layer (persona prompts)
Responsibilities:
- Domain behavior (marketing, research, operations, etc.)
- Allowed capability tags/policies
- Context shaping and defaults

## 4.4 Coordinator
Responsibilities:
- Spawn/track Foundry and Runtime workers
- Assign tasks and collect handoffs
- Support parallel independent worker runs
- Persist run graph and state links

## 4.5 Persistence Layer
Responsibilities:
- Capability registry and versions
- Worker runs and handoffs
- Test/validation evidence
- Profile definitions

## 4.6 Auth Broker Adapter
Responsibilities:
- Keep OAuth/API credential handling outside generated scripts
- Inject credential access contract into sandbox runs
- Persist auth across worker restarts

---

## 5) Pi Integration Strategy (V0)

Implement first as a **pi package extension** (not core pi changes initially).

Runtime model:
- Coordinator lives in extension runtime
- Workers are launched as isolated subprocess agents (pi RPC mode or isolated runner process)
- Sandbox execution delegated to configured sandbox backend (initially aibox-compatible adapter)

Primary extension surface:
- `registerCommand`: orchestration commands
- `registerTool`: runtime execution entrypoints
- `on("tool_call")` and `on("session_*")`: audit/coordination hooks

---

## 6) On-Disk Layout (V0)

Global (default): `~/.pi/agent/cap-fabric/`
Project override (optional): `.pi/cap-fabric/`

```text
cap-fabric/
  registry/
    capabilities.yaml
    aliases.yaml
  capabilities/
    <capability_id>/
      manifest.yaml
      versions/
        v0001/
          tool.py | tool.ts
          schema.input.json
          schema.output.json
          tests/
            smoke.yaml
            contract.yaml
          evidence/
            validation-report.json
            run-samples/
  profiles/
    marketing.yaml
    research.yaml
    ops.yaml
  runs/
    <run_id>/
      run.yaml
      events.jsonl
      artifacts/
  handoffs/
    <handoff_id>.yaml
  policies/
    default.yaml
    auth.yaml
```

---

## 7) Required Schemas (V0)

## 7.1 capability manifest (example)

```yaml
id: "google_calendar.events"
name: "Google Calendar Events"
status: "promoted" # draft|tested|promoted|deprecated|blocked
language: "python" # python|typescript
entrypoint: "versions/v0001/tool.py"
version: "v0001"
description: "List calendar events with time filters"
tags: ["google", "calendar", "events"]
auth:
  provider: "google"
  scopes: ["https://www.googleapis.com/auth/calendar.readonly"]
policy:
  network: true
  filesystem_write: false
  timeout_sec: 60
interfaces:
  input_schema: "versions/v0001/schema.input.json"
  output_schema: "versions/v0001/schema.output.json"
quality:
  success_rate: 1.0
  runs: 12
  last_validated_at: "2026-02-27T13:39:58-06:00"
provenance:
  created_by: "foundry"
  source_refs:
    - "https://developers.google.com/calendar/api"
```

## 7.2 profile schema (example)

```yaml
id: "marketing"
name: "Creative Marketing Agent"
system_prompt: |
  You are a strategic creative marketing operator...
allowed_tags:
  - "marketing"
  - "web"
  - "analytics"
default_policies:
  require_promoted_capabilities: true
  max_parallel_workers: 3
```

## 7.3 run schema (example)

```yaml
run_id: "run_20260227_133958_001"
type: "runtime" # foundry|runtime|coordinator
status: "completed" # pending|running|completed|failed|aborted
started_at: "2026-02-27T13:39:58-06:00"
ended_at: "2026-02-27T13:41:12-06:00"
profile: "marketing"
capabilities_used:
  - "google_calendar.events@v0001"
artifacts:
  - "artifacts/output.json"
```

---

## 8) Capability State Machine (V0)

```text
draft -> tested -> promoted -> deprecated
   \        \        \
    \-> blocked  -> blocked
```

Rules:
- `draft`: generated but not validated
- `tested`: passed required tests but not promoted
- `promoted`: allowed for runtime resolution
- `blocked`: failed validation or policy violation
- `deprecated`: retained but excluded from default resolution

Promotion gate (minimum):
1. Syntax + lint pass
2. Sandbox smoke test pass
3. Input/output contract checks pass
4. Auth/policy declaration present

---

## 9) Worker Lifecycle (V0)

## 9.1 Foundry run
1. Receive tool request (API + task goal)
2. Research API docs/examples
3. Generate tool scaffold + schema
4. Execute test suite in sandbox
5. Persist evidence
6. Promote or block
7. Emit handoff to coordinator
8. Shutdown

## 9.2 Runtime run
1. Receive task + profile
2. Resolve capabilities by tags + quality + policy
3. Lazy-load only selected capability metadata
4. Execute in sandbox
5. Persist artifacts + telemetry
6. Emit result
7. Shutdown

---

## 10) Lazy-Load Resolution (V0)

Resolver inputs:
- profile allowed tags
- user intent keywords
- capability status (`promoted` only by default)
- quality score (success rate, recency)

V0 algorithm:
1. Filter by `status=promoted`
2. Filter by profile `allowed_tags`
3. Rank by tag overlap + quality + recent success
4. Select top N (default N=5)
5. Load only those schemas/prompts into active context

---

## 11) Coordinator Protocol (V0)

Coordinator tracks each worker as immutable run records + event streams.

Event types:
- `run_started`
- `task_assigned`
- `capability_generated`
- `validation_passed`
- `validation_failed`
- `capability_promoted`
- `artifact_emitted`
- `run_completed`
- `run_failed`

Transport (V0):
- local file-backed JSONL + process stdout events
- optional RPC envelope for worker subprocesses

---

## 12) Security and Policy Baseline (V0)

1. Generated tools execute only in sandbox backend
2. Credentials never hardcoded in generated scripts
3. Auth access via broker adapter only
4. Capability policy must declare network/fs/time limits
5. Runtime defaults to promoted-only execution
6. Optional human approval for first promotion per new API domain

---

## 13) Default Bootstrap Capabilities (V0)

Foundry gets a minimal built-in set:
- `research_web` (provider adapter: Perplexity)
- `fetch_http` (generic API probe)
- `docs_lookup` (Context7/provider-specific docs)
- `sandbox_test` (execute candidate script)
- `contract_validate` (I/O schema checks)

These are foundational so foundry can create everything else.

---

## 14) Pi Commands (V0 UX)

Proposed commands:
- `/fabric profile <name>`
- `/fabric build <api_or_url> <goal>`
- `/fabric list [filter]`
- `/fabric test <capability_id>`
- `/fabric promote <capability_id> [version]`
- `/fabric run <capability_id> <json_args>`
- `/fabric runs [status]`

---

## 15) V0 Implementation Milestones

## M1: Foundation (registry + schemas + storage)
- capability/profile/run schemas
- persistence directories and index
- list/query commands

## M2: Runtime path
- promoted capability execution
- sandbox adapter integration
- artifact/run logging

## M3: Foundry path
- research + generation + testing pipeline
- promotion/blocked state transitions

## M4: Coordinator + parallel workers
- subprocess worker lifecycle
- run graph + handoff files
- profile-based lazy-load resolution

---

## 16) Acceptance Criteria (V0)

1. Build one new API capability from natural-language request
2. Promote it with persisted evidence
3. Reuse it in a separate fresh session without regeneration
4. Run two worker tasks in parallel with isolated runs
5. Enforce promoted-only default with policy checks

---

## 17) Risks and Mitigations

1. **Drift between code and capability metadata**
   - Mitigation: strict validation + manifest checks before promotion

2. **Context explosion from large capability catalog**
   - Mitigation: lazy-load top N only

3. **Unsafe generated scripts**
   - Mitigation: sandbox-only runtime + policy declarations

4. **Auth fragility across worker restarts**
   - Mitigation: broker-managed persistent credentials + refresh checks

---

## 18) Open Decisions (to resolve before M2/M3)

1. Worker transport default: pi RPC subprocess vs extension-internal worker loop
2. TypeScript execution backend choice (tsx/node/bun in sandbox)
3. Promotion policy: automatic vs human approval thresholds
4. Capability quality scoring formula
5. Global vs project precedence for registry resolution

---

## 19) Change Log

- `2026-02-27T13:39:58-06:00` — Initial V0 draft created.

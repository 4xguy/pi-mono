---
title: "Pi UCF V0: M1 Implementation Plan (Foundation)"
doc_id: "ucf-pi-v0-m1-plan"
status: "draft"
version: "0.1.0"
created_at: "2026-02-27T13:42:45-06:00"
last_updated: "2026-02-27T13:42:45-06:00"
related_docs:
  - "./2026-02-27T1339_v0-pi-universal-capability-fabric.md"
  - "./2026-02-27T1342_schema-contracts-v0.md"
---

## 1) Objective

Deliver **M1 Foundation** for the Universal Capability Fabric (UCF) in pi:

1. Durable storage layout bootstrap
2. Contracted schemas (capability/profile/run/event)
3. Registry/index read-write flows
4. Basic `/fabric` command surface for inspection and state management

M1 does **not** execute generated capabilities yet (that is M2).

---

## 2) M1 Scope

## In Scope
- Filesystem bootstrap for UCF home/project paths
- Type-safe model definitions for core contracts
- Persistence APIs (`load/save/list/query`) for:
  - capabilities
  - profiles
  - runs
- Minimal coordinator metadata/event logging
- CLI command shell (read-only + bootstrap + registration operations)

## Out of Scope
- Foundry generation pipeline
- Sandbox execution of capabilities
- Promotion via test runtime
- Parallel worker orchestration runtime

---

## 3) Proposed Package Placement (pi-mono)

Primary target package:
- `packages/coding-agent` (extension + runtime integration layer)

Initial module grouping (proposed):

```text
packages/coding-agent/src/core/cap-fabric/
  contracts/
    types.ts
    capability.ts
    profile.ts
    run.ts
    event.ts
  storage/
    paths.ts
    fs-store.ts
    capability-repo.ts
    profile-repo.ts
    run-repo.ts
  registry/
    registry-service.ts
    resolver.ts
  commands/
    fabric-command.ts
```

Note: this can be extension-first if preferred; module boundaries remain the same.

---

## 4) Deliverables

1. **Contract Types**
   - Strict TS interfaces + validators for all V0 entities
2. **Storage Bootstrap**
   - Auto-create `cap-fabric/` layout under user/project scope
3. **Repositories**
   - CRUD-like methods for contracted entities
4. **Registry Service**
   - `register`, `list`, `get`, `deprecate`, `alias` operations
5. **Command Surface (M1)**
   - `/fabric init`
   - `/fabric list`
   - `/fabric show <capability_id>`
   - `/fabric profiles`
   - `/fabric runs`
6. **M1 Docs + fixtures**
   - fixture examples for capability/profile/run files

---

## 5) Workstreams and Task Breakdown

## WS1: Contract Layer

### T1.1 Contract enums and IDs
- Define enums: status, language, run type/status, event type
- Define ID formats and validation helpers

### T1.2 Entity contracts
- Implement contracted types and runtime validators
- Normalize date/timestamp and path conventions

### Exit Criteria
- All contract examples validate cleanly
- Invalid fields are rejected with actionable errors

---

## WS2: Storage Layer

### T2.1 Paths + bootstrap
- Resolve global/project fabric roots
- Initialize canonical directory tree

### T2.2 Atomic file operations
- Safe write strategy (`temp -> rename`)
- Consistent YAML/JSON parsing and error wrapping

### Exit Criteria
- Fresh bootstrap creates correct tree
- Corrupt file handling does not crash command layer

---

## WS3: Registry + Repositories

### T3.1 Capability repository
- `saveVersion`, `loadManifest`, `listCapabilities`

### T3.2 Profile repository
- `saveProfile`, `loadProfile`, `listProfiles`

### T3.3 Run repository
- `createRun`, `appendEvent`, `completeRun`, `listRuns`

### T3.4 Resolver stub (M1)
- Basic tag/status filtering (no runtime execution)

### Exit Criteria
- End-to-end: register mock capability, list, read, deprecate
- End-to-end: create run + events + completion state

---

## WS4: Command Integration

### T4.1 `/fabric init`
- Bootstrap storage and seed defaults

### T4.2 Read commands
- list/show profiles/runs/capabilities

### T4.3 Error UX
- Domain-specific errors (contract/storage/not-found)

### Exit Criteria
- Commands operate on empty + populated state
- Output is deterministic and parseable for automation

---

## 6) Acceptance Tests (M1)

## Functional acceptance
1. `init` creates the full storage tree and default files
2. mock capability can be saved and listed
3. profile can be saved and listed
4. run can be created with event stream and completion state

## Data acceptance
1. all persisted files validate against V0 contracts
2. malformed files produce explicit validation errors

---

## 7) Validation Plan (post-implementation)

For code-phase execution, run:

1. `npm run check`
2. targeted tests for cap-fabric modules (to be added)

Planned test files (proposed):
- `packages/coding-agent/test/cap-fabric/contracts.test.ts`
- `packages/coding-agent/test/cap-fabric/storage.test.ts`
- `packages/coding-agent/test/cap-fabric/registry.test.ts`
- `packages/coding-agent/test/cap-fabric/commands.test.ts`

---

## 8) Risks (M1)

1. **Schema churn early in implementation**
   - Mitigation: enforce versioned contracts and migration hooks from day one

2. **YAML/JSON divergence in persisted artifacts**
   - Mitigation: pick canonical format per entity and normalize I/O adapters

3. **Path precedence ambiguity (global vs project)**
   - Mitigation: explicit deterministic precedence policy + tests

---

## 9) M1 Completion Definition

M1 is complete when:

1. Contract layer is implemented and validated
2. Storage bootstrap and repositories are stable
3. Registry read/write/list operations work
4. `/fabric` inspection commands are functional
5. Validation/test gates pass

---

## 10) Change Log

- `2026-02-27T13:42:45-06:00` — Initial M1 implementation plan created.

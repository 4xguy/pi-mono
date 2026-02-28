---
title: "Pi UCF V0: Schema Contracts"
doc_id: "ucf-pi-v0-schema-contracts"
status: "draft"
version: "0.1.0"
created_at: "2026-02-27T13:42:45-06:00"
last_updated: "2026-02-27T13:42:45-06:00"
related_docs:
  - "./2026-02-27T1339_v0-pi-universal-capability-fabric.md"
  - "./2026-02-27T1342_implementation-plan-m1.md"
---

## 1) Contract Philosophy

All persisted UCF entities must be:

1. **Versioned** (`schema_version`)
2. **Strictly validated** before use
3. **Forward-migratable** via explicit migration handlers
4. **Deterministic** in required fields and enum values

---

## 2) Shared Primitives

## 2.1 ID formats

- `capability_id`: `^[a-z0-9]+([._-][a-z0-9]+)+$`
  - examples: `google_calendar.events`, `http.generic_request`
- `profile_id`: `^[a-z0-9]+([._-][a-z0-9]+)*$`
- `run_id`: `^run_[0-9]{8}_[0-9]{6}_[0-9]{3,}$`
- `handoff_id`: `^handoff_[0-9]{8}_[0-9]{6}_[0-9]{3,}$`

## 2.2 timestamps

- RFC3339 with offset required
- example: `2026-02-27T13:42:45-06:00`

## 2.3 enums

### capability_status
- `draft`
- `tested`
- `promoted`
- `blocked`
- `deprecated`

### capability_language
- `python`
- `typescript`

### run_type
- `coordinator`
- `foundry`
- `runtime`

### run_status
- `pending`
- `running`
- `completed`
- `failed`
- `aborted`

### event_type
- `run_started`
- `task_assigned`
- `capability_generated`
- `validation_passed`
- `validation_failed`
- `capability_promoted`
- `artifact_emitted`
- `run_completed`
- `run_failed`

---

## 3) `capabilities.yaml` Registry Contract

Path:
- `cap-fabric/registry/capabilities.yaml`

Required shape:

```yaml
schema_version: "1"
updated_at: "2026-02-27T13:42:45-06:00"
capabilities:
  - id: "google_calendar.events"
    latest_version: "v0001"
    status: "promoted"
    tags: ["google", "calendar", "events"]
    manifest_path: "capabilities/google_calendar.events/manifest.yaml"
```

Constraints:
- `capabilities[]` unique by `id`
- `latest_version` must exist in capability manifest versions
- `manifest_path` must resolve to existing file

---

## 4) Capability Manifest Contract

Path:
- `cap-fabric/capabilities/<capability_id>/manifest.yaml`

Required shape:

```yaml
schema_version: "1"
id: "google_calendar.events"
name: "Google Calendar Events"
status: "promoted"
version: "v0001"
language: "python"
entrypoint: "versions/v0001/tool.py"
description: "List calendar events with time filters"
tags: ["google", "calendar", "events"]
auth:
  provider: "google"
  scopes:
    - "https://www.googleapis.com/auth/calendar.readonly"
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
  last_validated_at: "2026-02-27T13:42:45-06:00"
provenance:
  created_by: "foundry"
  source_refs:
    - "https://developers.google.com/calendar/api"
created_at: "2026-02-27T13:42:45-06:00"
last_updated: "2026-02-27T13:42:45-06:00"
```

Constraints:
- `id` matches folder name
- `entrypoint` must be relative and exist
- `timeout_sec` range: `1..3600`
- `success_rate` range: `0..1`
- `runs` integer >= 0

---

## 5) Capability Version Artifact Contract

Path:
- `cap-fabric/capabilities/<capability_id>/versions/<version>/`

Required files:
- `tool.py` or `tool.ts` (matching `language`)
- `schema.input.json`
- `schema.output.json`
- `evidence/validation-report.json`

Optional files:
- `tests/smoke.yaml`
- `tests/contract.yaml`
- `evidence/run-samples/*`

Validation report minimal contract:

```json
{
  "schema_version": "1",
  "capability_id": "google_calendar.events",
  "version": "v0001",
  "validated_at": "2026-02-27T13:42:45-06:00",
  "checks": {
    "syntax": true,
    "smoke": true,
    "contract": true,
    "policy": true
  },
  "result": "pass"
}
```

---

## 6) Profile Contract

Path:
- `cap-fabric/profiles/<profile_id>.yaml`

Required shape:

```yaml
schema_version: "1"
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
created_at: "2026-02-27T13:42:45-06:00"
last_updated: "2026-02-27T13:42:45-06:00"
```

Constraints:
- `allowed_tags` non-empty
- `max_parallel_workers` range: `1..32`

---

## 7) Run Contract

Path:
- `cap-fabric/runs/<run_id>/run.yaml`

Required shape:

```yaml
schema_version: "1"
run_id: "run_20260227_134245_001"
type: "runtime"
status: "completed"
started_at: "2026-02-27T13:42:45-06:00"
ended_at: "2026-02-27T13:44:00-06:00"
profile: "marketing"
parent_run_id: null
worker:
  id: "worker_runtime_001"
  pid: 12345
capabilities_used:
  - "google_calendar.events@v0001"
artifacts:
  - "artifacts/output.json"
error: null
```

Constraints:
- `ended_at` required when status in `completed|failed|aborted`
- `capabilities_used` entries must include `@version`

---

## 8) Event Stream Contract

Path:
- `cap-fabric/runs/<run_id>/events.jsonl`

Each line:

```json
{
  "schema_version": "1",
  "run_id": "run_20260227_134245_001",
  "event_type": "task_assigned",
  "timestamp": "2026-02-27T13:42:55-06:00",
  "payload": {
    "task": "list calendar events for next 7 days"
  }
}
```

Constraints:
- JSONL ordering must be append-only
- event timestamps must be non-decreasing

---

## 9) Handoff Contract

Path:
- `cap-fabric/handoffs/<handoff_id>.yaml`

Required shape:

```yaml
schema_version: "1"
handoff_id: "handoff_20260227_134245_001"
from_run_id: "run_20260227_134245_001"
to_run_id: "run_20260227_134500_002"
summary: "Capability promoted and ready for runtime execution"
references:
  capabilities:
    - "google_calendar.events@v0001"
  artifacts:
    - "runs/run_20260227_134245_001/artifacts/output.json"
created_at: "2026-02-27T13:45:05-06:00"
```

---

## 10) `aliases.yaml` Contract

Path:
- `cap-fabric/registry/aliases.yaml`

```yaml
schema_version: "1"
updated_at: "2026-02-27T13:42:45-06:00"
aliases:
  calendar_events: "google_calendar.events"
  gcal_events: "google_calendar.events"
```

Constraints:
- alias keys unique
- alias target must exist in capability registry

---

## 11) Validation Requirements

All loaders must enforce:

1. schema_version compatibility
2. required field presence
3. enum membership
4. path safety (no absolute traversal for relative fields)
5. cross-reference integrity (registry <-> manifests <-> versions)

Validation failure behavior:
- raise typed contract error
- include path + field + reason
- never silently coerce invalid enum/id values

---

## 12) Migration Contract (forward)

When `schema_version` changes:

1. Add explicit migrator functions `vN -> vN+1`
2. Never mutate raw persisted files in place without backup
3. Emit migration report in run/events log when auto-migrated

---

## 13) Change Log

- `2026-02-27T13:42:45-06:00` — Initial V0 schema contracts created.

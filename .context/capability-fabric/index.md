---
title: "Capability Fabric Spec Hub"
doc_id: "ucf-spec-hub"
status: "active"
version: "0.1.0"
created_at: "2026-02-27T13:44:36-06:00"
last_updated: "2026-02-27T13:44:36-06:00"
---

## Purpose

This folder contains the working specification set for the Pi **Universal Capability Fabric (UCF)**:
- ephemeral workers
- persistent capability memory
- profile-based lazy loading
- coordinator-managed execution

## Read Order

1. **V0 Architecture Spec**  
   `specs/2026-02-27T1339_v0-pi-universal-capability-fabric.md`

2. **M1 Implementation Plan**  
   `specs/2026-02-27T1342_implementation-plan-m1.md`

3. **V0 Schema Contracts**  
   `specs/2026-02-27T1342_schema-contracts-v0.md`

## Document Map

- **V0 Architecture Spec**
  - system components
  - lifecycle/state model
  - coordinator protocol
  - milestones and acceptance criteria

- **M1 Implementation Plan**
  - first execution slice
  - workstreams/tasks
  - validation and completion criteria

- **V0 Schema Contracts**
  - strict persisted data models
  - validation rules
  - migration policy

## Update Convention

When editing any spec file:
1. update `last_updated` in frontmatter
2. append a short entry to that file’s `Change Log`
3. update this index if files are added/renamed

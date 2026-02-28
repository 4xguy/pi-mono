---
title: "Handoff: Pi Capability Fabric Incubator"
doc_id: "handoff-pi-capability-fabric-2026-02-27"
status: "active"
version: "0.3.0"
created_at: "2026-02-27T15:05:57-06:00"
last_updated: "2026-02-28T13:24:31-06:00"
---

## Objective Status

- M1 foundation: complete
- M2 runtime path: complete (incubator scope)

This incubator is now testable end-to-end for capability execution lifecycle.

## Implemented Modules

### Contracts + Validation
- `src/contracts/common.ts`
- `src/contracts/capability.ts`
- `src/contracts/profile.ts`
- `src/contracts/run.ts`
- `src/contracts/event.ts`
- `src/contracts/validators.ts`

Notable updates:
- strict schema validation
- run capability refs now enforced as `<capability_id>@<version>`

### Storage + Bootstrap
- `src/storage/paths.ts`
- `src/storage/files.ts`
- `src/storage/yaml.ts`
- `src/bootstrap.ts`
- `src/registry/seed.ts`

### Repositories + Registry Service
- `src/repositories/capability-registry-repo.ts`
- `src/repositories/profile-repo.ts`
- `src/repositories/run-repo.ts`
- `src/registry/resolver.ts`
- `src/registry/registry-service.ts`

### Runtime (M2)
- `src/runtime/sandbox.ts`
- `src/runtime/local-process-sandbox.ts`
- `src/runtime/run-id.ts`
- `src/runtime/runtime-service.ts`

Capabilities:
- promoted-only execution default
- optional unpromoted override
- profile tag-policy enforcement
- sandbox execution (local process adapter)
- run/event logging and artifact emission
- failure/timeout handling with failed run state

### Commands + CLI
- `src/commands/fabric-init.ts`
- `src/commands/fabric-list.ts`
- `src/commands/fabric-show.ts`
- `src/commands/fabric-profiles.ts`
- `src/commands/fabric-runs.ts`
- `src/commands/fabric-run.ts`
- `src/commands/service.ts`
- `src/cli.ts`

Available command surface:
- `init`
- `list`
- `show`
- `run`
- `profiles`
- `runs`

## Tests Added

- `test/validators.test.ts`
- `test/repositories.test.ts`
- `test/commands.test.ts`
- `test/runtime-service.test.ts`
- `test/helpers.ts`

## Validation Results

Passed:
- `cd incubator/pi-capability-fabric && ../../node_modules/.bin/tsc --noEmit -p tsconfig.json`
- `cd incubator/pi-capability-fabric && npx tsx ../../node_modules/vitest/dist/cli.js --run test/validators.test.ts test/repositories.test.ts test/commands.test.ts test/runtime-service.test.ts`
  - 4 files, 15 tests passed

Still failing (pre-existing unrelated baseline):
- `npm run check`
- fails in `packages/web-ui` with unresolved `@mariozechner/pi-ai` / `@mariozechner/pi-agent-core` + implicit-any errors

## Practical Functional State

You can now:
1. initialize fabric storage
2. register capabilities/manifests (via repository/service APIs)
3. execute capabilities through sandbox runtime
4. persist runs/events/artifacts
5. query runs/profiles/capabilities via command layer

## Next Milestone Candidates (M3)

1. Foundry pipeline (`build/test/promote` workflow)
2. promotion evidence/validation artifacts automation
3. richer resolver ranking (quality + recency)
4. coordinator subprocess orchestration and parallel workers

## Resume Commands

```bash
# typecheck
cd incubator/pi-capability-fabric
../../node_modules/.bin/tsc --noEmit -p tsconfig.json

# run tests
npx tsx ../../node_modules/vitest/dist/cli.js --run test/validators.test.ts test/repositories.test.ts test/commands.test.ts test/runtime-service.test.ts

# sample CLI usage
npx tsx src/cli.ts init --scope project
npx tsx src/cli.ts list --scope project
npx tsx src/cli.ts run <capability-id-or-alias> --input '{"foo":"bar"}' --allow-unpromoted --scope project
npx tsx src/cli.ts runs --scope project
```

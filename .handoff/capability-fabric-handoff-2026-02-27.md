---
title: "Handoff: Pi Capability Fabric Incubator"
doc_id: "handoff-pi-capability-fabric-2026-02-27"
status: "active"
version: "0.4.0"
created_at: "2026-02-27T15:05:57-06:00"
last_updated: "2026-02-28T15:12:29-06:00"
---

## Objective Status

- M1 foundation: complete
- M2 runtime path: complete
- M3 foundry path (build/test/promote): complete (incubator scope)

## M3 Additions

### Foundry service
- `src/foundry/foundry-service.ts`

Implemented:
- `buildCapability()`
  - scaffolds manifest + versioned tool/schema/tests/evidence files
  - registers draft capability in registry
  - optional alias registration
- `testCapability()`
  - executes capability through runtime with unpromoted allowance
  - writes validation report to version evidence path
  - updates manifest/registry status to `tested` or `blocked`
  - updates quality counters
- `promoteCapability()`
  - requires `tested` status and passing validation report
  - updates manifest/registry status to `promoted`

### New commands
- `src/commands/fabric-build.ts`
- `src/commands/fabric-test.ts`
- `src/commands/fabric-promote.ts`

CLI command surface now:
- `init`
- `list`
- `show`
- `run`
- `build`
- `test`
- `promote`
- `profiles`
- `runs`

### Contract updates
- `src/contracts/capability.ts`
  - added `CapabilityValidationReportDocument`
- `src/contracts/validators.ts`
  - added `parseCapabilityValidationReportDocument()`
  - existing run capability ref enforcement retained (`<capability_id>@<version>`)

## Tests Added/Updated

Added:
- `test/foundry-service.test.ts`
- `test/foundry-commands.test.ts`

Updated:
- `test/validators.test.ts` (validation report parsing coverage)

Existing tests retained:
- `test/repositories.test.ts`
- `test/commands.test.ts`
- `test/runtime-service.test.ts`

## Validation Results (current)

Passed:
- `cd incubator/pi-capability-fabric && ../../node_modules/.bin/tsc --noEmit -p tsconfig.json`
- `cd incubator/pi-capability-fabric && npx tsx ../../node_modules/vitest/dist/cli.js --run test/validators.test.ts test/repositories.test.ts test/commands.test.ts test/runtime-service.test.ts test/foundry-service.test.ts test/foundry-commands.test.ts`
  - 6 files, 19 tests passed
- `npm run check` (repo-wide) passes in this workspace

## Practical Functional State

You can now run an end-to-end capability lifecycle in incubator:

1. `build` scaffold draft capability
2. `test` execute and generate evidence
3. `promote` transition tested capability to promoted
4. `run` execute promoted capability in runtime sandbox
5. inspect with `list/show/runs`

## Resume Commands

```bash
cd incubator/pi-capability-fabric
../../node_modules/.bin/tsc --noEmit -p tsconfig.json

npx tsx ../../node_modules/vitest/dist/cli.js --run \
  test/validators.test.ts \
  test/repositories.test.ts \
  test/commands.test.ts \
  test/runtime-service.test.ts \
  test/foundry-service.test.ts \
  test/foundry-commands.test.ts

# example flow
npx tsx src/cli.ts init --scope project
npx tsx src/cli.ts build demo.echo --name "Demo Echo" --language typescript --tags demo --alias echo
npx tsx src/cli.ts test echo --input '{"hello":"world"}'
npx tsx src/cli.ts promote echo
npx tsx src/cli.ts run echo --input '{"hello":"world"}'
```

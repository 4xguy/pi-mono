# Pi Capability Fabric (Incubator)

This folder is an incubation workspace for the **Universal Capability Fabric (UCF)** described in:

- `.context/capability-fabric/index.md`
- `.context/capability-fabric/specs/2026-02-27T1339_v0-pi-universal-capability-fabric.md`

## Goal

Build a modular system for:

1. Capability Foundry (tool creation)
2. Capability Runtime (tool execution)
3. Coordinator (worker orchestration)
4. Persistent capability/profile/run state

## Current Scope (M2 in progress)

Implemented so far:

- Contract type definitions (`src/contracts/*`)
- Strict contract validators (`src/contracts/validators.ts`)
- Path and storage bootstrap utilities (`src/storage/*`)
- Seed file generation for registry/policy/profile defaults
- Repository layer for capabilities/profiles/runs/events
- Registry service + resolver stub
- Runtime execution service with sandbox adapter (`src/runtime/*`)
- Command entrypoints:
  - `init`
  - `list`
  - `show`
  - `run`
  - `profiles`
  - `runs`

## CLI (incubator)

The incubator CLI lives at `src/cli.ts`.

Usage examples:

```bash
# initialize storage
npx tsx src/cli.ts init --scope project

# list capabilities
npx tsx src/cli.ts list --status promoted --tag google

# show one capability
npx tsx src/cli.ts show google.calendar.events

# execute a capability
npx tsx src/cli.ts run github.issues.search --input '{"query":"bug"}' --allow-unpromoted

# list profiles and runs
npx tsx src/cli.ts profiles
npx tsx src/cli.ts runs --status completed
```

## Testing

Run incubator typecheck:

```bash
cd incubator/pi-capability-fabric
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Run targeted tests:

```bash
cd incubator/pi-capability-fabric
npx tsx ../../node_modules/vitest/dist/cli.js --run test/validators.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/repositories.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/commands.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/runtime-service.test.ts
```

## Notes

- This is intentionally isolated from `packages/*` while the architecture stabilizes.
- No core `pi` package behavior is changed by this incubator.
- Promotion into a first-class package can happen after M1/M2 maturity.

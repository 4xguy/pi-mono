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

## Current Scope (M3 in progress)

Implemented so far:

- Contract type definitions (`src/contracts/*`)
- Strict contract validators (`src/contracts/validators.ts`)
- Path and storage bootstrap utilities (`src/storage/*`)
- Seed file generation for registry/policy/profile defaults
- Repository layer for capabilities/profiles/runs/events
- Registry service + resolver stub
- Runtime execution service with sandbox adapter (`src/runtime/*`)
- Foundry service for scaffold/test/promote (`src/foundry/*`)
- Command entrypoints:
  - `init`
  - `list`
  - `show`
  - `run`
  - `build`
  - `test`
  - `promote`
  - `profiles`
  - `runs`

## CLI (incubator)

The incubator CLI lives at `src/cli.ts`.

Usage examples:

```bash
# initialize storage
npx tsx src/cli.ts init --scope project

# build a draft capability scaffold
npx tsx src/cli.ts build github.issues.search --name "GitHub Issue Search" --language typescript --tags github,issues --alias gh-issues

# test a capability and write validation report
npx tsx src/cli.ts test gh-issues --input '{"query":"bug"}'

# promote tested capability
npx tsx src/cli.ts promote gh-issues

# execute promoted capability
npx tsx src/cli.ts run gh-issues --input '{"query":"bug"}'

# inspect state
npx tsx src/cli.ts list
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
npx tsx ../../node_modules/vitest/dist/cli.js --run test/foundry-service.test.ts
```

## Notes

- This is intentionally isolated from `packages/*` while the architecture stabilizes.
- No core `pi` package behavior is changed by this incubator.
- Promotion into a first-class package can happen after M3/M4 maturity.

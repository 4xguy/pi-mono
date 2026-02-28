# .pi/extensions-source

Stable, non-loaded source of extension files for this repo.

## Purpose
- Keep a canonical copy of extension code in the project without triggering extension conflicts.
- Avoid relying on timestamped backup directories.

## Important
- `pi` auto-loads from `.pi/extensions/`.
- `pi` does **not** auto-load from `.pi/extensions-source/`.

## Current workflow
- Runtime/global active extensions: `~/.pi/agent/extensions/`
- Canonical project source: `.pi/extensions-source/`
- Keep `.pi/extensions/` empty to prevent project+user duplicate registration conflicts.

## Sync command

Use the helper script from repo root:

```bash
./scripts/sync-pi-extensions.sh status
./scripts/sync-pi-extensions.sh push
./scripts/sync-pi-extensions.sh pull
```

Options:
```bash
./scripts/sync-pi-extensions.sh push --dry-run
./scripts/sync-pi-extensions.sh pull --no-delete
```

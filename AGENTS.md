# Repository Guide

## Contextual Docs

- `docs/architecture.md`: ACP transport, MCP bridge, permissions, SQLite telemetry, relay, and quota invariants.
- `docs/development.md`: Source layout, local setup, verification commands, and CI matrix.
- `docs/reference.md`: User-facing commands, settings, environment variables, and compatibility limits.
- `docs/releasing.md`: Release-please automation, npm Trusted Publishing, and publishing recovery.

## Local Verification

- `npm run check` (`tsc --noEmit`) and `npm test` (`node --test tests/*.test.mjs`) run offline against a scripted local `agy` fixture and ephemeral `127.0.0.1` sockets with no account quota or production access. Run them, fix failures caused by your change, and re-run affected checks without pausing for approval.

## Intentional Non-Bugs

- `.npmrc` sets `package-lock=false` (lockfile-free installs; `package-lock.json` is gitignored) and `peerDependencies` remain `*` per Pi package conventions.
- Cold startup without `catalog.json` intentionally starts with an empty model catalog and launches no processes, sockets, or timers until first use or `/agy-acp refresh`.
- Model pricing entries default to `0` because Antigravity uses account quota rather than per-token API billing.

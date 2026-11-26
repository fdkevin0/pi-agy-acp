# Development

Start with the [installation guide](../README.md#install) to use the extension.
For user-facing behavior and settings, see the [reference](reference.md). For
subsystem invariants, transport limits, and protocol details, see
[architecture](architecture.md).

## Setup

Clone the repository and run the extension locally:

```sh
git clone https://github.com/fdkevin0/pi-agy-acp.git
cd pi-agy-acp
npm install
pi -e ./index.ts
```

## Request flow

1. `index.ts` registers the `antigravity-acp` provider and Pi lifecycle hooks.
   The first live request starts `agy acp --process-per-session` and a loopback
   MCP HTTP/SSE bridge.
2. Session creation appends only a static MCP tool-routing preamble to `agy`'s
   system prompt. Pi's system prompt, compacted tool schemas, and replayed
   history travel in the opening prompt within the 160,000-byte replay budget;
   subsequent turns on an intact history prefix reuse the session and send only
   new input and tool deltas.
3. Model tool calls pause at the MCP bridge while Pi executes them. Pi receives
   a `toolUse` turn result and supplies tool results on its next request.
4. Those tool results resolve pending MCP requests so the same ACP turn
   continues (or start a continuation prompt if ACP settled early). Long-running
   tools relay via `pi_await_result` to keep the agent waiting cleanly.
5. `src/pi-stream.ts` drains the runtime generator before publishing completion
   so turn cleanup finishes before Pi starts the next step.

See [architecture](architecture.md) for the full lifecycle, relay, permission,
SQLite telemetry, and transport boundary invariants.

## Source layout

| File or group | Responsibility |
| --- | --- |
| `index.ts` | Provider registration, `/agy-acp` commands, TUI loaders/warnings, and Pi lifecycle hooks. |
| `src/pi-stream.ts`, `src/protocol.ts` | Pi message/stream conversion, hook contracts, and internal bridge event types. |
| `src/runtime.ts`, `src/conversation.ts`, `src/history.ts` | Session orchestration, capacity/sweeper lifecycle, pending/relayed tool calls, usage accounting, and history replay. |
| `src/acp-process.ts`, `src/jsonrpc.ts`, `src/mcp-bridge.ts` | ACP stdio transport, NDJSON JSON-RPC peer, loopback MCP HTTP/SSE bridge, schema compression, and tool deltas. |
| `src/config.ts` | Default runtime thresholds, effort/display types, and atomic `settings.json` persistence. |
| `src/host.ts`, `src/preflight.ts`, `src/session-db.ts` | Subprocess management and env/stderr hardening, binary discovery/fingerprinting/OAuth sync, and read-only session SQLite telemetry/error inspection and artifact cleanup. |
| `src/catalog.ts`, `src/quota.ts`, `src/format.ts`, `src/util.ts` | Model catalog persistence, `/usage` quota reader and login-log email lookup, TUI notice formatting and model-to-group matching, and shared utilities. |
| `src/version.ts` | Package version read from `package.json` for ACP/MCP handshakes. |
| `tests/` | Scripted local `agy` fixture (`fake-agy.mjs`), unit tests, and Pi integration tests. |

Upstream provenance and licensing are recorded in [NOTICE](../NOTICE) and
[LICENSE](../LICENSE).

## Verification

```sh
npm run check
npm test
pi --no-extensions -e ./index.ts --list-models antigravity-acp
```

Tests run directly with Node's native TypeScript support using a scripted local
`agy` substitute so `npm test` runs offline without consuming account quota.
Tests bind ephemeral loopback sockets on `127.0.0.1`.

Automated tests cover ACP transport and sessions, JSON-RPC framing, MCP bridge
boundaries and permissions, model/account discovery, session SQLite inspection,
Pi streaming and cancellation, and quota UI behavior. `--list-models` verifies
extension loading, not live service access.

Inspect package contents before publishing:

```sh
npm pack --dry-run
```

## CI and pull requests

- `ci.yml` runs on pull requests and pushes to `main`. It validates the pinned
  `devDependencies` baseline (`1.5.2`) on Node.js 22.19.0 and 24, plus a
  `pi-compat` matrix across `@earendil-works/pi-*` `1.5.0` and latest `1.5` on
  Node.js 24.
- Host `peerDependencies` stay `*` per Pi package conventions. `.npmrc` sets
  `package-lock=false` so installs remain lockfile-free via `npm install`.
- All changes to `main` require a pull request, passing CI across the matrix,
  and resolved review discussions, then squash merge (no second-person approval
  is required).

For automated releases, npm Trusted Publishing, and recovery procedures, see
[releasing](releasing.md).

## Documentation conventions

Keep all project documentation in English and organize by progressive
disclosure:

- `README.md`: first successful run, commands overview, and essential limits.
- `docs/reference.md`: user- and operator-facing behavior, configuration, and
  compatibility limits.
- `docs/development.md`: contributor setup, source layout, verification, and CI.
- `docs/architecture.md`: subsystem invariants, protocol contracts, and
  security boundaries.
- `docs/releasing.md`: maintainer release automation and publishing recovery.

Link to the owning document instead of duplicating details, and keep all linked
documentation covered by `package.json`'s `files` list (`docs/` is included as
a directory).

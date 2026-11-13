# Development

Start with the [installation guide](../README.md#install) to use the extension.
For settings and user-visible limits, see the [reference](reference.md).

Clone the repository and install its dependencies:

```sh
git clone https://github.com/fdkevin0/pi-agy-acp.git
cd pi-agy-acp
npm install
pi -e ./index.ts
```

## Request flow

1. The extension registers `antigravity-acp` with Pi. The first request starts
   `agy acp --process-per-session` and a loopback MCP bridge.
2. Pi messages and tool definitions are converted into an ACP prompt. The runtime
   reuses a session when its history prefix still matches; otherwise it replays
   the available history into a new session.
3. Model tool calls reach the bridge and remain pending while Pi executes them.
   Pi receives a `toolUse` result, then supplies tool results on its next request.
4. Those results resolve the pending MCP requests, allowing the same ACP turn to
   continue. Long-running tools use a relay to keep the agent waiting.
5. The adapter drains the runtime's generator before publishing completion, so
   session cleanup finishes before Pi can start its next step.

- **Model discovery:** Registration and cache-only refresh start no processes,
  sockets, or timers. Concurrent refreshes share a discovery session; after a live
  catalog is observed, later refreshes reuse it unless forced. Refresh suppresses
  provider re-registration so it cannot cancel itself. Cancellation ends the
  caller's wait; shared discovery still closes its session and cleans its files.
- **Session lifecycle:** The bridge binds to `127.0.0.1`, uses per-session bearer
  credentials, and validates structured tool identity before granting permissions.
  Tree navigation and compaction close conversation sessions and their files,
  retaining the process, bridge, and caches. Pi 1.5.0 reports completed switches
  through `session_start` (`new`, `resume`, or `fork`), which uses the same light
  reset if the runtime survives. `session_shutdown` and `/agy-acp reset` dispose
  the runtime. Runtime ownership moves from active to disposing to disposed;
  disposal is shared by concurrent callers and rejects new work immediately.
  Preflight and lock waiters cancel without waiting for the underlying operation.
  Startup tracks the child before ACP initialize, stops it on disposal, and drains
  bridge binding before closing the listener. Late session replies roll back
  instead of registering a conversation or tenant. ACP stop closes the JSON-RPC
  peer immediately so pending initialize/session requests reject without waiting
  for child exit. Bridge shutdown destroys tracked sockets, including incomplete
  requests and SSE connections.
  A turn owns cancellation through streaming and parked tool execution. Only a
  fully drained `tool-calls` handoff preserves it; early iterator closure, callback
  failure, abort, or owning-run settlement abandons all tool waiters and marks
  partial ACP history for rebuilding. A request cancelled while startup or a
  conversation lock is pending emits `finish(aborted)` after acquiring ownership,
  without opening a new ACP session. Startup and disposal failures still reject.
  Cancellation takes priority over buffered output and batched tools. Streaming cleanup waits for prompt settlement for up
  to five seconds; releasing a parked turn is immediate. Signal callbacks check
  turn identity, and ACP callbacks check the session's tenant identity before
  changing conversation state. Parked tools have no inactivity deadline.

  Provenance: installed Pi **1.5.2** `pi-agent-core/dist/agent-loop.js` passes
  the run signal to both `streamAssistantResponse` and `executeToolCalls`.
  `pi-coding-agent/dist/core/agent-session.js::_emitAgentSettled` awaits extension
  handlers after the run finishes; `core/extensions/types.d.ts::AgentSettledEvent`
  guarantees no automatic retry, compaction, or queued continuation remains.
  Its context exposes `sessionManager.getSessionId()`. The settlement hook uses
  that ID regardless of selected provider, before quota gating. Tests use local
  scripted ACP sessions and controlled queue boundaries, not live account traffic.
- **Quota and TUI:** Settled checks share the reader's TTL and in-flight request
  without blocking Pi. Model selection reads memory only. UI generation checks
  discard stale background results; warning keys include bucket, reset time, and
  threshold. An explicit quota query can discover uncached account tiers through
  one tool-less ACP session per runtime, persisting the tier in `catalog.json`.
  Email lookup reads at most the last 64 KiB of each candidate login log and uses
  the last match in the first matching file. Runtime warnings stay off stderr to
  preserve TUI rendering; diagnostics use status and agy's logs.
- **Pi stream and error contracts:** `onPayload` can replace the request, and
  `onProviderStreamEvent` observes events before conversion. At the first stream
  event, `onResponse` receives synthetic status `200` and empty headers before
  normalization; startup failures and an initial aborted finish emit no response.
  ACP supplies no HTTP response metadata. Context overflow and exhausted quota
  receive `context_length_exceeded` and `quota exceeded` markers for Pi's
  compaction and retry decisions; transport timeouts remain distinct.

## MCP HTTP boundary

The loopback bridge returns 400 for invalid URLs and 413 for authenticated POST
bodies exceeding 1 MiB (1,048,576 bytes), including chunked uploads. Rejected
oversized uploads close their connection after the error response. JSON parse
errors retain the MCP parse-error response. Unexpected handler failures return
500 before headers or destroy an already-started response; listener errors go to
the diagnostic sink.

Node's HTTP parser enforces a 10-second header reception deadline and a 30-second
whole-request reception deadline, checked every second. These are absolute
reception limits, including trickling clients, not tool execution deadlines:
completed requests may keep SSE responses open for long approvals, tools, and
relay waits. Idle keepalive sockets use Node's default timeout. Shutdown stops
accepting connections and destroys all HTTP connections, including incomplete
headers, bodies, and active streams, without waiting for tool promises.

Boundary regressions run in `tests/mcp-bridge.test.mjs`, including the isolated
unauthenticated `GET http://[` crash probe. Deadline probes stop uploading when a
response arrives and accept `ECONNRESET` only after the complete Node 408 response:
Node 26.13.1's `socketOnError` writes that response then destroys the socket.
Controlled TCP peers verify that missing/partial responses and unrelated resets
still fail. The implementation choices were
checked against Node 26.13.1's embedded `_http_server` source (`checkConnections`,
`onRequestTimeout`, and `closeAllConnections`) and live loopback traffic;
`Readable.iterator({ destroyOnReturn: false })` preserves the socket long enough
to flush a 413 when body iteration stops early.

## Source layout

| File or group | Responsibility |
| --- | --- |
| `index.ts` | Provider registration, commands, and Pi lifecycle hooks. |
| `src/pi-stream.ts`, `src/protocol.ts` | Pi message conversion and bridge event contracts. |
| `src/runtime.ts`, `src/conversation.ts`, `src/history.ts` | Session orchestration, pending calls, tool identity metadata, streaming, and history replay. |
| `src/acp-process.ts`, `src/jsonrpc.ts`, `src/mcp-bridge.ts` | ACP transport, local MCP server, tool schema compression, and tool deltas. |
| `src/host.ts`, `src/preflight.ts`, `src/config.ts` | Process execution, executable discovery, and isolated home setup. |
| `src/catalog.ts`, `src/quota.ts`, `src/format.ts`, `src/util.ts` | Model catalog, quota queries, TUI notice formatting, and shared utilities. |
| `src/version.ts` | ACP/MCP version read from `package.json`. |
| `tests/` | Scripted agy fixture, runtime tests, and Pi integration tests. |

Upstream provenance and licensing are recorded in [NOTICE](../NOTICE) and
[LICENSE](../LICENSE).

## Verification

```sh
npm run check
npm test
pi --no-extensions -e ./index.ts --list-models antigravity-acp
```

Tests run directly with Node's native TypeScript support; `tsx` is not required.
Automated tests use a scripted local `agy` substitute so `npm test` runs offline
without consuming account quota. They need permission to listen on `127.0.0.1`.

Tests cover ACP transport and sessions, tool routing and permissions, model and
account discovery, Pi streaming and cancellation, and quota UI behavior.
Listing models verifies extension loading, not access to the real service.

To inspect the package contents without publishing:

```sh
npm pack --dry-run
```

## CI and releases

`ci.yml` checks pull requests and pushes to `main`. `release.yml` runs only for
version-tag pushes or manual runs on an existing tag, so ordinary commits do not
run a second test suite or trigger publication. Both use Node.js 24. There is no
committed lockfile, so dependency installation uses `npm install`.

To release, bump `package.json`, commit the change, and push its matching
`vX.Y.Z` tag. The workflow accepts stable versions only; publish one version at
a time and never move a published tag. It validates the tag and version, then
checks, tests, and packs before publishing. Only a registry 404 means the version
is absent; network, authentication, and server errors stop the job.

Configure npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
for owner `fdkevin0`, repository `pi-agy-acp`, and workflow filename `release.yml`.
The workflow grants OIDC permission to the publish job and uses npm >= 11.5.1.
An optional `NPM_TOKEN` repository secret supports token authentication through
`NODE_AUTH_TOKEN`; use a granular write token with the required 2FA bypass.

If npm publication succeeds but GitHub Release creation fails, rerun that tagged
workflow, or use `gh workflow run release.yml --ref vX.Y.Z`. Branch-based manual
runs are rejected. Existing npm versions are not republished, and GitHub Releases
are created only for existing tags with `gh release create --verify-tag`.

## Documentation conventions

Keep all project documentation in English. Use progressive disclosure:

- Keep the README focused on the first successful run and essential limitations.
- Put operational details in the reference and implementation details in this guide.
- Link to the relevant section instead of duplicating detailed explanations.
- Include linked documentation in the package's `files` list.

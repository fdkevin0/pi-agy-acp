# Development

Start with the [installation guide](../README.md#install) to use the extension.
For settings and user-visible limits, see the [reference](reference.md).

For development, run these commands from your clone:

```sh
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

Provider registration and cache-only refresh do not start processes, sockets, or
timers. Successful session replacement is cleaned up through `session_shutdown`;
pre-switch and pre-fork interception hooks do not reset the runtime.

The bridge binds to `127.0.0.1`, uses per-session bearer credentials, and checks
structured tool identity before granting permissions. Session changes and
compaction trigger cleanup and rebuilding; shutdown closes processes and the bridge.

## Source layout

| File or group | Responsibility |
| --- | --- |
| `index.ts` | Provider registration, commands, and Pi lifecycle hooks. |
| `src/pi-stream.ts`, `src/protocol.ts` | Pi message conversion and bridge event contracts. |
| `src/runtime.ts`, `src/conversation.ts`, `src/history.ts` | Sessions, pending tool calls, streaming, and history replay. |
| `src/acp-process.ts`, `src/jsonrpc.ts`, `src/mcp-bridge.ts` | ACP transport and local MCP server. |
| `src/host.ts`, `src/preflight.ts`, `src/config.ts` | Process execution, executable discovery, and isolated home setup. |
| `src/catalog.ts`, `src/quota.ts`, `src/format.ts`, `src/util.ts` | Model catalog, quota queries, TUI notice formatting, and shared utilities. |
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

Coverage includes tool suspension and resumption, parallel calls, permission
checks, cancellation, history rewrites, images, quota errors, model discovery,
account metadata caching, bounded login-log reads, and Pi stream completion.
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

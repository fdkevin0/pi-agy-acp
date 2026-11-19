# Reference

For installation and your first request, start with the [installation guide](../README.md#install).

## Commands

| Command | Behavior |
| --- | --- |
| `/agy-acp` or `/agy-acp status` | Show a status panel with runtime state, paths, sessions, model reasoning levels, and the last turn. |
| `/agy-acp quota [used\|remaining]` | Show account details, grouped quota bars, and reset countdowns, optionally switching and remembering the display mode. |
| `/agy-acp reset` | Close ACP sessions; the next request rebuilds a session from Pi's history. |

Subcommands support completion with Tab. Unknown arguments display
`Usage: /agy-acp [status|quota [used|remaining]|reset]` as a warning.

### Status panel

The panel marks the runtime as idle, starting, ready, or in error. Before the first
turn, it shows the isolated home and notes that agy has not been probed yet;
viewing status does not start it. Models list their supported reasoning levels,
including a fixed level where applicable.

Once a turn finishes, its summary shows the model, effort, outcome (`completed`,
`aborted`, or `error`), duration, and retry notice count when nonzero. Duration
covers the ACP turn, including time waiting for Pi tools, but excludes startup.
A parked tool call is still part of an active turn, not a completed turn.
Runtime errors use an error notification; a failed last turn with an otherwise
healthy runtime uses a warning.

### Quota panel

In interactive TUI mode, a bordered loader displays `Fetching Antigravity quota...`
while the request is pending. Press Escape to cancel waiting and return to the
editor. The underlying quota query may finish and update the cache, but its result
will not appear after cancellation. Non-TUI modes query directly without a loader.

Quota is read through `agy -p /usage --output-format json`. Each model group has
one row per quota window, with a 12-cell bar, a rounded percentage, and a relative
reset time. By default (`used` mode), bars and percentages count up from `0%`; pass
`remaining` (`/agy-acp quota remaining`) to count down from `100%`. The last
selected mode is saved in `settings.json` inside `PI_AGY_HOME`. For example:

```text
Antigravity Quota
  Account:  user@example.com · Google AI Ultra

  Gemini Models
    Gemini Flash, Gemini Pro
    5h      [░░░░░░░░░░░░]   0% · resets in 4h 59m
    weekly  [█░░░░░░░░░░░]   9% · resets in 6d 7h
```

Missing values display `n/a`; an elapsed reset time displays `resetting soon`.
Severity uses the actual remaining fraction rather than the rounded percentage:

| Condition | Notification |
| --- | --- |
| All known windows above 20% remaining (<80% used) | Info |
| Any window at or below 20% remaining (≥80% used), with none at or below 5% remaining | Warning |
| Any window at or below 5% remaining (≥95% used), or a failed quota query | Error |

Errors include the reason. If cached groups are available after a failed query,
the title marks them as `(stale)` and still displays their bars. An empty
successful response displays `No quota data available.`.

### Account details

Both panels show the email and subscription plan when known, omitting unavailable
fields. If no plan is cached, the first `/agy-acp quota` query also tries to discover
it. This may start ACP but sends no model prompt; failure does not prevent quota
from appearing. Use `/agy-acp reset` to retry discovery. Viewing status never starts it.

The email comes from login logs. With the default home only, the extension also
checks `~/.gemini/antigravity-cli/cli.log` if needed; a custom `PI_AGY_HOME` stays
isolated. Cached plans and login logs can be stale after an account change.

### Quota status and warnings

When a run using `antigravity-acp` fully settles, the extension checks `/usage`
in the background and shows a compact status indicator such as `AGY 20%` (or
`AGY 80%` in `remaining` mode). It uses the lowest known remaining window across
the selected model's matching quota group(s) (or an unambiguous generic family
group), and omits the status indicator and low-quota warning when group ownership is
unknown or ambiguous. Failed background checks stay silent. Successful results
and failures both respect the two-minute quota TTL, and concurrent background
checks share the in-flight query.

At or below 20% and 5% remaining (≥80% and ≥95% used), a warning appears once
per group, quota window, reset time, and threshold. `/agy-acp quota` explicitly
refreshes quota and updates the status indicator; `/agy-acp status` uses fresh
cached quota only. Neither session start nor model selection launches a quota
command. Selecting another provider hides the status indicator; returning to
Antigravity uses only a fresh in-memory snapshot. `/agy-acp reset` clears the
status indicator and warning history; shutdown clears the status indicator.

When the active model belongs to `antigravity-acp`, this extension vetoes Pi's
automatic prompt-cache warming to avoid background warming requests consuming
quota. Other providers' warming decisions are left unchanged.

## Configuration

Set these environment variables before starting Pi:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PI_AGY_COMMAND` | Absolute path to the `agy` executable. | Automatic discovery. |
| `PI_AGY_HOME` | Dedicated directory for this extension's agy state. | `~/.pi/agent/cache/antigravity-acp` |
| `PI_AGY_QUOTA_DISPLAY` | Startup quota display mode (`used` or `remaining`), overriding `settings.json` for startup. Invalid values are ignored; `/agy-acp quota <mode>` overrides it for the active session. | `settings.json`, then `used` |

For example:

```sh
PI_AGY_COMMAND=/absolute/path/to/agy pi -e ./index.ts
```

### Stored data and authentication

The dedicated directory isolates the bridge agent from your normal agy tools and
plugins. It contains agy-managed session data, logs, and the extension's model cache.

Temporary session data and old logs are removed automatically. The current log,
model cache, `settings.json` (quota display preference), and authentication files
are retained; sessions rebuild from Pi's history. Cleanup is best-effort if files are locked. Use a different `PI_AGY_HOME`
for each concurrently running Pi instance, since startup cleanup assumes exclusive
use of the directory.

With file-backed authentication, the extension copies the existing OAuth token
from your normal agy directory and sets its permissions to `0600`. Do not commit
or share this directory. Authentication and token refresh remain agy's responsibility.

## Models and context

Loading the extension uses the cached catalog, or five fallback model families,
without starting agy. Model refresh or the first request updates available models
and reasoning levels from ACP. A forced refresh queries again; refreshes can be
cancelled. The selector exposes only the reasoning levels offered for each model.
Direct requests map `minimal` to `low` and `max` to `xhigh`; `off` uses the
runtime default. A family that does not offer the requested effort runs at the
nearest one it offers, so `xhigh` or `max` runs at `high` on families without `xhigh`.

The fallback families are:

- `gemini-4-argon`
- `gemini-3.8-flash`
- `claude-opus-5-5`
- `claude-sonnet-5-5`
- `gpt-oss-120b-medium`

These entries are defaults, not a guarantee of account access. Model context windows
start at `0` until learned dynamically from the server-issued `max_context_tokens`
metadata in the session database and cached per model in `catalog.json`. The history
replay budget is 160,000 bytes; older history can be omitted to fit, and historical
images become text placeholders.

## Usage and costs

Usage comes from the ACP session rather than per-step API headers. Parked `toolUse`
steps emit zero usage; statistics arrive on the final step when the full ACP turn
finishes (accumulated across any automatic `max_tokens` continuations). `max_context_tokens`
recorded in the session SQLite metadata supplies the model's context window, while
`usage_update` supplies live token occupancy.

The extension separates cumulative token consumption from final-call context
occupancy:

- `input`, `output`, `cacheRead`, and `cacheWrite` preserve unscaled cumulative
  turn totals from `session/prompt`, so Pi's session totals and flat pricing
  overrides reflect full multi-step consumption.
- `totalTokens` (which feeds Pi's context meter and auto-compaction threshold via
  `calculateContextTokens`) uses the final model call's live `usage_update.used`
  count when `agy` provides it. When `usage_update` is absent, it falls back to
  averaging the final `session/prompt` segment's prompt tokens across that
  segment's model calls plus final-segment output tokens; this fallback is an
  estimate rather than an exact per-step measurement.

Default model prices are zero because pricing is unavailable. If you configure
Pi model pricing overrides, flat per-million rates price the cumulative turn
buckets accurately; tiered `inputTokensAbove` rules evaluate against cumulative
turn prompt tokens rather than per-call prompt sizes. These estimates are not
an invoice amount or a promise of free access.

The extension reads only session-scoped `max_context_tokens` metadata inside `PI_AGY_HOME`;
it never inspects your global `agy` databases or invokes or distributes binary patch
scripts.

## Compatibility limits

This version targets the `@earendil-works/*` Pi packages at version 1.5.x.
Host `peerDependencies` use `*` as required by Pi package conventions;
`devDependencies` pin a reproducible CI baseline (`1.5.2`), and CI validates
both that baseline (on Node.js 22.19.0 and 24) and the `1.5.x` host range
(`1.5.0` and latest `1.5`), which requires Node.js >= 22.19.0. Compatibility
with older `@mariozechner/*` interfaces is not claimed.

Sampling parameters, output limits, forced `toolChoice`, and provider-scoped
environment overrides are not mapped to ACP. See
[development checks](development.md#verification) for the scope of automated validation.

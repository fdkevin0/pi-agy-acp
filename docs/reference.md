# Reference

For installation and your first request, start with the [installation guide](../README.md#install).

## Commands

| Command | Behavior |
| --- | --- |
| `/agy-acp` or `/agy-acp status` | Show a status panel with runtime state, paths, sessions, model reasoning levels, and the last turn. |
| `/agy-acp quota` | Show account details, grouped quota bars, and reset countdowns. |
| `/agy-acp reset` | Close ACP sessions; the next request rebuilds a session from Pi's history. |

Subcommands support completion with Tab. Unknown arguments display
`Usage: /agy-acp [status|quota|reset]` as a warning.

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
one row per quota window, with a 12-cell bar showing the remaining fraction,
a rounded percentage, and a relative reset time. For example:

```text
Antigravity Quota
  Account:  user@example.com · Google AI Ultra

  Gemini Models
    Gemini Flash, Gemini Pro
    5h      [████████████] 100% · resets in 4h 59m
    weekly  [███████████░]  91% · resets in 6d 7h
```

Missing values display `n/a`; an elapsed reset time displays `resetting soon`.
Severity uses the actual remaining fraction rather than the rounded percentage:

| Condition | Notification |
| --- | --- |
| All known windows above 20% | Info |
| Any window at or below 20%, with none at or below 5% | Warning |
| Any window at or below 5%, or a failed quota query | Error |

Errors include the reason. If cached groups are available after a failed query,
the title marks them as `(stale)` and still displays their bars. An empty successful
response displays `No quota data available.`.

### Account details

Both panels show the email and subscription plan when known. The plan comes from
ACP session metadata and is saved in `catalog.json`. If no plan is cached, the
first quota check also tries a tool-less ACP discovery session in parallel with
the quota query. This starts ACP but sends no model prompt. Discovery is attempted
once per runtime; failure still allows the quota result to appear. Use
`/agy-acp reset` to allow another attempt. Viewing status never starts discovery.

The email is read from the latest login entry in the last 64 KiB of the isolated
home's `acp.log`; it is not saved in the model cache. With the default home only,
the reader also checks `~/.gemini/antigravity-cli/cli.log` if needed. A custom
`PI_AGY_HOME` never falls back to that global log. Either field appears on its own
when the other is unavailable; the account line is omitted when neither is known.
These details are best-effort: cached plans and login logs can be stale after an
account change.

## Configuration

Set these environment variables before starting Pi:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PI_AGY_COMMAND` | Absolute path to the `agy` executable. | Automatic discovery. |
| `PI_AGY_HOME` | Dedicated directory for this extension's agy state. | `~/.pi/agent/cache/antigravity-acp` |

For example:

```sh
PI_AGY_COMMAND=/absolute/path/to/agy pi -e ./index.ts
```

### Stored data and authentication

The dedicated directory isolates the bridge agent from your normal agy tools and
plugins. It contains agy-managed session data, logs, and the extension's model cache.

With file-backed authentication, the extension copies the existing OAuth token
from your normal agy directory and sets its permissions to `0600`. Do not commit
or share this directory. Authentication and token refresh remain agy's responsibility.

## Models and context

Loading the extension reads the cached model catalog, or falls back to five model
families, without starting agy. Pi's model refresh queries ACP for the account's
catalog. The first request also discovers models and validates the selection.
Cache-only refreshes and refreshes already cancelled before startup do not launch
ACP. Server-advertised models are not hidden, and live catalog changes update
Pi's model selector. The selector exposes only the ACP reasoning levels offered
for each model. Direct requests map `minimal` to `low` and `xhigh` or `max` to
`high`; `off` leaves the ACP effort unspecified, using the runtime default.

The fallback families are:

- `gemini-4-argon`
- `gemini-3.8-flash`
- `claude-opus-5-5`
- `claude-sonnet-5-5`
- `gpt-oss-120b-medium`

These entries are defaults, not a guarantee of account access. Context declarations
are 256,000 tokens, or 131,072 for GPT-OSS. The history replay budget is 160,000 bytes;
older history can be omitted to fit, and historical images become text placeholders.

## Usage and costs

Usage comes only from the ACP `session/prompt` result. Parked tool steps have no
separate usage report; statistics arrive when the full ACP turn finishes.
For turns spanning multiple model steps, input token buckets use the upstream
implementation's averaging method. They are not an exact per-step measurement.

Default model prices are zero because pricing is unavailable. If you configure
Pi model pricing overrides, reported usage is priced using those rates. These
estimates are not an invoice amount or a promise of free access.

The extension does not inspect agy's private databases or invoke or distribute
binary patch scripts.

## Compatibility limits

This version targets the `@earendil-works/*` Pi packages at version 1.5.x.
Host peer dependencies use `*` as required by Pi package conventions; validation
has been performed against version 1.5.0. Compatibility with older
`@mariozechner/*` interfaces is not claimed.

The bridge supports `onPayload` request replacement and `onProviderStreamEvent`
observation before conversion to Pi events. At the first ACP stream event, it
invokes `onResponse` with synthetic status `200` and empty headers before
normalizing that event. This is a Pi instrumentation notification, not an HTTP
response from agy. Startup errors before the first event do not emit it.

Sampling parameters, output limits, forced `toolChoice`, and provider-scoped
environment overrides are not mapped to ACP. See
[development checks](development.md#verification) for the scope of automated validation.

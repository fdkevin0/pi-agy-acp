# Reference

For installation and your first request, start with the
[installation guide](../README.md#install). For internal protocol and runtime
details, see [architecture](architecture.md).

## Commands

| Command | Behavior |
| --- | --- |
| `/agy-acp` or `/agy-acp status` | Show a status panel with runtime state, paths, account details, sessions, model reasoning levels, and the last turn. |
| `/agy-acp quota [used\|remaining]` | Show account details, grouped quota bars, and reset countdowns, optionally switching and saving the display mode. |
| `/agy-acp refresh` | Force a live model catalog refresh from `agy` and update `catalog.json`. |
| `/agy-acp reset` | Dispose the ACP runtime (stopping `agy`), clear sessions, status indicator, quota cache, and warning history; the next request rebuilds from Pi's history. |

Subcommands support Tab completion (`status`, `quota`, `quota used`,
`quota remaining`, `refresh`, `reset`). Unknown arguments show
`Usage: /agy-acp [status|quota [used|remaining]|refresh|reset]` as a warning.

In interactive TUI mode, `/agy-acp quota` (`Fetching Antigravity quota...`) and
`/agy-acp refresh` (`Refreshing Antigravity models...`) display a cancellable
loader. Pressing Escape returns to the editor: `/agy-acp refresh` cancels the
caller's wait, while `/agy-acp quota` hides the pending panel even if the
underlying `/usage` query finishes updating the cache. Non-TUI modes run
directly without a loader.

### Status panel

The panel reports the runtime as `idle`, `starting`, `ready`, or `error`.
Viewing status never starts `agy`; before `agy` has been probed (by a turn,
`/agy-acp refresh`, or plan discovery), it shows the isolated home and notes
that `agy` starts lazily. Models list their supported reasoning levels,
including a fixed level where applicable.

Once a turn finishes, its summary shows the model, effort, outcome (`completed`,
`aborted`, or `error`), duration, and retry notice count when nonzero. Duration
covers the ACP turn, including time waiting for Pi tools, but excludes startup.
A parked tool call is still part of an active turn, not a completed turn.
Runtime errors use an error notification; a failed last turn with an otherwise
healthy runtime uses a warning.

### Quota panel

Quota is read through `agy -p /usage --output-format json`. Disabled quota
buckets are excluded. Each model group renders one row per usable quota window
with a 12-cell bar, a rounded percentage, and a relative reset countdown:

```text
Antigravity Quota
  Account:  user@example.com · Google AI Ultra

  Gemini Models
    Gemini Flash, Gemini Pro
    5h      [░░░░░░░░░░░░]   0%
    weekly  [█░░░░░░░░░░░]   9% · resets in 6d 7h
```

- **Display mode:** Default is `used` (bars and percentages count up from `0%`).
  Pass `remaining` (`/agy-acp quota remaining`) to count down from `100%`. When
  a mode is passed, it is saved to `<PI_AGY_HOME>/settings.json` immediately,
  even if the quota query is cancelled or fails.
- **Reset labels:** Untouched rolling windows at `0%` used (`100%` remaining)
  whose reset time is still a full window away omit the countdown. Otherwise,
  missing values show `n/a`, elapsed resets show `resetting soon`, unparseable
  timestamps show `reset time unavailable`, and sub-minute windows show
  `resets in <1m`.
- **Empty and stale responses:** A group with no usable windows shows
  `No quota windows available.`, and an empty successful response shows
  `No quota data available.`. Failed queries include the reason; if cached
  groups exist, the title marks them `(stale)` and still renders their bars.

Notification severity uses the actual remaining fraction rather than the rounded
percentage:

| Condition | Notification |
| --- | --- |
| All known windows above 20% remaining (<80% used) | Info |
| Any window at or below 20% remaining (≥80% used), none at or below 5% remaining | Warning |
| Any window at or below 5% remaining (≥95% used), or a failed quota query | Error |

### Account details

Both panels display the email and subscription plan when known and omit
unavailable fields:

- **Plan:** If no plan is cached, the first `/agy-acp quota` query attempts
  discovery using a temporary tool-less ACP session (stopped afterward if the
  runtime was idle) without sending a model prompt. Failure does not block quota
  display; use `/agy-acp reset` to retry discovery. Viewing status never probes
  `agy`.
- **Email:** Read from `agy` login logs. With the default `PI_AGY_HOME`, the
  extension also checks `ANTIGRAVITY_CLI_HOME`, `AGY_HOME`, and
  `~/.gemini/antigravity-cli`; a custom `PI_AGY_HOME` stays isolated. Cached
  plans and login logs can be stale after an account change.

### Quota status and warnings

After an `antigravity-acp` run settles, the extension refreshes `/usage` in the
background (sharing any in-flight request and respecting the 2-minute TTL) and
displays a compact status bar indicator such as `AGY 20%` (or `AGY 80%` in
`remaining` mode):

- The percentage reflects the lowest known remaining window across the active
  model's matching quota group(s). When group ownership is unknown or ambiguous
  (including effort-capped pools without a known effort), the indicator and
  low-quota warning are omitted.
- Background query failures stay silent and also respect the 2-minute TTL.
- Low-quota warnings fire once per group, window, reset time, and threshold at
  or below 20% remaining (≥80% used) and 5% remaining (≥95% used).
- `/agy-acp quota` refreshes quota and updates the indicator; `/agy-acp status`
  uses fresh cached quota only. Neither session start nor model selection starts
  a quota command (switching between `antigravity-acp` models while a post-turn
  check is already in flight retargets that check to the newly selected model).
- Selecting another provider hides the indicator; returning to Antigravity uses
  only a fresh in-memory snapshot. `/agy-acp reset` clears the indicator and
  warning history; shutdown clears the indicator.

Two automatic Pi safeguards also apply when `antigravity-acp` is the active
provider (other providers are untouched):

- **Prompt-cache warming veto:** Cancels Pi's automatic prompt-cache warming so
  background warming requests do not consume Antigravity quota.
- **Auto-compaction threshold guard:** Cancels threshold-triggered compaction
  while a model's context window is still unknown (`0`).

## Configuration

Set environment variables before starting Pi:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PI_AGY_COMMAND` | Absolute path to the `agy` executable. | Automatic discovery. |
| `PI_AGY_HOME` | Dedicated directory for this extension's state. | `~/.pi/agent/cache/antigravity-acp` |
| `PI_AGY_QUOTA_DISPLAY` | Startup quota display mode (`used` or `remaining`), overriding `settings.json` for startup. Invalid values are ignored; `/agy-acp quota <mode>` overrides it for the active session. | `settings.json`, then `used` |
| `PI_AGY_DEBUG` | Set to `1` to print runtime warnings on `stderr` (silent by default to protect the TUI). | Unset (silent) |

```sh
PI_AGY_COMMAND=/absolute/path/to/agy pi -e ./index.ts
```

### Stored data and authentication

`PI_AGY_HOME` isolates the bridge agent from your normal `agy` tools and
plugins. It stores the extension's `catalog.json`, `settings.json` (quota
display preference), ACP logs, and `agy/` (isolated `agy` state, settings, and
session databases).

- **Cleanup:** Temporary session artifacts and old logs are removed
  automatically (best-effort if locked). Current logs, `catalog.json`,
  `settings.json`, and authentication files are retained; sessions rebuild from
  Pi's history. Use a separate `PI_AGY_HOME` for each concurrently running Pi
  instance because startup cleanup assumes exclusive directory ownership.
- **Sign-in:** Sign in with `agy` before starting Pi, or run `agy acp --login`
  in headless, SSH, or terminal-only environments. Authentication and token
  refresh remain `agy`'s responsibility.
- **OAuth sync:** With the default `PI_AGY_HOME` and file-backed auth, the
  extension atomically syncs `antigravity-oauth-token` from your normal `agy`
  directory (`ANTIGRAVITY_CLI_HOME`, `AGY_HOME`, or `~/.gemini/antigravity-cli`)
  with `0600` permissions when the isolated copy is missing, empty, or older,
  refusing symlinked paths. Sync failures warn rather than aborting startup. A
  custom `PI_AGY_HOME` stays isolated and never copies tokens from default `agy`
  directories.
- **Global quota scope:** `agy -p /usage` does not accept `--gemini-dir`, so
  quota queries always reflect the global `agy` CLI account. Do not commit or
  share `PI_AGY_HOME`.

## Models and context

- **Discovery and caching:** Loading the extension restores `catalog.json` (or
  starts empty on a fresh install) without starting `agy`. Non-forced refreshes
  (Pi startup or opening `/model`) reuse `catalog.json` without spawning `agy`
  whenever cached models match the current `agy` binary fingerprint. Live ACP
  discovery runs when no matching cache exists, on `/agy-acp refresh`, on the
  first live request, or after an `agy` binary upgrade once refreshed or
  restarted. Standalone discovery stops its temporary ACP process afterward,
  and idle ACP processes shut down automatically after sessions expire.
- **Reasoning levels:** The `/model` selector exposes only the levels offered
  for each model (`low`, `medium`, `high`, `xhigh`, `max`). Direct requests map
  `minimal` to `low`, clamp requested levels to the nearest offered effort, and
  treat `off` as the runtime default (`high`).
- **Context windows and replay:** Context windows start at `0` until learned
  dynamically from session metadata and cached per model in `catalog.json`
  against the `agy` binary fingerprint; upgrading `agy` invalidates cached
  context windows. History replay uses a 160,000-byte budget—older turns can be
  omitted to fit, and historical images become `[image]` placeholders.

## Usage and costs

Usage comes from the ACP session rather than per-step HTTP headers. Parked
`toolUse` steps emit zero usage; statistics arrive on the final step when the
ACP turn completes (accumulated across any automatic `max_tokens` continuations)
whenever `session/prompt` reports usage.

The extension separates cumulative turn consumption from final-call context
occupancy:

- `input`, `output`, `cacheRead`, `cacheWrite`, and `reasoning` preserve
  unscaled cumulative turn totals, so Pi session totals and flat pricing
  overrides reflect full multi-step consumption.
- `totalTokens` (feeding Pi's context meter and auto-compaction threshold) uses
  the final call's live token occupancy when reported by `agy`, falling back to
  the same turn's session metadata estimate and then a final-segment average
  estimate.

Default model prices are zero because upstream pricing is unavailable. With Pi
pricing overrides, flat per-million rates price cumulative turn buckets
accurately; tiered `inputTokensAbove` rules evaluate against cumulative turn
prompt tokens rather than per-call prompt sizes. These numbers are estimates,
not an invoice or a promise of free access.

Read-only SQLite inspection is restricted strictly to session-scoped databases
inside `PI_AGY_HOME` (for context windows, occupancy estimates, and hidden
terminal API error detection); the extension never reads global `agy` databases
or invokes/distributes binary patches.

## Compatibility limits

- Requires Node.js >= 22.19.0, Pi (`@earendil-works/*`) 1.5.x, and `agy` >=
  1.5.18 (which adds long-turn OAuth/503 recovery and fixes Windows cross-drive
  plugin loading). Older `@mariozechner/*` Pi interfaces are not supported.
- Sampling parameters, output limits, forced `toolChoice`, and provider-scoped
  environment overrides are not mapped to ACP.

See [verification](development.md#verification) for the automated test and
compatibility scope.

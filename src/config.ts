import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Reasoning effort ids accepted by the Antigravity ACP `thought_level` option. */
export const EFFORTS = ['low', 'medium', 'high'] as const
/** One Antigravity reasoning effort. */
export type Effort = (typeof EFFORTS)[number]

/** Supported quota percentage display conventions. */
export const QUOTA_DISPLAY_MODES = ['used', 'remaining'] as const
/** Quota percentage display convention (`used` counts up from 0%, `remaining` counts down from 100%). */
export type QuotaDisplay = (typeof QUOTA_DISPLAY_MODES)[number]

/** Validated plugin configuration. */
export interface Config {
  /** Provider route id shown in the model picker. */
  provider: string
  /** Display name of the provider group. */
  displayName: string
  /** Absolute path of the `agy` executable; empty resolves `~/.local/bin/agy`, then `agy` on PATH. */
  command: string
  /** Isolated Antigravity home for ACP sessions; empty uses `~/.pi/agent/cache/antigravity-acp`. */
  home: string
  /** Effort applied when a request carries none. */
  defaultEffort: Effort
  /** Quota percentage convention shown in the status bar and `/agy-acp quota`. */
  quotaDisplay: QuotaDisplay
  /** Maximum concurrent ACP sessions kept alive across conversations, subagents, and auxiliary calls. */
  maxLiveSessions: number
  /** Idle time after which an inactive ACP session is closed. */
  idleSessionTtlMs: number
  /** Window that groups parallel tool calls into one Pi step. */
  parkSettleMs: number
  /** SSE keepalive interval for parked tool calls. */
  keepAliveMs: number
  /** Delay in ms before a parked tool call returns a still-running relay notice to refresh cache TTL before agy's 180s MCP deadline. */
  relayAfterMs: number
  /** Automatic continuations after an output-length stop (long decode). */
  longDecodeContinuations: number
  /** Minimum interval between quota refreshes through `agy -p /usage`. */
  quotaTtlMs: number
}

export const defaults: Config = {
  provider: 'antigravity-acp',
  displayName: 'Antigravity ACP',
  command: '',
  home: '',
  defaultEffort: 'high',
  quotaDisplay: 'used',
  maxLiveSessions: 16,
  idleSessionTtlMs: 1800000,
  parkSettleMs: 250,
  keepAliveMs: 15000,
  relayAfterMs: 85000,
  longDecodeContinuations: 3,
  quotaTtlMs: 120000,
}

export function asEffort(value: string | undefined): Effort | undefined {
  return EFFORTS.includes(value as Effort) ? (value as Effort) : undefined
}

export function asQuotaDisplay(
  value: string | undefined,
): QuotaDisplay | undefined {
  const normalized = value?.trim().toLowerCase()
  return QUOTA_DISPLAY_MODES.includes(normalized as QuotaDisplay)
    ? (normalized as QuotaDisplay)
    : undefined
}

const SETTINGS_FILE = 'settings.json'

/** Read the last remembered quota display preference from `home/settings.json`. */
export function readQuotaDisplayPreference(
  home: string,
): QuotaDisplay | undefined {
  try {
    const path = join(home, SETTINGS_FILE)
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      quotaDisplay?: unknown
    }
    return typeof parsed?.quotaDisplay === 'string'
      ? asQuotaDisplay(parsed.quotaDisplay)
      : undefined
  } catch {
    return undefined
  }
}

/** Persist the user's quota display preference in `home/settings.json`. */
export function writeQuotaDisplayPreference(
  home: string,
  quotaDisplay: QuotaDisplay,
): void {
  try {
    const path = join(home, SETTINGS_FILE)
    mkdirSync(dirname(path), { recursive: true })
    let existing: Record<string, unknown> = {}
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>
        }
      } catch {
        // Overwrite malformed settings with a valid object.
      }
    }
    writeFileSync(path, JSON.stringify({ ...existing, quotaDisplay }, null, 2))
  } catch {
    // Preference persistence is best-effort.
  }
}

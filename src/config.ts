import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** Reasoning effort ids accepted by the Antigravity ACP `thought_level` option. */
export const EFFORTS = ['low', 'medium', 'high'] as const
/** One Antigravity reasoning effort. */
export type Effort = (typeof EFFORTS)[number]

/** Supported quota percentage display conventions. */
export const QUOTA_DISPLAY_MODES = ['used', 'remaining'] as const
/** Quota percentage display convention (`used` counts up from 0%, `remaining` counts down from 100%). */
export type QuotaDisplay = (typeof QUOTA_DISPLAY_MODES)[number]
/** Default quota percentage display convention when no env var or saved preference is set. */
export const DEFAULT_QUOTA_DISPLAY: QuotaDisplay = 'used'

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

/** Read a JSON file as a plain object, returning `{}` when missing or invalid. */
export function readJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Read the last remembered quota display preference from `home/settings.json`. */
export function readQuotaDisplayPreference(
  home: string,
): QuotaDisplay | undefined {
  const settings = readJson(join(home, SETTINGS_FILE))
  return typeof settings.quotaDisplay === 'string'
    ? asQuotaDisplay(settings.quotaDisplay)
    : undefined
}

/** Persist the user's quota display preference in `home/settings.json`. */
export function writeQuotaDisplayPreference(
  home: string,
  quotaDisplay: QuotaDisplay,
): void {
  const path = join(home, SETTINGS_FILE)
  const tempPath = join(
    home,
    `.${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`,
  )
  try {
    mkdirSync(home, { recursive: true })
    const existing = readJson(path)
    const content = `${JSON.stringify({ ...existing, quotaDisplay }, null, 2)}\n`
    writeFileSync(tempPath, content)
    renameSync(tempPath, path)
  } catch {
    try {
      unlinkSync(tempPath)
    } catch {
      // Best-effort cleanup.
    }
  }
}

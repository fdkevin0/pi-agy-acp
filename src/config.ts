/** Reasoning effort ids accepted by the Antigravity ACP `thought_level` option. */
export const EFFORTS = ['low', 'medium', 'high'] as const
/** One Antigravity reasoning effort. */
export type Effort = (typeof EFFORTS)[number]

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

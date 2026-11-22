/**
 * Plan quota read through the official CLI's local `/usage` command, which
 * reports each model group's weekly and five-hour windows without sending a
 * model request.
 * @module pi-agy-acp/quota
 */

import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { CommandRunner } from './preflight.ts'

/** Best-effort identity from local logs and ACP subscription metadata. */
export interface AccountInfo {
  email?: string
  plan?: string
  tierId?: string
}

const LOG_SCAN_WINDOW = 64 * 1024
const MAX_ROTATED_LOGS = 10
const ROTATED_LOG_FILE = /^(?:cli|acp-server)-.+\.log$/
const AUTH_EMAIL_PATTERN =
  /(?:applyAuthResult:\s*email=|OAuth:\s*authenticated successfully as\s+)([^\s,]+)/g
const AUTH_REQUIRED_STDERR = /Authentication required\b/i
const USAGE_MAX_STDOUT_BYTES = 1024 * 1024

function isContainedIn(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

function lastEmailInText(text: string): string | undefined {
  let email: string | undefined
  for (const match of text.matchAll(AUTH_EMAIL_PATTERN)) email = match[1]
  return email
}

function readLoggedEmailFromFile(path: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const st = fstatSync(fd)
    if (!st.isFile() || st.size <= 0) return undefined
    const tailSize = Math.min(st.size, LOG_SCAN_WINDOW)
    const buf = Buffer.alloc(tailSize)
    const tailLength = readSync(fd, buf, 0, tailSize, st.size - tailSize)
    const fromTail = lastEmailInText(buf.toString('utf8', 0, tailLength))
    if (fromTail) return fromTail
    if (st.size > LOG_SCAN_WINDOW) {
      const headLength = readSync(fd, buf, 0, LOG_SCAN_WINDOW, 0)
      return lastEmailInText(buf.toString('utf8', 0, headLength))
    }
  } catch {
    // Missing or unreadable logs do not prevent quota checks.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return undefined
}

interface LogCandidate {
  realPath: string
  mtimeMs: number
  name: string
}

function resolveContainedLog(
  realRoot: string,
  candidatePath: string,
  name: string,
): LogCandidate | undefined {
  try {
    const realPath = realpathSync(candidatePath)
    if (!isContainedIn(realRoot, realPath)) return undefined
    const st = statSync(realPath)
    if (!st.isFile()) return undefined
    return { realPath, mtimeMs: st.mtimeMs, name }
  } catch {
    return undefined
  }
}

function compareLogCandidates(a: LogCandidate, b: LogCandidate): number {
  if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs
  return a.name < b.name ? 1 : a.name > b.name ? -1 : 0
}

function collectDirectoryLogs(dir: string): string[] {
  let realRoot: string
  try {
    realRoot = realpathSync(dir)
  } catch {
    return []
  }
  const rotated: LogCandidate[] = []
  const logDir = join(realRoot, 'log')
  try {
    const realLogDir = realpathSync(logDir)
    if (isContainedIn(realRoot, realLogDir) && statSync(realLogDir).isDirectory()) {
      for (const name of readdirSync(realLogDir)) {
        if (!ROTATED_LOG_FILE.test(name)) continue
        const entry = resolveContainedLog(realRoot, join(realLogDir, name), name)
        if (entry !== undefined) rotated.push(entry)
      }
    }
  } catch {
    // Missing or unreadable rotated log directory.
  }
  rotated.sort(compareLogCandidates)
  const candidates: LogCandidate[] = rotated.slice(0, MAX_ROTATED_LOGS)
  const direct = resolveContainedLog(realRoot, join(realRoot, 'cli.log'), 'cli.log')
  if (direct !== undefined) candidates.push(direct)
  candidates.sort(compareLogCandidates)
  const seen = new Set<string>()
  const unique: string[] = []
  for (const item of candidates) {
    if (seen.has(item.realPath)) continue
    seen.add(item.realPath)
    unique.push(item.realPath)
  }
  return unique
}

/**
 * Read the latest login email across candidate log files and directories.
 * Directory entries scan `cli.log` plus the newest 10 `log/cli-*.log` and
 * `log/acp-server-*.log` files contained within that directory (sorted newest
 * first and deduplicated). Each file scans its tail 64 KiB first, falling back
 * to its head 64 KiB when larger than 64 KiB.
 */
export function readLoggedEmail(paths: readonly string[]): string | undefined {
  const seen = new Set<string>()
  for (const path of paths) {
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      for (const filePath of collectDirectoryLogs(path)) {
        if (seen.has(filePath)) continue
        seen.add(filePath)
        const email = readLoggedEmailFromFile(filePath)
        if (email) return email
      }
      continue
    }
    if (!st.isFile()) continue
    let realPath: string
    try {
      realPath = realpathSync(path)
    } catch {
      continue
    }
    if (seen.has(realPath)) continue
    seen.add(realPath)
    const email = readLoggedEmailFromFile(realPath)
    if (email) return email
  }
  return undefined
}

/** One quota window. */
export interface QuotaBucket {
  id: string
  name: string
  window: string
  remainingFraction?: number
  resetTime: string
}

/** One model group sharing its windows. */
export interface QuotaGroup {
  name: string
  description: string
  buckets: QuotaBucket[]
}

/** Quota snapshot. */
export interface QuotaSnapshot {
  status: 'ok' | 'error'
  updatedAt: string
  groups: QuotaGroup[]
  error?: string
  account?: AccountInfo
}

function parseBucket(raw: unknown): QuotaBucket | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return undefined
  const bucket = raw as Record<string, unknown>
  if (bucket.disabled === true) return undefined
  const id = String(bucket.id ?? '').trim()
  const window = String(bucket.window ?? '').trim()
  if (id.length === 0 || window.length === 0) return undefined
  return {
    id,
    name: String(bucket.name ?? ''),
    window,
    remainingFraction:
      typeof bucket.remaining_fraction === 'number' &&
      Number.isFinite(bucket.remaining_fraction)
        ? bucket.remaining_fraction
        : undefined,
    resetTime: String(bucket.reset_time ?? ''),
  }
}

/**
 * Parse `agy -p /usage --output-format json` output.
 * @param stdout - command stdout.
 * @returns the quota groups.
 */
export function parseUsage(stdout: string): QuotaGroup[] {
  const parsed = JSON.parse(stdout) as {
    command?: { data?: { groups?: unknown[] } }
  }
  const groups = parsed.command?.data?.groups
  if (!Array.isArray(groups))
    throw new Error('agy /usage returned no quota groups')
  return groups.map((raw) => {
    const group = raw as {
      name?: string
      description?: string
      buckets?: unknown[]
    }
    return {
      name: String(group.name ?? ''),
      description: String(group.description ?? ''),
      buckets: (Array.isArray(group.buckets) ? group.buckets : [])
        .map(parseBucket)
        .filter((bucket): bucket is QuotaBucket => bucket !== undefined),
    }
  })
}

/** Cached quota reader with request coalescing. */
export class QuotaReader {
  private cached: QuotaSnapshot | undefined
  // Monotonic `performance.now()` starts near 0, so `-Infinity` guarantees an empty cache is never fresh.
  private cachedAt = -Infinity
  private inflight: Promise<QuotaSnapshot> | undefined
  private readonly binary: () => string
  private readonly run: CommandRunner
  private readonly ttlMs: number
  private readonly now: () => number

  /**
   * @param binary - returns the agy executable.
   * @param run - helper command runner.
   * @param ttlMs - cache lifetime.
   * @param now - monotonic clock in milliseconds.
   */
  constructor(
    binary: () => string,
    run: CommandRunner,
    ttlMs: number,
    now: () => number = () => performance.now(),
  ) {
    this.binary = binary
    this.run = run
    this.ttlMs = ttlMs
    this.now = now
  }

  /** Fresh successful data only; never starts a command. */
  peek(): QuotaSnapshot | undefined {
    return this.cached?.status === 'ok' &&
      this.now() - this.cachedAt < this.ttlMs
      ? this.cached
      : undefined
  }

  get pending(): boolean {
    return this.inflight !== undefined
  }

  /**
   * Read the quota snapshot.
   * @param force - bypass the cache.
   * @returns the snapshot; failures resolve as `status: 'error'`.
   */
  async read(force = false): Promise<QuotaSnapshot> {
    if (
      !force &&
      this.cached !== undefined &&
      this.now() - this.cachedAt < this.ttlMs
    )
      return this.cached
    this.inflight ??= this.fetch().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async fetch(): Promise<QuotaSnapshot> {
    try {
      const binary = this.binary()
      const result = await this.run(
        [binary, '-p', '/usage', '--output-format', 'json'],
        45_000,
        {
          maxStdoutBytes: USAGE_MAX_STDOUT_BYTES,
          abortOnStderr: AUTH_REQUIRED_STDERR,
        },
      )
      if (
        result.abortedBy === 'stderr' ||
        AUTH_REQUIRED_STDERR.test(result.stderr)
      ) {
        throw new Error(
          'Antigravity requires sign-in: run `agy` once in a terminal (Authentication required)',
        )
      }
      if (result.abortedBy === 'maxStdout') {
        throw new Error(
          `agy /usage stdout exceeded ${USAGE_MAX_STDOUT_BYTES} bytes`,
        )
      }
      if (result.code !== 0)
        throw new Error(
          `agy /usage failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
        )
      const snapshot: QuotaSnapshot = {
        status: 'ok',
        updatedAt: new Date().toISOString(),
        groups: parseUsage(result.stdout),
      }
      this.cached = snapshot
      this.cachedAt = this.now()
      return snapshot
    } catch (error) {
      const snapshot: QuotaSnapshot = {
        status: 'error',
        updatedAt: new Date().toISOString(),
        groups: this.cached?.groups ?? [],
        error: error instanceof Error ? error.message : String(error),
      }
      // Apply the same TTL to failures so settled events cannot hammer an unavailable CLI.
      this.cached = snapshot
      this.cachedAt = this.now()
      return snapshot
    }
  }
}

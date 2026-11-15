/**
 * Plan quota read through the official CLI's local `/usage` command, which
 * reports each model group's weekly and five-hour windows without sending a
 * model request.
 * @module pi-agy-acp/quota
 */

import { openSync, fstatSync, readSync, closeSync } from 'node:fs'
import type { CommandRunner } from './preflight.ts'

/** Best-effort identity from local logs and ACP subscription metadata. */
export interface AccountInfo {
  email?: string
  plan?: string
  tierId?: string
}

/** Read the latest login in the first matching log, bounded to its last 64 KiB. */
export function readLoggedEmail(paths: readonly string[]): string | undefined {
  for (const path of paths) {
    let fd: number | undefined
    try {
      fd = openSync(path, 'r')
      const size = fstatSync(fd).size
      const tail = Buffer.alloc(Math.min(size, 64 * 1024))
      const length = readSync(fd, tail, 0, tail.length, size - tail.length)
      const pattern =
        /(?:applyAuthResult:\s*email=|OAuth:\s*authenticated successfully as\s+)([^\s,]+)/g
      let email: string | undefined
      for (const match of tail.toString('utf8', 0, length).matchAll(pattern))
        email = match[1]
      if (email) return email
    } catch {
      // Missing or unreadable logs do not prevent quota checks.
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
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
      buckets: (Array.isArray(group.buckets) ? group.buckets : []).map((b) => {
        const bucket = b as Record<string, unknown>
        return {
          id: String(bucket.id ?? ''),
          name: String(bucket.name ?? ''),
          window: String(bucket.window ?? ''),
          remainingFraction:
            typeof bucket.remaining_fraction === 'number' &&
            Number.isFinite(bucket.remaining_fraction)
              ? bucket.remaining_fraction
              : undefined,
          resetTime: String(bucket.reset_time ?? ''),
        }
      }),
    }
  })
}

/** Cached quota reader with request coalescing. */
export class QuotaReader {
  private cached: QuotaSnapshot | undefined
  private cachedAt = 0
  private inflight: Promise<QuotaSnapshot> | undefined
  private readonly binary: () => string
  private readonly run: CommandRunner
  private readonly ttlMs: number

  /**
   * @param binary - returns the agy executable.
   * @param run - helper command runner.
   * @param ttlMs - cache lifetime.
   */
  constructor(binary: () => string, run: CommandRunner, ttlMs: number) {
    this.binary = binary
    this.run = run
    this.ttlMs = ttlMs
  }

  /** Fresh successful data only; never starts a command. */
  peek(): QuotaSnapshot | undefined {
    return this.cached?.status === 'ok' &&
      Date.now() - this.cachedAt < this.ttlMs
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
      Date.now() - this.cachedAt < this.ttlMs
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
      )
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
      this.cachedAt = Date.now()
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
      this.cachedAt = Date.now()
      return snapshot
    }
  }
}

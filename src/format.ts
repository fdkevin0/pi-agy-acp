import type { QuotaSnapshot } from './quota.ts'
import type { RuntimeStatus } from './runtime.ts'

export interface FormattedNotice {
  text: string
  level: 'info' | 'warning' | 'error'
}

function resetCountdown(resetTime: string, now: number): string {
  const reset = Date.parse(resetTime)
  if (!Number.isFinite(reset)) return 'reset time unavailable'
  if (reset <= now) return 'resetting soon'
  const minutes = Math.floor((reset - now) / 60_000)
  if (minutes === 0) return 'resets in <1m'
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `resets in ${hours}h ${minutes % 60}m`
  return `resets in ${minutes}m`
}

export function formatQuota(
  snapshot: QuotaSnapshot,
  now = Date.now(),
): FormattedNotice {
  const stale = snapshot.status === 'error' && snapshot.groups.length > 0
  const lines = [`Antigravity Quota${stale ? ' (stale)' : ''}`]
  const account = [snapshot.account?.email, snapshot.account?.plan]
    .filter(Boolean)
    .join(' · ')
  if (account) lines.push(`  Account:  ${account}`)
  let level: FormattedNotice['level'] =
    snapshot.status === 'error' ? 'error' : 'info'
  if (snapshot.status === 'error')
    lines.push(`✖ Error: ${snapshot.error || 'Quota request failed.'}`)
  if (snapshot.groups.length === 0 && snapshot.status !== 'error') {
    lines.push('No quota data available.')
  }
  for (const group of snapshot.groups) {
    lines.push('', `  ${group.name || 'Unnamed model group'}`)
    if (group.description) {
      lines.push(
        `    ${group.description.replace(/^Models within this group:\s*/i, '')}`,
      )
    }
    if (group.buckets.length === 0)
      lines.push('    No quota windows available.')
    for (const bucket of group.buckets) {
      const fraction =
        typeof bucket.remainingFraction === 'number' &&
        Number.isFinite(bucket.remainingFraction)
          ? Math.max(0, Math.min(1, bucket.remainingFraction))
          : undefined
      const filled = fraction === undefined ? 0 : Math.round(fraction * 12)
      const bar = '█'.repeat(filled) + '░'.repeat(12 - filled)
      const percent =
        fraction === undefined ? 'n/a' : `${Math.round(fraction * 100)}%`
      const label = (
        bucket.window ||
        bucket.name ||
        bucket.id ||
        'quota'
      ).padEnd(7)
      const reset = bucket.resetTime
        ? ` · ${resetCountdown(bucket.resetTime, now)}`
        : ''
      lines.push(`    ${label} [${bar}] ${percent.padStart(4)}${reset}`)
      if (fraction !== undefined) {
        if (fraction <= 0.05) level = 'error'
        else if (fraction <= 0.2 && level !== 'error') level = 'warning'
      }
    }
  }
  return { text: lines.join('\n'), level }
}

export function formatStatus(status: RuntimeStatus): FormattedNotice {
  const badges = {
    ready: '● ready',
    idle: '○ idle (lazy — starts on first turn)',
    starting: '◐ starting',
    error: '✖ error',
  }
  const binary = status.binary
    ? `${status.version || 'unknown version'} (${status.binary})`
    : 'not probed yet (lazy init on first turn)'
  const account = [status.account?.email, status.account?.plan]
    .filter(Boolean)
    .join(' · ')
  const lines = [
    `Antigravity ACP · ${badges[status.state]}`,
    `  Binary:   ${binary}`,
    `  Home:     ${status.home}`,
    ...(account ? [`  Account:  ${account}`] : []),
    `  Sessions: ${status.liveSessions} live · ${status.activeTurns} active turn(s)`,
    `  Context:  ${Math.round(status.contextWindow / 1024)}K tokens · default effort: ${status.defaultEffort} (${status.efforts.join(', ')})`,
    '  Models:',
  ]
  if (status.models.length === 0) lines.push('    No models available.')
  for (const model of status.models) {
    const efforts =
      model.efforts.length > 0
        ? `[${model.efforts.join(', ')}]`
        : model.fixedEffort
          ? `[${model.fixedEffort}] (fixed)`
          : 'no effort selector'
    lines.push(`    ${model.id} (${model.name}) — ${efforts}`)
  }
  if (status.lastTurn) {
    const turn = status.lastTurn
    const duration =
      turn.durationMs < 1000
        ? `${Math.round(turn.durationMs)}ms`
        : `${(turn.durationMs / 1000).toFixed(1)}s`
    const retries =
      turn.retryNotices > 0 ? ` · ${turn.retryNotices} retries` : ''
    lines.push(
      `  Last turn: ${turn.model} · effort: ${turn.effort} · ${turn.outcome} · ${duration}${retries}`,
    )
  }
  if (status.error) lines.push(`✖ Error: ${status.error}`)
  return {
    text: lines.join('\n'),
    level:
      status.state === 'error'
        ? 'error'
        : status.lastTurn?.outcome === 'error'
          ? 'warning'
          : 'info',
  }
}

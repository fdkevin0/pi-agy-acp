import type { QuotaDisplay } from './config.ts'
import type {
  AccountInfo,
  QuotaSnapshot,
  QuotaGroup,
  QuotaBucket,
} from './quota.ts'
import type { RuntimeStatus } from './runtime.ts'

export interface FormattedNotice {
  text: string
  level: 'info' | 'warning' | 'error'
}

function clampFraction(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined
}

function formatAccount(account?: AccountInfo): string {
  return [account?.email, account?.plan].filter(Boolean).join(' · ')
}

export type QuotaModelRef = string | { id: string; name?: string }

const GENERIC_GROUP_TOKENS = new Set([
  'gemini',
  'claude',
  'gpt',
  'and',
  'or',
  'model',
  'models',
  'group',
  'groups',
  'all',
  'other',
  'default',
  'general',
])

function normalizeTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)*/g) ?? []
}

function modelCandidates(id: string, name?: string): string[][] {
  const raw = [id, id.replace(/-(?:low|medium|high)$/i, '')]
  if (name) raw.push(name)
  const seen = new Set<string>()
  const out: string[][] = []
  for (const item of raw) {
    const tokens = normalizeTokens(item)
    const key = tokens.join(' ')
    if (tokens.length > 0 && !seen.has(key)) {
      seen.add(key)
      out.push(tokens)
    }
  }
  return out
}

function groupPhrases(group: QuotaGroup): string[][] {
  const rawDesc = group.description.replace(/^models within this group:\s*/i, '')
  const parts = [group.name, ...rawDesc.split(/[,;\n/|&]+/)]
  return parts.map(normalizeTokens).filter((tokens) => tokens.length > 0)
}

function isSubsetMatch(target: string[], candidate: string[]): boolean {
  const specific = target.filter(
    (t) => t !== 'model' && t !== 'models' && t !== 'group' && t !== 'groups',
  )
  if (specific.length < 2 || specific[0] !== candidate[0]) return false
  let pos = 1
  for (let i = 1; i < specific.length; i++) {
    const found = candidate.indexOf(specific[i]!, pos)
    if (found === -1) return false
    pos = found + 1
  }
  return true
}

function isGenericFamilyGroup(group: QuotaGroup, family: string): boolean {
  const nameTokens = normalizeTokens(group.name)
  if (
    !nameTokens.includes(family) ||
    !nameTokens.every((t) => GENERIC_GROUP_TOKENS.has(t))
  )
    return false
  return groupPhrases(group).every((tokens) =>
    tokens.every((t) => GENERIC_GROUP_TOKENS.has(t)),
  )
}

function selectQuotaGroups(
  snapshot: QuotaSnapshot,
  model?: QuotaModelRef,
): QuotaGroup[] {
  if (!model) return []
  const id = typeof model === 'string' ? model : model.id
  const name = typeof model === 'string' ? undefined : model.name
  const candidates = modelCandidates(id, name)
  if (candidates.length === 0) return []
  const candPhrases = candidates.map((c) => c.join(' '))

  const exact = snapshot.groups.filter((group) =>
    groupPhrases(group).some((p) => candPhrases.includes(p.join(' '))),
  )
  if (exact.length > 0) return exact.length === 1 ? exact : []

  const variant = snapshot.groups.filter((group) =>
    groupPhrases(group).some((p) =>
      candidates.some((c) => isSubsetMatch(p, c)),
    ),
  )
  if (variant.length > 0) return variant.length === 1 ? variant : []

  const family =
    /^(gemini|claude|gpt)(?:-|$)/i.exec(id)?.[1]?.toLowerCase() ??
    /^(gemini|claude|gpt)(?:\s|$)/i.exec(name ?? '')?.[1]?.toLowerCase()
  if (!family) return []

  const generic = snapshot.groups.filter((group) =>
    isGenericFamilyGroup(group, family),
  )
  return generic.length === 1 ? generic : []
}

/** Lowest known window for the model's matching quota group; returns undefined when unknown or ambiguous. */
export function quotaForModel(
  snapshot: QuotaSnapshot,
  model?: QuotaModelRef,
): { group: QuotaGroup; bucket: QuotaBucket; fraction: number } | undefined {
  if (snapshot.status !== 'ok') return undefined
  const groups = selectQuotaGroups(snapshot, model)
  let lowest: ReturnType<typeof quotaForModel>
  for (const group of groups) {
    for (const bucket of group.buckets) {
      const fraction = clampFraction(bucket.remainingFraction)
      if (fraction === undefined) continue
      if (!lowest || fraction < lowest.fraction)
        lowest = { group, bucket, fraction }
    }
  }
  return lowest
}

/** Convert a remaining fraction (`0..1`) into the fraction shown for `display`. */
export function displayFraction(
  remainingFraction: number,
  display: QuotaDisplay = 'used',
): number {
  return display === 'used' ? 1 - remainingFraction : remainingFraction
}

export function formatQuotaStatus(
  snapshot: QuotaSnapshot,
  model?: QuotaModelRef,
  display: QuotaDisplay = 'used',
): string | undefined {
  const quota = quotaForModel(snapshot, model)
  if (!quota) return undefined
  return `AGY ${Math.round(displayFraction(quota.fraction, display) * 100)}%`
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
  display: QuotaDisplay = 'used',
): FormattedNotice {
  const stale = snapshot.status === 'error' && snapshot.groups.length > 0
  const lines = [`Antigravity Quota${stale ? ' (stale)' : ''}`]
  const account = formatAccount(snapshot.account)
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
      const fraction = clampFraction(bucket.remainingFraction)
      const shown =
        fraction === undefined ? undefined : displayFraction(fraction, display)
      const filled = shown === undefined ? 0 : Math.round(shown * 12)
      const bar = '█'.repeat(filled) + '░'.repeat(12 - filled)
      const percent =
        shown === undefined ? 'n/a' : `${Math.round(shown * 100)}%`
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
  const account = formatAccount(status.account)
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

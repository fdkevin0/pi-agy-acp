import { asEffort, type Effort, type QuotaDisplay } from './config.ts'
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

/** Active model identity from Pi (`id` plus optional display `name` for `/usage` labels such as `Orchestrator (Carbon)`). */
export interface QuotaModelRef {
  readonly id: string
  readonly name?: string
}

// `agy` `/usage` prefixes closed, exhaustive member lists with "Models within this group:";
// unprefixed descriptions are free-form prose notes.
const EXPLICIT_MEMBERS_PREFIX = /^\s*models within this group:\s*/i
const CLAUSE_SPLIT = /[,;\n/|&+]+|\b(?:and|or)\b/i
const ID_DATE_SUFFIX = /[-_](?:20\d{2}[-_]\d{2}[-_]\d{2}|20\d{6})$/i
// Effort or thinking-mode suffixes in model IDs (`-thinking`) and `/usage` labels (`(Thinking)`).
const ID_QUALIFIER_SUFFIX = /[-_](low|medium|high|thinking)$/i
const GROUP_QUALIFIER_SUFFIX =
  /\s*\((low|medium|high|thinking)\)(?=\s*(?:models?|groups?)?[\s.!?)]*$)/i
const SPECIFIER = /^\d+(?:\.\d+)*b?$/
const VENDOR_TOKENS = new Set(['google', 'anthropic', 'openai'])
const FAMILY_TOKENS = new Set(['gemini', 'claude', 'gpt'])
const GROUP_NOISE_TOKENS = new Set(['model', 'models', 'group', 'groups'])
const GENERIC_GROUP_TOKENS = new Set([
  ...VENDOR_TOKENS,
  ...FAMILY_TOKENS,
  ...GROUP_NOISE_TOKENS,
  'all',
  'other',
  'default',
  'general',
])

/**
 * Tokenize into lowercase words, dotted versions, and `<n>b` parameter sizes.
 * Hyphens between digits become dots only for 1-2 digit version segments (`5-5` -> `5.5`),
 * preserving parameter sizes (`3-8b`, `120b`) and dates stripped beforehand.
 */
function normalizeTokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/(?<=\d)-(?=\d{1,2}(?![a-z0-9.]))/g, '.')
      .match(/[a-z0-9]+(?:\.[0-9]+)*(?:b(?![a-z0-9]))?/g) ?? []
  )
}

interface ParsedPhrase {
  readonly head: string | undefined
  readonly words: readonly string[]
  readonly specs: readonly string[]
  readonly effort: Effort | undefined
  readonly thinking: boolean
  readonly effortConflict: boolean
  readonly tokenCount: number
  readonly canonical: string
}

function buildPhrase(
  tokens: readonly string[],
  effort?: Effort,
  thinking = false,
  effortConflict = false,
): ParsedPhrase {
  const words: string[] = []
  const specs: string[] = []
  for (const token of tokens) {
    if (SPECIFIER.test(token)) specs.push(token)
    else words.push(token)
  }
  return {
    head: tokens[0],
    words,
    specs,
    effort,
    thinking,
    effortConflict,
    tokenCount: tokens.length,
    canonical: `${words.join(' ')}|${specs.join(' ')}`,
  }
}

function parseClause(raw: string, stripNoise = false): ParsedPhrase {
  let text = raw.trim().replace(/[.!?]+$/, '')
  let effort: Effort | undefined
  let thinking = false
  let effortConflict = false
  while (text.length > 0) {
    const withoutDate = text.replace(ID_DATE_SUFFIX, '')
    if (withoutDate !== text) {
      text = withoutDate
      continue
    }
    const groupQual = GROUP_QUALIFIER_SUFFIX.exec(text)
    if (groupQual) {
      const nextEffort = asEffort(groupQual[1]!.toLowerCase())
      if (nextEffort) {
        if (effort && effort !== nextEffort) effortConflict = true
        effort = nextEffort
      } else {
        thinking = true
      }
      text =
        text.slice(0, groupQual.index) +
        text.slice(groupQual.index + groupQual[0].length)
      continue
    }
    const idQual = ID_QUALIFIER_SUFFIX.exec(text)
    if (idQual) {
      const nextEffort = asEffort(idQual[1]!.toLowerCase())
      if (nextEffort) {
        if (effort && effort !== nextEffort) effortConflict = true
        effort = nextEffort
      } else {
        thinking = true
      }
      text = text.slice(0, idQual.index)
      continue
    }
    break
  }
  const baseTokens = normalizeTokens(text)
  const fallback = baseTokens.length === 0
  const tokens = [...(fallback ? normalizeTokens(raw) : baseTokens)]
  while (tokens.length >= 2 && VENDOR_TOKENS.has(tokens[0]!)) tokens.shift()
  const cleaned = stripNoise
    ? (() => {
        const stripped = tokens.filter((t) => !GROUP_NOISE_TOKENS.has(t))
        return stripped.length >= 2 ? stripped : tokens
      })()
    : tokens
  return buildPhrase(
    cleaned,
    fallback ? undefined : effort,
    fallback ? false : thinking,
    !fallback && effortConflict,
  )
}

function parseGroupPhrases(
  text: string,
  excludeGeneric: boolean,
): ParsedPhrase[] {
  const phrases: ParsedPhrase[] = []
  for (const part of text.split(CLAUSE_SPLIT)) {
    if (
      excludeGeneric &&
      normalizeTokens(part).every((token) => GENERIC_GROUP_TOKENS.has(token))
    )
      continue
    const phrase = parseClause(part, true)
    if (phrase.tokenCount > 0 && !phrase.effortConflict) phrases.push(phrase)
  }
  return phrases
}

function buildModelCandidates(id: string, name?: string): ParsedPhrase[] {
  const idPhrase = parseClause(id)
  const namePhrase = name ? parseClause(name) : undefined
  if (
    idPhrase.effortConflict ||
    namePhrase?.effortConflict ||
    (idPhrase.effort &&
      namePhrase?.effort &&
      idPhrase.effort !== namePhrase.effort)
  )
    return []
  const effort = idPhrase.effort ?? namePhrase?.effort
  const thinking = idPhrase.thinking || Boolean(namePhrase?.thinking)
  const seen = new Set<string>()
  const out: ParsedPhrase[] = []
  for (const candidate of [idPhrase, namePhrase]) {
    if (!candidate || candidate.tokenCount === 0) continue
    const phrase = { ...candidate, effort, thinking }
    const key = `${phrase.canonical}#${phrase.effort ?? ''}#${phrase.thinking ? 't' : ''}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(phrase)
    }
  }
  return out
}

const isExactPhrase = (groupPhrase: ParsedPhrase, modelPhrase: ParsedPhrase) =>
  groupPhrase.canonical === modelPhrase.canonical

/**
 * True for a subfamily without version/size (`GPT-OSS`, `Gemini Flash`) or a
 * single-version generation line (`Gemini 4`, `Gemini 3.8`) matching the model.
 */
function isBroaderVariant(
  groupPhrase: ParsedPhrase,
  modelPhrase: ParsedPhrase,
): boolean {
  if (
    groupPhrase.tokenCount < 2 ||
    !groupPhrase.head ||
    groupPhrase.head !== modelPhrase.head
  )
    return false
  if (groupPhrase.words.length >= 2 && groupPhrase.specs.length === 0)
    return groupPhrase.words.join(' ') === modelPhrase.words.join(' ')
  const modelVersions = modelPhrase.specs.filter((s) => !s.endsWith('b'))
  return (
    groupPhrase.words.length === 1 &&
    groupPhrase.specs.length === 1 &&
    !groupPhrase.specs[0]!.endsWith('b') &&
    modelVersions.length === 1 &&
    modelVersions[0] === groupPhrase.specs[0]
  )
}

function extractFamily(text?: string): string | undefined {
  const head = text
    ? normalizeTokens(text).find((token) => !VENDOR_TOKENS.has(token))
    : undefined
  return head && FAMILY_TOKENS.has(head) ? head : undefined
}

function isGenericFamilyGroup(group: QuotaGroup, family: string): boolean {
  if (EXPLICIT_MEMBERS_PREFIX.test(group.description)) return false
  return group.name.split(CLAUSE_SPLIT).some((clause) => {
    const tokens = normalizeTokens(clause)
    return (
      tokens.includes(family) &&
      tokens.every((token) => GENERIC_GROUP_TOKENS.has(token))
    )
  })
}

const matchGroup = (
  phrases: readonly ParsedPhrase[],
  candidates: readonly ParsedPhrase[],
  relation: (g: ParsedPhrase, m: ParsedPhrase) => boolean,
  qualOk: (g: ParsedPhrase, m: ParsedPhrase) => boolean,
) => phrases.some((p) => candidates.some((c) => qualOk(p, c) && relation(p, c)))

function selectQuotaGroups(
  snapshot: QuotaSnapshot,
  model?: QuotaModelRef,
): QuotaGroup[] {
  if (!model) return []
  const candidates = buildModelCandidates(model.id, model.name)
  if (candidates.length === 0) return []

  const indexed = snapshot.groups.map((group) => {
    const explicit = EXPLICIT_MEMBERS_PREFIX.test(group.description)
    const raw = explicit
      ? group.description.replace(EXPLICIT_MEMBERS_PREFIX, '')
      : group.name
    return { group, explicit, phrases: parseGroupPhrases(raw, !explicit) }
  })

  // Without an effort qualifier (`low`/`medium`/`high`) on the model reference, any matching
  // effort-capped pool makes group ownership depend on unknown active effort; return unknown.
  const omittedEffort = (g: ParsedPhrase, m: ParsedPhrase) =>
    g.effort !== undefined && m.effort === undefined
  if (
    indexed.some(
      (entry) =>
        matchGroup(entry.phrases, candidates, isExactPhrase, omittedEffort) ||
        matchGroup(entry.phrases, candidates, isBroaderVariant, omittedEffort),
    )
  )
    return []

  const compatQual = (g: ParsedPhrase, m: ParsedPhrase) =>
    (g.effort === undefined || g.effort === m.effort) &&
    (!g.thinking || m.thinking || m.effort !== undefined)

  const authoritative: (typeof indexed)[number][] = []
  const variantOnly: (typeof indexed)[number][] = []
  for (const entry of indexed) {
    const exact = matchGroup(entry.phrases, candidates, isExactPhrase, compatQual)
    const variant = matchGroup(
      entry.phrases,
      candidates,
      isBroaderVariant,
      compatQual,
    )
    if (exact || (entry.explicit && variant)) authoritative.push(entry)
    else if (variant) variantOnly.push(entry)
  }
  if (authoritative.length > 0) {
    return [
      ...authoritative,
      ...(variantOnly.length === 1 ? variantOnly : []),
    ].map((e) => e.group)
  }
  if (variantOnly.length === 1) return [variantOnly[0]!.group]
  if (variantOnly.length > 1) return []

  const thinkingQual = (g: ParsedPhrase, m: ParsedPhrase) =>
    g.thinking && !m.thinking && g.effort === undefined && m.effort === undefined
  const thinkingMatches = indexed.filter(
    (entry) =>
      matchGroup(entry.phrases, candidates, isExactPhrase, thinkingQual) ||
      matchGroup(entry.phrases, candidates, isBroaderVariant, thinkingQual),
  )
  if (thinkingMatches.length === 1) return [thinkingMatches[0]!.group]
  if (thinkingMatches.length > 1) return []

  const family = extractFamily(model.id) ?? extractFamily(model.name)
  if (!family) return []
  const generic = indexed.filter(
    (entry) => !entry.explicit && isGenericFamilyGroup(entry.group, family),
  )
  return generic.length === 1 ? [generic[0]!.group] : []
}

/** Lowest known window across the model's governing quota group(s); returns undefined when unknown or ambiguous. */
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
    const description = group.description
      .replace(EXPLICIT_MEMBERS_PREFIX, '')
      .trim()
    if (description) {
      lines.push(`    ${description}`)
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

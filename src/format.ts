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

/** Model identifier or `{ id, name }` metadata from Pi's active model context. */
export type QuotaModelRef = string | { id: string; name?: string }

// `agy` `/usage` prefixes closed, exhaustive member lists with "Models within this group:";
// unprefixed descriptions are free-form prose notes.
const EXPLICIT_MEMBERS_PREFIX = /^\s*models within this group:\s*/i
const CLAUSE_SPLIT = /[,;\n/|&+]+|\b(?:and|or)\b/i
const ID_DATE_SUFFIX = /[-_](?:20\d{2}[-_]\d{2}[-_]\d{2}|20\d{6})$/i
// Effort or thinking-mode suffixes in model IDs (`-thinking`) and `/usage` labels (`(Thinking)`).
const ID_QUALIFIER_SUFFIX = /[-_](low|medium|high|thinking)$/i
const GROUP_QUALIFIER_SUFFIX =
  /\s*\((low|medium|high|thinking)\)(?=\s*(?:models?|groups?)?[\s.!?)]*$)/i
const PURE_VERSION = /^\d+(?:\.\d+)*$/
const PARAM_SIZE = /^\d+(?:\.\d+)*b$/
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
 * Hyphens between digits become dots only for 1–2 digit version segments (`5-5` -> `5.5`),
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

/**
 * Drop group-label nouns (`model`, `models`, `group`, `groups`) only when at least two
 * identifying tokens remain, keeping generic pool names like `"Gemini Models"` intact
 * so they only match via `isGenericFamilyGroup`.
 */
function stripGroupNoise(tokens: string[]): string[] {
  const stripped = tokens.filter((t) => !GROUP_NOISE_TOKENS.has(t))
  return stripped.length >= 2 ? stripped : tokens
}

interface ParsedPhrase {
  readonly head: string | undefined
  readonly words: readonly string[]
  readonly versions: readonly string[]
  readonly sizes: readonly string[]
  readonly qualifier: string | undefined
  readonly tokenCount: number
  readonly canonical: string
}

/**
 * Partition tokens into words, versions, and parameter sizes so `canonical` compares
 * model names order-insensitively across categories (e.g. `Claude 5.5 Opus` vs `claude-opus-5-5`).
 */
function buildPhrase(
  tokens: readonly string[],
  qualifier?: string,
): ParsedPhrase {
  const words: string[] = []
  const versions: string[] = []
  const sizes: string[] = []
  for (const token of tokens) {
    if (PURE_VERSION.test(token)) versions.push(token)
    else if (PARAM_SIZE.test(token)) sizes.push(token)
    else words.push(token)
  }
  return {
    head: tokens[0],
    words,
    versions,
    sizes,
    qualifier,
    tokenCount: tokens.length,
    canonical: `${words.join(' ')}|${versions.join(' ')}|${sizes.join(' ')}`,
  }
}

function parseClause(raw: string, stripNoise = false): ParsedPhrase {
  let text = raw.trim().replace(/[.!?]+$/, '')
  let qualifier: string | undefined
  const groupQual = text.match(GROUP_QUALIFIER_SUFFIX)
  if (groupQual) {
    qualifier = groupQual[1]!.toLowerCase()
    text = text.replace(GROUP_QUALIFIER_SUFFIX, '').replace(ID_DATE_SUFFIX, '')
  } else {
    text = text.replace(ID_DATE_SUFFIX, '')
    const idQual = text.match(ID_QUALIFIER_SUFFIX)
    if (idQual) {
      qualifier = idQual[1]!.toLowerCase()
      text = text.slice(0, idQual.index).replace(ID_DATE_SUFFIX, '')
    }
  }
  const rawTokens = normalizeTokens(text)
  const tokens = stripNoise ? stripGroupNoise(rawTokens) : rawTokens
  if (tokens.length === 0) {
    const fallback = normalizeTokens(raw)
    return buildPhrase(
      stripNoise ? stripGroupNoise(fallback) : fallback,
      undefined,
    )
  }
  return buildPhrase(tokens, qualifier)
}

function dedupePhrases(
  phrases: readonly (ParsedPhrase | undefined)[],
): ParsedPhrase[] {
  const seen = new Set<string>()
  const out: ParsedPhrase[] = []
  for (const phrase of phrases) {
    const key = phrase ? `${phrase.canonical}#${phrase.qualifier ?? ''}` : ''
    if (phrase && phrase.tokenCount > 0 && !seen.has(key)) {
      seen.add(key)
      out.push(phrase)
    }
  }
  return out
}

function buildModelCandidates(id: string, name?: string): ParsedPhrase[] {
  const idPhrase = parseClause(id)
  const namePhrase = name ? parseClause(name) : undefined
  const sharedQualifier = idPhrase.qualifier ?? namePhrase?.qualifier
  const withQualifier = (
    phrase: ParsedPhrase | undefined,
  ): ParsedPhrase | undefined =>
    phrase && phrase.qualifier === undefined && sharedQualifier !== undefined
      ? { ...phrase, qualifier: sharedQualifier }
      : phrase
  return dedupePhrases([withQualifier(idPhrase), withQualifier(namePhrase)])
}

function parseGroupPhrases(text: string): ParsedPhrase[] {
  return text
    .split(CLAUSE_SPLIT)
    .map((part) => parseClause(part, true))
    .filter((phrase) => phrase.tokenCount > 0)
}

/**
 * True when `groupPhrase` names a broader release line that still identifies `modelPhrase`:
 * either an unversioned sub-family with matching words (`Gemini Flash` -> `gemini-3.8-flash`)
 * or a single-version family line (`Gemini 3.8` -> `gemini-3.8-flash`), never crossing sizes.
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
  if (
    groupPhrase.words.length >= 2 &&
    groupPhrase.versions.length === 0 &&
    groupPhrase.sizes.length === 0
  ) {
    return groupPhrase.words.join(' ') === modelPhrase.words.join(' ')
  }
  if (
    groupPhrase.words.length === 1 &&
    groupPhrase.versions.length === 1 &&
    groupPhrase.sizes.length === 0
  ) {
    return (
      modelPhrase.versions.length === 1 &&
      modelPhrase.versions[0] === groupPhrase.versions[0]
    )
  }
  return false
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

interface IndexedGroup {
  readonly group: QuotaGroup
  readonly explicit: boolean
  readonly name: readonly ParsedPhrase[]
  readonly desc: readonly ParsedPhrase[]
}

function firstUniqueGroup(
  groups: readonly IndexedGroup[],
  tiers: readonly ((group: IndexedGroup) => boolean)[],
): QuotaGroup | undefined {
  for (const match of tiers) {
    const matched = groups.filter(match)
    if (matched.length === 1) return matched[0]!.group
    if (matched.length > 1) return undefined
  }
  return undefined
}

const hasSameQualifier = (a: ParsedPhrase, b: ParsedPhrase) =>
  a.qualifier === b.qualifier

const isUnqualifiedGroup = (
  groupPhrase: ParsedPhrase,
  modelPhrase: ParsedPhrase,
) => groupPhrase.qualifier === undefined && modelPhrase.qualifier !== undefined

const isUnqualifiedModel = (
  groupPhrase: ParsedPhrase,
  modelPhrase: ParsedPhrase,
) => groupPhrase.qualifier !== undefined && modelPhrase.qualifier === undefined

const isExactPhrase = (groupPhrase: ParsedPhrase, modelPhrase: ParsedPhrase) =>
  groupPhrase.canonical === modelPhrase.canonical

function selectQuotaGroup(
  snapshot: QuotaSnapshot,
  model?: QuotaModelRef,
): QuotaGroup | undefined {
  if (!model) return undefined
  const id = typeof model === 'string' ? model : model.id
  const name = typeof model === 'string' ? undefined : model.name
  const models = buildModelCandidates(id, name)
  if (models.length === 0) return undefined

  const groups: IndexedGroup[] = snapshot.groups.map((group) => ({
    group,
    explicit: EXPLICIT_MEMBERS_PREFIX.test(group.description),
    name: parseGroupPhrases(group.name),
    desc: parseGroupPhrases(
      group.description.replace(EXPLICIT_MEMBERS_PREFIX, ''),
    ),
  }))

  const matchPhrases = (
    phrases: readonly ParsedPhrase[],
    candidates: readonly ParsedPhrase[],
    relation: (groupPhrase: ParsedPhrase, modelPhrase: ParsedPhrase) => boolean,
    qualOk: (a: ParsedPhrase, b: ParsedPhrase) => boolean,
  ) =>
    phrases.some((p) => candidates.some((c) => qualOk(p, c) && relation(p, c)))

  const allowsExplicit = (
    g: IndexedGroup,
    qualOk: (a: ParsedPhrase, b: ParsedPhrase) => boolean,
  ) =>
    matchPhrases(g.desc, models, isExactPhrase, qualOk) ||
    matchPhrases(g.desc, models, isBroaderVariant, qualOk)

  const tiersFor = (
    relation: (groupPhrase: ParsedPhrase, modelPhrase: ParsedPhrase) => boolean,
    qualOk: (a: ParsedPhrase, b: ParsedPhrase) => boolean,
    mergeAuthoritative = false,
  ): ((group: IndexedGroup) => boolean)[] => {
    const byName = (g: IndexedGroup) =>
      (!g.explicit || allowsExplicit(g, qualOk)) &&
      matchPhrases(g.name, models, relation, qualOk)
    const byExplicitDesc = (g: IndexedGroup) =>
      g.explicit && matchPhrases(g.desc, models, relation, qualOk)
    const byProseDesc = (g: IndexedGroup) =>
      !g.explicit && matchPhrases(g.desc, models, relation, qualOk)
    return mergeAuthoritative
      ? [(g) => byName(g) || byExplicitDesc(g), byProseDesc]
      : [byName, byExplicitDesc, byProseDesc]
  }

  const family = extractFamily(id) ?? extractFamily(name)
  // Priority order (closed "Models within this group:" lists must authorize any name match):
  // 1. Exact phrase + identical qualifier (`name -> explicit list -> prose description`)
  // 2. Exact phrase + unqualified group for a qualified model (`name -> explicit list -> prose`)
  // 3. Exact phrase + qualified group for an unqualified model (`name | explicit list -> prose`)
  // 4. Broader release-line variant with the same three qualifier tiers
  // 5. Unambiguous generic family pool (`Gemini Models`, `Claude and GPT models`)
  return firstUniqueGroup(groups, [
    ...tiersFor(isExactPhrase, hasSameQualifier),
    ...tiersFor(isExactPhrase, isUnqualifiedGroup),
    ...tiersFor(isExactPhrase, isUnqualifiedModel, true),
    ...tiersFor(isBroaderVariant, hasSameQualifier),
    ...tiersFor(isBroaderVariant, isUnqualifiedGroup),
    ...tiersFor(isBroaderVariant, isUnqualifiedModel, true),
    ...(family
      ? [
          (g: IndexedGroup) =>
            !g.explicit && isGenericFamilyGroup(g.group, family),
        ]
      : []),
  ])
}

/** Lowest known window for the model's matching quota group; returns undefined when unknown or ambiguous. */
export function quotaForModel(
  snapshot: QuotaSnapshot,
  model?: QuotaModelRef,
): { group: QuotaGroup; bucket: QuotaBucket; fraction: number } | undefined {
  if (snapshot.status !== 'ok') return undefined
  const group = selectQuotaGroup(snapshot, model)
  if (!group) return undefined
  let lowest: ReturnType<typeof quotaForModel>
  for (const bucket of group.buckets) {
    const fraction = clampFraction(bucket.remainingFraction)
    if (fraction === undefined) continue
    if (!lowest || fraction < lowest.fraction)
      lowest = { group, bucket, fraction }
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

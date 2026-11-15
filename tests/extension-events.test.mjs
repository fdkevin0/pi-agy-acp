import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initTheme } from '@earendil-works/pi-coding-agent'
import extension from '../index.ts'
import { AntigravityRuntime } from '../src/runtime.ts'
import { QuotaReader } from '../src/quota.ts'
import { formatQuotaStatus, quotaForModel } from '../src/format.ts'

const provider = 'antigravity-acp'
const tick = () => new Promise((resolve) => setImmediate(resolve))
const snapshot = (remaining = 0.1, resetTime = '2030-01-01T00:00:00Z') => ({
  status: 'ok',
  updatedAt: new Date().toISOString(),
  groups: [
    {
      name: 'Gemini Models',
      description: 'Gemini',
      buckets: [
        { id: 'gemini', window: '5h', remainingFraction: 0.8, resetTime },
      ],
    },
    {
      name: 'Claude/GPT Models',
      description: 'Claude and GPT',
      buckets: [
        {
          id: 'claude',
          window: 'weekly',
          remainingFraction: remaining,
          resetTime,
        },
      ],
    },
  ],
})

function restoreEnv(key, value) {
  delete process.env[key]
  Object.assign(
    process.env,
    ...[value].filter((v) => v !== undefined).map((v) => ({ [key]: v })),
  )
}

function isolateHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'pi-events-'))
  const prevHome = process.env.PI_AGY_HOME
  const prevDisplay = process.env.PI_AGY_QUOTA_DISPLAY
  process.env.PI_AGY_HOME = home
  delete process.env.PI_AGY_QUOTA_DISPLAY
  t.after(() => {
    restoreEnv('PI_AGY_HOME', prevHome)
    restoreEnv('PI_AGY_QUOTA_DISPLAY', prevDisplay)
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

function mountExtension(
  t,
  modelId = 'claude-opus-5-5',
  onRegister = () => {},
) {
  const handlers = new Map()
  const registrations = []
  const notices = []
  const statuses = []
  let command
  extension({
    registerProvider(_name, definition) {
      registrations.push(definition)
      onRegister()
    },
    registerCommand(_name, definition) {
      command = definition
    },
    on(event, handler) {
      handlers.set(event, handler)
    },
  })
  const ctx = {
    sessionManager: { getSessionId: () => 'events-session' },
    hasUI: true,
    model: { provider, id: modelId },
    ui: {
      setStatus(key, text) {
        assert.equal(key, provider)
        statuses.push(text)
      },
      notify(text, level) {
        notices.push({ text, level })
      },
    },
  }
  t.after(async () => {
    await handlers.get('session_shutdown')({}, ctx)
  })
  return { handlers, registrations, command, ctx, statuses, notices }
}

function harness(t, onRegister = () => {}) {
  isolateHome(t)
  return mountExtension(t, 'claude-opus-5-5', onRegister)
}

test('refresh does not re-register and abort itself, forwards force/signal, and releases its guard after failure', async (t) => {
  let runtime
  let onRegister = () => {}
  const warn = t.mock.method(console, 'error', () => {})
  const warmup = t.mock.method(
    AntigravityRuntime.prototype,
    'warmup',
    async function () {
      runtime = this
      this.catalog.observe([
        { id: 'model', options: [{ value: 'live', name: 'Live' }] },
      ])
      this.host.log.warn('should not corrupt the TUI')
      this.host.onModelsChanged()
    },
  )
  const h = harness(t, () => onRegister())
  const controller = new AbortController()
  onRegister = () => controller.abort()
  const refreshed = await h.registrations[0].refreshModels({
    allowNetwork: true,
    force: true,
    signal: controller.signal,
  })
  assert.equal(controller.signal.aborted, false)
  assert.equal(h.registrations.length, 1)
  assert.equal(refreshed[0].id, 'live')
  assert.deepEqual(warmup.mock.calls[0].arguments, [
    { force: true, signal: controller.signal },
  ])
  assert.equal(warn.mock.callCount(), 0)
  await h.registrations[0].refreshModels({
    signal: AbortSignal.abort(),
    force: true,
  })
  assert.equal(warmup.mock.callCount(), 1)
  t.mock.method(runtime, 'warmup', async () => {
    throw new Error('failed refresh')
  })
  await assert.rejects(
    h.registrations[0].refreshModels({ force: true }),
    /failed refresh/,
  )
  onRegister = () => {}
  runtime.host.onModelsChanged()
  assert.equal(h.registrations.length, 2)
})

test('lifecycle uses light resets, cache warming stops only for this provider, and selecting models only reads fresh memory', async (t) => {
  const light = t.mock.method(
    AntigravityRuntime.prototype,
    'resetConversations',
    async () => {},
  )
  const dispose = t.mock.method(
    AntigravityRuntime.prototype,
    'dispose',
    async () => {},
  )
  const read = t.mock.method(QuotaReader.prototype, 'read', () => {
    throw new Error('Must not query quota')
  })
  let cached = snapshot()
  t.mock.method(QuotaReader.prototype, 'peek', () => cached)
  const h = harness(t)
  assert.deepEqual(h.handlers.get('cache_warming_decision')({}, h.ctx), {
    action: 'stop',
  })
  assert.equal(
    h.handlers.get('cache_warming_decision')(
      {},
      { ...h.ctx, model: { provider: 'anthropic', id: 'claude-sonnet-4' } },
    ),
    undefined,
  )
  assert.equal(
    h.handlers.get('cache_warming_decision')(
      {},
      { ...h.ctx, model: undefined },
    ),
    undefined,
  )
  await h.handlers.get('session_start')({ reason: 'startup' }, h.ctx)
  assert.equal(light.mock.callCount(), 0)
  await h.handlers.get('session_start')({ reason: 'resume' }, h.ctx)
  await h.handlers.get('session_tree')({}, h.ctx)
  await h.handlers.get('session_compact')({ willRetry: true }, h.ctx)
  assert.equal(light.mock.callCount(), 3)
  assert.equal(dispose.mock.callCount(), 0)
  h.handlers.get('model_select')(
    { model: { provider: 'other', id: 'other' } },
    h.ctx,
  )
  assert.equal(h.statuses.at(-1), undefined)
  h.handlers.get('model_select')(
    { model: { provider, id: 'gemini-4-argon' } },
    h.ctx,
  )
  assert.equal(h.statuses.at(-1), 'AGY 20%')
  const foreign = {
    ...h.ctx,
    model: {
      provider: 'anthropic',
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
    },
  }
  h.handlers.get('model_select')({ model: foreign.model }, foreign)
  assert.equal(h.statuses.at(-1), undefined)
  const foreignStatusCount = h.statuses.length
  await h.command.handler('status', foreign)
  assert.equal(h.statuses.length, foreignStatusCount)
  assert.equal(h.statuses.at(-1), undefined)
  cached = undefined
  h.handlers.get('model_select')({ model: h.ctx.model }, h.ctx)
  assert.equal(h.statuses.at(-1), undefined)
  await h.command.handler('status', h.ctx)
  assert.equal(read.mock.callCount(), 0)
  await h.command.handler('reset', h.ctx)
  assert.equal(h.statuses.at(-1), undefined)
  assert.equal(dispose.mock.callCount(), 1)
})

test('settled checks are nonblocking, coalesced, and warn once per bucket reset and waterline', async (t) => {
  const pending = Promise.withResolvers()
  let value = pending.promise
  const read = t.mock.method(QuotaReader.prototype, 'read', () => value)
  const h = harness(t)
  const settled = h.handlers.get('agent_settled')
  settled({}, { ...h.ctx, hasUI: false })
  assert.equal(read.mock.callCount(), 0)
  assert.equal(settled({}, h.ctx), undefined)
  settled({}, h.ctx)
  assert.equal(read.mock.callCount(), 1)
  assert.deepEqual(read.mock.calls[0].arguments, [false])
  assert.equal(h.statuses.length, 0)
  pending.resolve(snapshot())
  await tick()
  assert.equal(h.statuses.at(-1), 'AGY 90%')
  assert.equal(h.notices.length, 1)
  assert.equal(h.notices[0].level, 'warning')
  assert.match(h.notices[0].text, /Claude\/GPT/)
  assert.match(h.notices[0].text, /90% used/)
  const checkNotice = async (fraction, cycle, warnings) => {
    value = Promise.resolve(snapshot(fraction, cycle))
    settled({}, h.ctx)
    await tick()
    assert.equal(h.notices.length, warnings)
  }
  await checkNotice(0.1, 'cycle-1', 2)
  await checkNotice(0.1, 'cycle-1', 2)
  await checkNotice(0.05, 'cycle-1', 3)
  await checkNotice(0.04, 'cycle-1', 3)
  await checkNotice(0.05, 'cycle-2', 4)
  const switched = Promise.withResolvers()
  value = switched.promise
  const callsBeforeSwitch = read.mock.callCount()
  settled({}, h.ctx)
  h.handlers.get('model_select')(
    { model: { provider, id: 'gemini-4-argon' } },
    h.ctx,
  )
  settled({}, { ...h.ctx, model: { provider, id: 'gemini-4-argon' } })
  assert.equal(read.mock.callCount(), callsBeforeSwitch + 1)
  switched.resolve(snapshot(0.1, 'cycle-3'))
  await tick()
  assert.equal(h.statuses.at(-1), 'AGY 20%')
  h.ctx.model = { provider: 'other', id: 'other' }
  const calls = read.mock.callCount()
  settled({}, h.ctx)
  assert.equal(read.mock.callCount(), calls)
})

test('late background results after model switches, reset, or shutdown cannot restore status or warn', async (t) => {
  let pending
  const read = t.mock.method(QuotaReader.prototype, 'read', () => pending.promise)
  const h = harness(t)
  const expectNoUpdate = async (settle) => {
    const before = [h.statuses.length, h.notices.length]
    settle()
    await tick()
    assert.deepEqual([h.statuses.length, h.notices.length], before)
  }

  pending = Promise.withResolvers()
  h.handlers.get('agent_settled')({}, h.ctx)
  h.handlers.get('model_select')({ model: { provider: 'other' } }, h.ctx)
  await expectNoUpdate(() => pending.resolve(snapshot()))

  pending = Promise.withResolvers()
  h.handlers.get('agent_settled')({}, h.ctx)
  await h.command.handler('reset', h.ctx)
  await expectNoUpdate(() => pending.resolve(snapshot()))

  pending = Promise.withResolvers()
  h.handlers.get('agent_settled')({}, h.ctx)
  await expectNoUpdate(() => pending.resolve({ ...snapshot(), status: 'error' }))

  pending = Promise.withResolvers()
  h.handlers.get('agent_settled')({}, h.ctx)
  await expectNoUpdate(() => pending.reject(new Error('offline')))

  pending = Promise.withResolvers()
  h.handlers.get('agent_settled')({}, h.ctx)
  await h.handlers.get('session_shutdown')({}, h.ctx)
  await expectNoUpdate(() => pending.resolve(snapshot()))

  const callsAfterShutdown = read.mock.callCount()
  h.handlers.get('agent_settled')({}, h.ctx)
  assert.equal(read.mock.callCount(), callsAfterShutdown)
})

const group = (name, remainingFraction, description = '', extraBuckets = []) => ({
  name,
  description,
  buckets: [{ id: name, window: '5h', remainingFraction }, ...extraBuckets],
})
const groups = (...items) => ({
  status: 'ok',
  updatedAt: '2030-01-01T00:00:00Z',
  groups: items,
})

test('quota selection matches specific groups, explicit members, and display names without misleading fallbacks', () => {
  assert.equal(formatQuotaStatus(snapshot(), 'gemini-4-argon'), 'AGY 20%')
  assert.equal(formatQuotaStatus(snapshot(), 'gpt-oss-120b-medium'), 'AGY 90%')
  assert.equal(formatQuotaStatus(snapshot(), 'unknown'), undefined)
  assert.equal(formatQuotaStatus(snapshot(), 'gemini-4-argon', 'remaining'), 'AGY 80%')
  assert.equal(formatQuotaStatus(snapshot(), 'gpt-oss-120b-medium', 'remaining'), 'AGY 10%')
  assert.equal(quotaForModel(snapshot(0), 'claude-opus-5-5').fraction, 0)
  assert.equal(formatQuotaStatus(snapshot(NaN), 'claude-opus-5-5'), undefined)
  assert.equal(formatQuotaStatus({ ...snapshot(), status: 'error' }), undefined)

  // Picks lowest remaining window within the matched group.
  const multiWindow = groups(
    group('Gemini Models', 0.8, '', [
      { id: 'w', window: 'weekly', remainingFraction: 0.25 },
    ]),
  )
  assert.equal(formatQuotaStatus(multiWindow, 'gemini-4-argon', 'remaining'), 'AGY 25%')

  // Realistic /usage fixture: dedicated group beats shared explicit list, closed lists isolate unlisted models, (Thinking) and Oxford conjunctions match.
  const realistic = groups(
    group('Gemini Models', 0.7, 'Models within this group: Gemini 4 Argon, Gemini 3.8 Flash'),
    group(
      'Claude and GPT models',
      0.9,
      'Models within this group: Claude Opus 5.5 (Thinking), Claude Sonnet 5.5, and GPT-OSS 120B',
    ),
    group('Gemini 4 Argon Models', 0),
  )
  assert.equal(formatQuotaStatus(realistic, 'gemini-4-argon', 'remaining'), 'AGY 0%')
  assert.equal(
    formatQuotaStatus(realistic, { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, 'remaining'),
    'AGY 70%',
  )
  assert.equal(quotaForModel(realistic, 'gemini-2.5-pro'), undefined)
  assert.equal(
    formatQuotaStatus(realistic, { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, 'remaining'),
    'AGY 90%',
  )
  assert.equal(formatQuotaStatus(realistic, 'gpt-oss-120b-medium', 'remaining'), 'AGY 90%')
  assert.equal(
    formatQuotaStatus(realistic, { id: 'opaque-id', name: 'GPT-OSS 120B (Medium)' }, 'remaining'),
    'AGY 90%',
  )

  // Specificity and qualifier compatibility: matching effort beats missing/conflicting qualifiers, conflicting effort groups never cross-match, and ISO dates / punctuation parse cleanly.
  const effortGroups = groups(group('GPT-OSS 120B (Medium)', 0.1), group('GPT-OSS 120B', 0.8))
  assert.equal(
    formatQuotaStatus(effortGroups, { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B' }, 'remaining'),
    'AGY 10%',
  )
  const incompatibleQualifier = groups(
    group('GPT-OSS 120B (High)', 0.1),
    group('Claude and GPT models', 0.9, 'Models within this group: Claude Opus 5.5 (Thinking), GPT-OSS 120B.'),
  )
  assert.equal(
    formatQuotaStatus(incompatibleQualifier, { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B' }, 'remaining'),
    'AGY 90%',
  )
  assert.equal(formatQuotaStatus(incompatibleQualifier, 'claude-opus-5-5', 'remaining'), 'AGY 90%')
  const explicitQualifierPriority = groups(
    group('Claude Opus 5.5 (Low)', 0.9),
    group('Claude Opus 5.5', 0.8),
    group('Claude Models', 0.1, 'Models within this group: Claude Opus 5.5 (High)'),
  )
  assert.equal(formatQuotaStatus(explicitQualifierPriority, 'claude-opus-5-5-high', 'remaining'), 'AGY 10%')
  const variantQualifiers = groups(
    group('Gemini Flash (High)', 0.1),
    group('Gemini Flash (Low)', 0.8),
  )
  assert.equal(formatQuotaStatus(variantQualifiers, 'gemini-3.8-flash-high', 'remaining'), 'AGY 10%')
  assert.equal(quotaForModel(variantQualifiers, 'gemini-3.8-flash'), undefined)
  const collidingQualifiers = groups(
    group('Claude Opus 5.5 (High)', 0.1),
    group('Claude Opus 5.5 (Low)', 0.8),
  )
  assert.equal(
    quotaForModel(collidingQualifiers, { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }),
    undefined,
  )
  const splitAcrossNameAndExplicit = groups(
    group('Claude Opus 5.5 (Low)', 0.1),
    group('Claude and GPT models', 0.9, 'Models within this group: Claude Opus 5.5 (Thinking)'),
  )
  assert.equal(
    quotaForModel(splitAcrossNameAndExplicit, { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }),
    undefined,
  )
  assert.equal(
    formatQuotaStatus(splitAcrossNameAndExplicit, 'claude-opus-5-5-low', 'remaining'),
    'AGY 10%',
  )
  assert.equal(
    formatQuotaStatus(splitAcrossNameAndExplicit, 'claude-opus-5-5-thinking', 'remaining'),
    'AGY 90%',
  )
  assert.equal(
    formatQuotaStatus(splitAcrossNameAndExplicit, 'claude-opus-5-5-20260301 (Thinking)', 'remaining'),
    'AGY 90%',
  )
  const reorderedDated = groups(group('Claude Models', 0.9), group('Claude 5.5 Opus', 0))
  assert.equal(
    formatQuotaStatus(reorderedDated, 'claude-opus-5-5-20260301', 'remaining'),
    'AGY 0%',
  )
  assert.equal(
    formatQuotaStatus(reorderedDated, 'claude-opus-5-5-2026-03-01', 'remaining'),
    'AGY 0%',
  )
  assert.equal(
    formatQuotaStatus(groups(group('Google Gemini Models', 0.6)), 'gemini-3.8-flash', 'remaining'),
    'AGY 60%',
  )
  assert.equal(
    formatQuotaStatus(
      groups(group('Gemini Models', 0.6)),
      { id: 'opaque-id', name: 'Google Gemini 3.8 Flash' },
      'remaining',
    ),
    'AGY 60%',
  )

  // Authoritative "Models within this group:" closed lists and slash delimiters.
  const closedExplicit = groups(group('Gemini Pro', 0, 'Models within this group: Gemini 2.5 Pro'))
  assert.equal(quotaForModel(closedExplicit, 'gemini-3.8-pro'), undefined)
  assert.equal(quotaForModel(closedExplicit, 'gemini-pro'), undefined)

  const authoritativeVsNotes = groups(
    group('Authoritative', 0.4, 'Models within this group: Gemini 3.8 Flash'),
    group('Notes', 0.9, 'Gemini 3.8 Flash / Gemini 3.8 Pro'),
  )
  assert.equal(formatQuotaStatus(authoritativeVsNotes, 'gemini-3.8-flash', 'remaining'), 'AGY 40%')
  assert.equal(
    formatQuotaStatus(groups(group('Gemini 3.8 Flash / Gemini 3.8 Pro', 0.5)), 'gemini-3.8-flash', 'remaining'),
    'AGY 50%',
  )
  assert.equal(
    formatQuotaStatus(groups(group('Tier A', 0.5, 'Gemini 3.8 Flash / Gemini 3.8 Pro')), 'gemini-3.8-flash', 'remaining'),
    'AGY 50%',
  )

  // Broader variants and version/size sibling boundaries.
  const variantExplicit = groups(
    group('Custom Tier', 0.4, 'Models within this group: Gemini Flash, Claude Opus 5.5'),
    group('Gemini Pro', 0.1),
  )
  assert.equal(formatQuotaStatus(variantExplicit, 'gemini-3.8-flash', 'remaining'), 'AGY 40%')
  assert.equal(formatQuotaStatus(variantExplicit, 'claude-opus-5-5', 'remaining'), 'AGY 40%')
  const explicitVariantName = groups(
    group('Gemini Flash', 0.3, '  Models within this group: Gemini 3.8'),
    group('Shared Tier', 0.8, 'Models within this group: Gemini Flash'),
  )
  assert.equal(formatQuotaStatus(explicitVariantName, 'gemini-3.8-flash', 'remaining'), 'AGY 30%')

  const dedicatedFlash = groups(group('Gemini Models', 0.7), group('Gemini 3.8 Flash', 0))
  assert.equal(
    formatQuotaStatus(dedicatedFlash, { id: 'gemini-3.8-flash-lite', name: 'Gemini 3.8 Flash Lite' }, 'remaining'),
    'AGY 70%',
  )
  assert.equal(formatQuotaStatus(dedicatedFlash, 'gemini-3.8-flash-8b', 'remaining'), 'AGY 70%')
  assert.equal(quotaForModel(groups(group('Gemini 3.8', 0.1)), 'gemini-3-8b'), undefined)

  const versionBounded = groups(group('Gemini 3', 0.1), group('Claude 5', 0))
  assert.equal(quotaForModel(versionBounded, 'gemini-2.3-pro'), undefined)
  assert.equal(quotaForModel(versionBounded, 'gemini-2-3-pro'), undefined)
  assert.equal(quotaForModel(versionBounded, 'gemini-1.5-pro-3'), undefined)
  assert.equal(quotaForModel(versionBounded, 'claude-sonnet-4-5'), undefined)

  // Generic family fallback and GPT-OSS clause isolation.
  assert.equal(
    formatQuotaStatus(
      groups(group('Gemini Models', 0.7, 'Shared limit across Gemini models')),
      'gemini-3.8-flash',
      'remaining',
    ),
    'AGY 70%',
  )
  const ossOnly = groups(group('GPT-OSS Models', 0))
  assert.equal(formatQuotaStatus(ossOnly, 'gpt-oss-120b-medium', 'remaining'), 'AGY 0%')
  assert.equal(quotaForModel(ossOnly, 'gpt-5'), undefined)

  const gptSharedAndOss = groups(group('Claude and GPT models', 0.9), group('GPT-OSS Models', 0))
  assert.equal(formatQuotaStatus(gptSharedAndOss, 'gpt-5', 'remaining'), 'AGY 90%')
  assert.equal(formatQuotaStatus(gptSharedAndOss, 'gpt-oss-120b-medium', 'remaining'), 'AGY 0%')

  const mixedClause = groups(group('Claude and GPT-OSS 120B', 0.6))
  assert.equal(formatQuotaStatus(mixedClause, 'claude-opus-5-5', 'remaining'), 'AGY 60%')
  assert.equal(formatQuotaStatus(mixedClause, 'gpt-oss-120b-medium', 'remaining'), 'AGY 60%')
  assert.equal(quotaForModel(mixedClause, 'gpt-5'), undefined)

  // Unmatched and ambiguous group rejection.
  assert.equal(
    quotaForModel(groups(group('Gemini 4 Argon', 0), group('Gemini Pro', 0.8)), 'gemini-3.8-flash'),
    undefined,
  )
  assert.equal(
    quotaForModel(groups(group('Gemini Models', 0.2), group('Gemini Models', 0.8)), 'gemini-3.8-flash'),
    undefined,
  )
  assert.equal(
    quotaForModel(groups(group('Gemini 3.8', 0.2), group('Gemini Flash', 0.8)), 'gemini-3.8-flash'),
    undefined,
  )
})

test('agent_settled during reset or shutdown disposal skips quota reads and does not block replacement runtime', async (t) => {
  const resetDisposing = Promise.withResolvers()
  const shutdownDisposing = Promise.withResolvers()
  const dispose = t.mock.method(AntigravityRuntime.prototype, 'dispose', async () => {})
  dispose.mock.mockImplementationOnce(() => resetDisposing.promise)
  const read = t.mock.method(QuotaReader.prototype, 'read', async () => snapshot())
  const h = harness(t)

  const reset1 = h.command.handler('reset', h.ctx)
  const reset2 = h.command.handler('reset', h.ctx)
  assert.equal(dispose.mock.callCount(), 1)
  h.handlers.get('agent_settled')({}, h.ctx)
  await tick()
  assert.equal(read.mock.callCount(), 0)
  assert.equal(h.statuses.at(-1), undefined)
  assert.equal(h.notices.length, 0)

  await h.command.handler('quota', h.ctx)
  assert.equal(h.notices.at(-1).level, 'error')
  assert.match(h.notices.at(-1).text, /disposed/)

  resetDisposing.resolve()
  await Promise.all([reset1, reset2])
  h.handlers.get('agent_settled')({}, h.ctx)
  await tick()
  assert.equal(read.mock.callCount(), 1)
  assert.equal(h.statuses.at(-1), 'AGY 90%')
  assert.equal(h.notices.length, 4)
  assert.equal(h.notices.at(-1).level, 'warning')

  const staleQuota = Promise.withResolvers()
  t.mock.method(AntigravityRuntime.prototype, 'readQuota', () => staleQuota.promise)
  let notifyImpl = () => {}
  const inFlightQuota = h.command.handler('quota', {
    ...h.ctx,
    ui: { ...h.ctx.ui, notify: (text, level) => notifyImpl(text, level) },
  })
  notifyImpl = () => {
    throw new Error('stale ctx')
  }

  dispose.mock.mockImplementationOnce(() => shutdownDisposing.promise)
  const shutdownDone = h.handlers.get('session_shutdown')({}, h.ctx)
  h.handlers.get('agent_settled')({}, h.ctx)
  await tick()
  assert.equal(read.mock.callCount(), 1)
  assert.equal(h.statuses.at(-1), undefined)

  staleQuota.resolve(snapshot())
  shutdownDisposing.resolve()
  await Promise.all([inFlightQuota, shutdownDone])
})

test('cancelled TUI quota check shares in-flight request with agent_settled, and rejected TUI readQuota closes loader', async (t) => {
  initTheme('dark', false)
  const query = Promise.withResolvers()
  t.mock.method(AntigravityRuntime.prototype, 'warmup', async () => {})
  const fetch = t.mock.method(QuotaReader.prototype, 'fetch', () => query.promise)
  const h = harness(t)
  let loader = { dispose() {} }
  t.after(() => loader.dispose())
  const tuiCtx = {
    ...h.ctx,
    mode: 'tui',
    ui: {
      ...h.ctx.ui,
      custom(factory) {
        return new Promise((resolve) => {
          loader = factory(
            { requestRender() {} },
            { fg: (_color, text) => text },
            undefined,
            (value) => {
              loader.dispose()
              resolve(value)
            },
          )
        })
      },
    },
  }

  const cancelled = h.command.handler('quota', tuiCtx)
  loader.handleInput('\x1b')
  await cancelled
  assert.equal(h.notices.at(-1).text, 'Quota check cancelled')
  assert.equal(fetch.mock.callCount(), 1)

  h.handlers.get('agent_settled')({}, tuiCtx)
  h.handlers.get('agent_settled')({}, tuiCtx)
  assert.equal(fetch.mock.callCount(), 1)

  query.resolve(snapshot(0.1))
  await tick()
  assert.equal(h.statuses.at(-1), 'AGY 90%')
  assert.match(h.notices.at(-1).text, /90% used/)

  t.mock.method(AntigravityRuntime.prototype, 'readQuota', async () => {
    throw new Error('Antigravity ACP runtime is disposed.')
  })
  await h.command.handler('quota', tuiCtx)
  assert.equal(h.notices.at(-1).level, 'error')
  assert.match(h.notices.at(-1).text, /Antigravity ACP runtime is disposed\./)
})

test('unmatched or ambiguous quota ownership does not emit a misleading low-quota warning on settle', async (t) => {
  let current = groups(group('Gemini 4 Argon', 0))
  t.mock.method(QuotaReader.prototype, 'read', async () => current)
  const h = harness(t)
  h.ctx.model = { provider, id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }
  h.handlers.get('agent_settled')({}, h.ctx)
  await tick()
  assert.equal(h.statuses.at(-1), undefined)
  assert.equal(h.notices.length, 0)

  current = groups(group('Gemini Models', 0), group('Gemini Models', 0.1))
  h.handlers.get('agent_settled')({}, h.ctx)
  await tick()
  assert.equal(h.statuses.at(-1), undefined)
  assert.equal(h.notices.length, 0)
})

test('quota display mode switches via /agy-acp quota, remembers last choice across reloads, and respects env override', async (t) => {
  const home = isolateHome(t)

  t.mock.method(AntigravityRuntime.prototype, 'readQuota', async () =>
    snapshot(0.1),
  )
  t.mock.method(QuotaReader.prototype, 'peek', () => snapshot(0.1))

  // Malformed settings.json falls back cleanly to "used".
  writeFileSync(join(home, 'settings.json'), '{not-json')
  const first = mountExtension(t, 'gemini-4-argon')
  await first.command.handler('quota', first.ctx)
  assert.equal(first.statuses.at(-1), 'AGY 20%')
  assert.match(first.notices.at(-1).text, /\[██░░░░░░░░░░\]  20%/)

  // Preserves unrelated keys in settings.json when saving mode.
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({ customKey: 'keep-me' }),
  )
  await first.command.handler('quota remaining', first.ctx)
  assert.equal(first.statuses.at(-1), 'AGY 80%')
  assert.match(first.notices.at(-1).text, /\[██████████░░\]  80%/)
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')),
    { customKey: 'keep-me', quotaDisplay: 'remaining' },
  )

  // Reload remembers the last queried mode ("remaining").
  const second = mountExtension(t, 'gemini-4-argon')
  await second.command.handler('quota', second.ctx)
  assert.equal(second.statuses.at(-1), 'AGY 80%')

  await second.command.handler('quota used', second.ctx)
  assert.equal(second.statuses.at(-1), 'AGY 20%')

  // Cancelled TUI loader on mode switch still refreshes the status bar pill.
  await second.command.handler('quota remaining', {
    ...second.ctx,
    mode: 'tui',
    ui: { ...second.ctx.ui, custom: async () => null },
  })
  assert.equal(second.statuses.at(-1), 'AGY 80%')
  assert.equal(second.notices.at(-1).text, 'Quota check cancelled')

  // Environment variable overrides persisted preference at startup.
  process.env.PI_AGY_QUOTA_DISPLAY = 'remaining'
  const third = mountExtension(t, 'gemini-4-argon')
  await third.command.handler('quota', third.ctx)
  assert.equal(third.statuses.at(-1), 'AGY 80%')

  const beforeForeign = third.statuses.length
  await third.command.handler('quota', {
    ...third.ctx,
    model: {
      provider: 'anthropic',
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
    },
  })
  assert.equal(third.statuses.length, beforeForeign)
})

test('quota TTL throttles successes and failures, while force bypasses it', async (t) => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const ok = async () => ({
    code: 0,
    stderr: '',
    stdout: JSON.stringify({ command: { data: { groups: [] } } }),
  })
  const run = t.mock.fn(ok)
  const reader = new QuotaReader(() => 'fake', run, 100)
  assert.equal(reader.peek(), undefined)
  await reader.read()
  assert.equal(reader.peek().status, 'ok')
  await reader.read()
  assert.equal(run.mock.callCount(), 1)
  now += 100
  assert.equal(reader.peek(), undefined)
  run.mock.mockImplementationOnce(async () => { throw new Error('offline') })
  assert.equal((await reader.read()).status, 'error')
  await reader.read()
  assert.equal(run.mock.callCount(), 2)
  assert.equal(reader.peek(), undefined)
  await reader.read(true)
  assert.equal(run.mock.callCount(), 3)
})

test('agent settlement releases its session even after provider selection changes', (t) => {
  const settle = t.mock.method(AntigravityRuntime.prototype, 'settleSession', () => {})
  const h = harness(t)
  h.ctx.model = { provider: 'other', id: 'other' }
  h.handlers.get('agent_settled')({}, h.ctx)
  assert.deepEqual(settle.mock.calls[0].arguments, ['events-session'])
})

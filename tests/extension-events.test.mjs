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

const LIVE_CATALOG = [
  { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
  { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
  { id: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
  { id: 'gemini-pro-orchestrator-argon', name: 'Orchestrator (Argon)' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
]

// Matches real `agy 1.5.9 -p /usage --output-format json` schema and group descriptions.
const liveGroups = (claudeRemaining = 0.1, resetTime = '2030-01-01T00:00:00Z') => [
  {
    name: 'Gemini Models',
    description:
      'Models within this group: Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Carbon), Orchestrator (Argon), Gemini 3.8 Flash',
    buckets: [
      { id: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime },
    ],
  },
  {
    name: 'Claude and GPT models',
    description:
      'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
    buckets: [
      {
        id: '3p-weekly',
        window: 'weekly',
        remainingFraction: claudeRemaining,
        resetTime,
      },
    ],
  },
]

const snapshot = (
  claudeRemaining = 0.1,
  resetTime = '2030-01-01T00:00:00Z',
) => ({
  status: 'ok',
  updatedAt: new Date().toISOString(),
  groups: liveGroups(claudeRemaining, resetTime),
})

const usageOutput = (items) => ({
  code: 0,
  stderr: '',
  stdout: JSON.stringify({
    command: {
      data: {
        groups: items.map((g) => ({
          name: g.name,
          description: g.description ?? '',
          buckets: g.buckets.map((b) => ({
            id: b.id,
            name: b.name ?? '',
            window: b.window,
            remaining_fraction: b.remainingFraction,
            reset_time: b.resetTime ?? '',
          })),
        })),
      },
    },
  }),
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
  // Seed tier so explicit quota commands test QuotaReader without triggering ACP warmup.
  writeFileSync(
    join(home, 'catalog.json'),
    JSON.stringify({ tier: { name: 'Google AI Pro' } }),
  )
  const prevHome = process.env.PI_AGY_HOME
  const prevCommand = process.env.PI_AGY_COMMAND
  const prevDisplay = process.env.PI_AGY_QUOTA_DISPLAY
  process.env.PI_AGY_HOME = home
  process.env.PI_AGY_COMMAND = process.execPath
  delete process.env.PI_AGY_QUOTA_DISPLAY
  t.after(() => {
    restoreEnv('PI_AGY_HOME', prevHome)
    restoreEnv('PI_AGY_COMMAND', prevCommand)
    restoreEnv('PI_AGY_QUOTA_DISPLAY', prevDisplay)
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

function mountExtension(t, options = {}) {
  const handlers = new Map()
  const registrations = []
  const notices = []
  const statuses = []
  let command
  const onRegister = options.onRegister ?? (() => {})
  extension(
    {
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
    },
    { runCommand: options.runCommand },
  )
  const ctx = {
    sessionManager: { getSessionId: () => 'events-session' },
    hasUI: true,
    model: options.model ?? {
      provider,
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
    },
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

function harness(t, options = {}) {
  isolateHome(t)
  return mountExtension(t, options)
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
  const h = harness(t, { onRegister: () => onRegister() })
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
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
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
  const runCommand = t.mock.fn(async () => usageOutput(liveGroups()))
  const h = harness(t, { runCommand })

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

  // Seed fresh in-memory cache via explicit /agy-acp quota command.
  await h.command.handler('quota', h.ctx)
  assert.equal(runCommand.mock.callCount(), 1)
  assert.equal(h.statuses.at(-1), 'AGY 90%')

  h.handlers.get('model_select')(
    { model: { provider: 'other', id: 'other' } },
    h.ctx,
  )
  assert.equal(h.statuses.at(-1), undefined)
  h.handlers.get('model_select')(
    { model: { provider, id: 'gemini-4-argon', name: 'Gemini 4 Argon' } },
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

  // Expired TTL clears memory peek without starting a subprocess.
  now += 120_000
  h.handlers.get('model_select')({ model: h.ctx.model }, h.ctx)
  assert.equal(h.statuses.at(-1), undefined)
  await h.command.handler('status', h.ctx)
  assert.equal(runCommand.mock.callCount(), 1)

  await h.command.handler('reset', h.ctx)
  assert.equal(h.statuses.at(-1), undefined)
  assert.equal(dispose.mock.callCount(), 1)
})

test('settled checks are nonblocking, coalesced, deduplicate waterlines, and retarget across intra-provider model switches', async (t) => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const pending = Promise.withResolvers()
  const runCommand = t.mock.fn(() => pending.promise)
  const h = harness(t, { runCommand })
  const settled = h.handlers.get('agent_settled')

  settled({}, { ...h.ctx, hasUI: false })
  assert.equal(runCommand.mock.callCount(), 0)
  assert.equal(settled({}, h.ctx), undefined)
  settled({}, h.ctx)
  assert.equal(runCommand.mock.callCount(), 1)
  assert.equal(h.statuses.length, 0)

  pending.resolve(usageOutput(liveGroups()))
  await tick()
  assert.equal(h.statuses.at(-1), 'AGY 90%')
  assert.equal(h.notices.length, 1)
  assert.equal(h.notices[0].level, 'warning')
  assert.match(h.notices[0].text, /Claude and GPT models/)
  assert.match(h.notices[0].text, /90% used/)

  const checkNotice = async (fraction, cycle, warnings) => {
    now += 120_000
    runCommand.mock.mockImplementationOnce(async () =>
      usageOutput(liveGroups(fraction, cycle)),
    )
    settled({}, h.ctx)
    await tick()
    assert.equal(h.notices.length, warnings)
  }
  await checkNotice(0.1, 'cycle-1', 2)
  await checkNotice(0.1, 'cycle-1', 2)
  await checkNotice(0.05, 'cycle-1', 3)
  await checkNotice(0.04, 'cycle-1', 3)
  await checkNotice(0.05, 'cycle-2', 4)

  // Intra-provider switch while background read is in flight updates the new model and skips stale warnings.
  now += 120_000
  const switched = Promise.withResolvers()
  runCommand.mock.mockImplementationOnce(() => switched.promise)
  const callsBeforeSwitch = runCommand.mock.callCount()
  settled({}, h.ctx)
  h.handlers.get('model_select')(
    { model: { provider, id: 'gemini-4-argon', name: 'Gemini 4 Argon' } },
    h.ctx,
  )
  assert.equal(runCommand.mock.callCount(), callsBeforeSwitch + 1)
  switched.resolve(usageOutput(liveGroups(0.1, 'cycle-3')))
  await tick()
  assert.equal(h.statuses.at(-1), 'AGY 20%')
  assert.equal(h.notices.length, 4)

  // Foreign active provider ignores settled quota queries.
  h.ctx.model = { provider: 'other', id: 'other' }
  const calls = runCommand.mock.callCount()
  settled({}, h.ctx)
  assert.equal(runCommand.mock.callCount(), calls)
})

test('late background results after foreign switch, reset, error, or shutdown cannot restore status or warn', async (t) => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const runCommand = t.mock.fn()
  const h = harness(t, { runCommand })
  const expectNoUpdate = async (finish) => {
    const before = [h.statuses.length, h.notices.length]
    finish()
    await tick()
    assert.deepEqual([h.statuses.length, h.notices.length], before)
  }

  const foreignPending = Promise.withResolvers()
  runCommand.mock.mockImplementationOnce(() => foreignPending.promise)
  h.handlers.get('agent_settled')({}, h.ctx)
  h.handlers.get('model_select')({ model: { provider: 'other' } }, h.ctx)
  h.handlers.get('model_select')({ model: h.ctx.model }, h.ctx)
  await expectNoUpdate(() => foreignPending.resolve(usageOutput(liveGroups())))

  now += 120_000
  const newSessionPending = Promise.withResolvers()
  runCommand.mock.mockImplementationOnce(() => newSessionPending.promise)
  h.handlers.get('agent_settled')({}, h.ctx)
  await h.handlers.get('session_start')({ reason: 'new' }, h.ctx)
  h.handlers.get('model_select')({ model: h.ctx.model }, h.ctx)
  await expectNoUpdate(() =>
    newSessionPending.resolve(usageOutput(liveGroups())),
  )

  now += 120_000
  const resetPending = Promise.withResolvers()
  runCommand.mock.mockImplementationOnce(() => resetPending.promise)
  h.handlers.get('agent_settled')({}, h.ctx)
  await h.command.handler('reset', h.ctx)
  await expectNoUpdate(() => resetPending.resolve(usageOutput(liveGroups())))

  now += 120_000
  const cliErrorPending = Promise.withResolvers()
  runCommand.mock.mockImplementationOnce(() => cliErrorPending.promise)
  h.handlers.get('agent_settled')({}, h.ctx)
  await expectNoUpdate(() =>
    cliErrorPending.resolve({ code: 1, stdout: '', stderr: 'offline' }),
  )

  now += 120_000
  const rejectedPending = Promise.withResolvers()
  runCommand.mock.mockImplementationOnce(() => rejectedPending.promise)
  h.handlers.get('agent_settled')({}, h.ctx)
  await expectNoUpdate(() => rejectedPending.reject(new Error('offline')))

  now += 120_000
  const shutdownPending = Promise.withResolvers()
  runCommand.mock.mockImplementationOnce(() => shutdownPending.promise)
  h.handlers.get('agent_settled')({}, h.ctx)
  await h.handlers.get('session_shutdown')({}, h.ctx)
  await expectNoUpdate(() => shutdownPending.resolve(usageOutput(liveGroups())))

  const callsAfterShutdown = runCommand.mock.callCount()
  h.handlers.get('agent_settled')({}, h.ctx)
  assert.equal(runCommand.mock.callCount(), callsAfterShutdown)
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

test('quota selection covers live agy 1.5.9 catalog, multi-group minimums, qualifiers, and ambiguity rejection', () => {
  const liveSnapshot = snapshot()
  assert.deepEqual(
    LIVE_CATALOG.map((model) => formatQuotaStatus(liveSnapshot, model)),
    [
      'AGY 20%',
      'AGY 20%',
      'AGY 20%',
      'AGY 20%',
      'AGY 20%',
      'AGY 20%',
      'AGY 90%',
      'AGY 90%',
      'AGY 90%',
    ],
  )
  assert.equal(
    formatQuotaStatus(liveSnapshot, { id: 'gemini-4-argon', name: 'Gemini 4 Argon' }, 'remaining'),
    'AGY 80%',
  )
  assert.equal(
    formatQuotaStatus(liveSnapshot, { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }, 'remaining'),
    'AGY 10%',
  )
  assert.equal(
    formatQuotaStatus(liveSnapshot, { id: 'unknown' }),
    undefined,
  )
  assert.equal(
    quotaForModel(snapshot(0), { id: 'claude-opus-5-5' }).fraction,
    0,
  )
  assert.equal(
    formatQuotaStatus(snapshot(NaN), { id: 'claude-opus-5-5' }),
    undefined,
  )
  assert.equal(
    formatQuotaStatus({ ...liveSnapshot, status: 'error' }, { id: 'claude-opus-5-5' }),
    undefined,
  )

  // Picks lowest remaining window within the matched group.
  const multiWindow = groups(
    group('Gemini Models', 0.8, '', [
      { id: 'w', window: 'weekly', remainingFraction: 0.25 },
    ]),
  )
  assert.equal(
    formatQuotaStatus(multiWindow, { id: 'gemini-4-argon' }, 'remaining'),
    'AGY 25%',
  )

  // Multi-group governing minimum across shared umbrella + dedicated group in both directions.
  const dedicatedExhausted = groups(
    group('Gemini Models', 0.7, 'Models within this group: Gemini 4 Argon, Gemini 3.8 Flash'),
    group('Gemini 4 Argon Models', 0),
  )
  assert.equal(
    formatQuotaStatus(dedicatedExhausted, { id: 'gemini-4-argon' }, 'remaining'),
    'AGY 0%',
  )
  assert.equal(
    formatQuotaStatus(dedicatedExhausted, { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, 'remaining'),
    'AGY 70%',
  )
  assert.equal(quotaForModel(dedicatedExhausted, { id: 'gemini-2.5-pro' }), undefined)

  const sharedExhausted = groups(
    group('Gemini Models', 0, 'Models within this group: Gemini 4 Argon, Gemini 3.8 Flash'),
    group('Gemini 4 Argon Models', 0.8),
  )
  const sharedHit = quotaForModel(sharedExhausted, { id: 'gemini-4-argon', name: 'Gemini 4 Argon' })
  assert.equal(sharedHit.fraction, 0)
  assert.equal(sharedHit.group.name, 'Gemini Models')

  // Multi-group minimum for display-name-only orchestrator listed in two explicit pools.
  const orchestratorSplit = groups(
    group('Gemini Models', 0.72, 'Models within this group: Gemini 4 Carbon, Orchestrator (Argon)'),
    group('Gemini 4 Argon Pool', 0, 'Models within this group: Gemini 4 Argon, Orchestrator (Argon)'),
  )
  assert.equal(
    formatQuotaStatus(orchestratorSplit, { id: 'gemini-pro-orchestrator-argon', name: 'Orchestrator (Argon)' }, 'remaining'),
    'AGY 0%',
  )

  // Issue #9 fixture without explicit lists: generic family fallback stays isolated from dedicated sibling group.
  const issue9 = groups(
    group('Gemini Models', 0.7),
    group('Claude and GPT models', 0.9),
    group('Gemini 4 Argon', 0),
  )
  assert.equal(formatQuotaStatus(issue9, { id: 'gemini-3.8-flash' }, 'remaining'), 'AGY 70%')
  assert.equal(formatQuotaStatus(issue9, { id: 'gemini-4-argon' }, 'remaining'), 'AGY 0%')

  // Closed explicit list excludes its group name; sibling suffixes and version boundaries never cross-match.
  const closedExplicit = groups(
    group('Gemini Pro', 0, 'Models within this group: Gemini 2.5 Pro'),
  )
  assert.equal(quotaForModel(closedExplicit, { id: 'gemini-3.8-pro' }), undefined)
  assert.equal(quotaForModel(closedExplicit, { id: 'gemini-pro' }), undefined)

  const dedicatedFlash = groups(
    group('Gemini Models', 0.7),
    group('Gemini 3.8 Flash', 0),
    group('GPT-OSS Models', 0.2),
  )
  assert.equal(
    formatQuotaStatus(dedicatedFlash, { id: 'gemini-3.8-flash-lite', name: 'Gemini 3.8 Flash Lite' }, 'remaining'),
    'AGY 70%',
  )
  assert.equal(formatQuotaStatus(dedicatedFlash, { id: 'gemini-3.8-flash-8b' }, 'remaining'), 'AGY 70%')
  assert.equal(formatQuotaStatus(dedicatedFlash, { id: 'gpt-oss-120b-medium' }, 'remaining'), 'AGY 20%')
  assert.equal(quotaForModel(dedicatedFlash, { id: 'gpt-5' }), undefined)

  // Qualifiers, thinking tags, dated suffixes, and ambiguous tie rejection.
  const incompatibleQualifier = groups(
    group('GPT-OSS 120B (High)', 0.1),
    group('Claude and GPT models', 0.9, 'Models within this group: Claude Opus 5.5 (Thinking), GPT-OSS 120B.'),
  )
  assert.equal(
    formatQuotaStatus(incompatibleQualifier, { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B' }, 'remaining'),
    'AGY 90%',
  )
  assert.equal(
    formatQuotaStatus(incompatibleQualifier, { id: 'claude-opus-5-5-20260301', name: 'Claude Opus 5.5' }, 'remaining'),
    'AGY 90%',
  )

  const collidingQualifiers = groups(
    group('Claude Opus 5.5 (High)', 0.1),
    group('Claude Opus 5.5 (Low)', 0.8),
  )
  assert.equal(
    quotaForModel(collidingQualifiers, { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }),
    undefined,
  )

  const singleEffortCap = groups(
    group('Claude Opus 5.5 (High)', 0),
    group('Claude and GPT models', 0.9),
  )
  assert.equal(
    quotaForModel(singleEffortCap, {
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
    }),
    undefined,
  )
  assert.equal(
    formatQuotaStatus(
      singleEffortCap,
      { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
      'remaining',
    ),
    'AGY 0%',
  )
  assert.equal(
    formatQuotaStatus(
      singleEffortCap,
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      'remaining',
    ),
    'AGY 90%',
  )

  const explicitSharedWithEffortCap = groups(
    group(
      'Claude and GPT models',
      0.9,
      'Models within this group: Claude Opus 5.5, Claude Opus 4.6 (Thinking), Claude Sonnet 5.5',
    ),
    group('Claude Opus 5.5 (High)', 0),
    group('Claude Opus 4.6 (High)', 0),
  )
  assert.equal(
    quotaForModel(explicitSharedWithEffortCap, {
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
    }),
    undefined,
  )
  assert.equal(
    quotaForModel(explicitSharedWithEffortCap, {
      id: 'claude-opus-4-6-thinking',
      name: 'Claude Opus 4.6 (Thinking)',
    }),
    undefined,
  )
  assert.equal(
    formatQuotaStatus(
      explicitSharedWithEffortCap,
      { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
      'remaining',
    ),
    'AGY 0%',
  )
  assert.equal(
    formatQuotaStatus(
      explicitSharedWithEffortCap,
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      'remaining',
    ),
    'AGY 90%',
  )

  const exhaustedSharedThinking = groups(
    group(
      'Claude and GPT models',
      0,
      'Models within this group: Claude Opus 5.5, Claude Opus 4.6 (Thinking), Claude Sonnet 5.5',
    ),
    group('Claude Opus 4.6 (High)', 0.8),
  )
  assert.equal(
    formatQuotaStatus(
      exhaustedSharedThinking,
      { id: 'claude-opus-4-6-high', name: 'Claude Opus 4.6 (High)' },
      'remaining',
    ),
    'AGY 0%',
  )
  assert.equal(
    formatQuotaStatus(
      exhaustedSharedThinking,
      { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (High)' },
      'remaining',
    ),
    'AGY 0%',
  )
  assert.equal(
    formatQuotaStatus(
      exhaustedSharedThinking,
      {
        id: 'claude-opus-4-6-thinking-high',
        name: 'Claude Opus 4.6 (Thinking) (High)',
      },
      'remaining',
    ),
    'AGY 0%',
  )

  const conflictingEfforts = groups(
    group('GPT-OSS 120B (Medium)', 0.8),
    group('GPT-OSS 120B (High)', 0.1),
  )
  assert.equal(
    quotaForModel(conflictingEfforts, {
      id: 'gpt-oss-120b-medium',
      name: 'GPT-OSS 120B (High)',
    }),
    undefined,
  )

  const generationLineSized = groups(
    group('Gemini 3.8', 0),
    group('Gemini Models', 0.8),
  )
  assert.equal(
    formatQuotaStatus(
      generationLineSized,
      { id: 'gemini-3.8-flash-8b' },
      'remaining',
    ),
    'AGY 0%',
  )
  assert.equal(
    quotaForModel(groups(group('Gemini Models', 0.2), group('Gemini Models', 0.8)), { id: 'gemini-3.8-flash' }),
    undefined,
  )
  assert.equal(
    quotaForModel(groups(group('Gemini 3.8', 0.2), group('Gemini Flash', 0.8)), { id: 'gemini-3.8-flash' }),
    undefined,
  )
})

test('agent_settled during reset or shutdown disposal skips quota reads and does not block replacement runtime', async (t) => {
  const resetDisposing = Promise.withResolvers()
  const shutdownDisposing = Promise.withResolvers()
  const realDispose = AntigravityRuntime.prototype.dispose
  const dispose = t.mock.method(AntigravityRuntime.prototype, 'dispose')
  dispose.mock.mockImplementationOnce(async function () {
    await realDispose.call(this)
    await resetDisposing.promise
  })
  const runCommand = t.mock.fn(async () => usageOutput(liveGroups()))
  const h = harness(t, { runCommand })

  const reset1 = h.command.handler('reset', h.ctx)
  const reset2 = h.command.handler('reset', h.ctx)
  assert.equal(dispose.mock.callCount(), 1)
  h.handlers.get('agent_settled')({}, h.ctx)
  await tick()
  assert.equal(runCommand.mock.callCount(), 0)
  assert.equal(h.statuses.at(-1), undefined)
  assert.equal(h.notices.length, 0)

  await h.command.handler('quota', h.ctx)
  assert.equal(h.notices.at(-1).level, 'error')
  assert.match(h.notices.at(-1).text, /disposed/)

  resetDisposing.resolve()
  await Promise.all([reset1, reset2])
  h.handlers.get('agent_settled')({}, h.ctx)
  await tick()
  assert.equal(runCommand.mock.callCount(), 1)
  assert.equal(h.statuses.at(-1), 'AGY 90%')
  assert.deepEqual(
    h.notices.map((n) => n.level),
    ['error', 'info', 'info', 'warning'],
  )

  const staleQuota = Promise.withResolvers()
  runCommand.mock.mockImplementationOnce(() => staleQuota.promise)
  let notifyImpl = () => {}
  const inFlightQuota = h.command.handler('quota', {
    ...h.ctx,
    ui: { ...h.ctx.ui, notify: (text, level) => notifyImpl(text, level) },
  })
  notifyImpl = () => {
    throw new Error('stale ctx')
  }

  dispose.mock.mockImplementationOnce(async function () {
    await realDispose.call(this)
    await shutdownDisposing.promise
  })
  const shutdownDone = h.handlers.get('session_shutdown')({}, h.ctx)
  h.handlers.get('agent_settled')({}, h.ctx)
  await tick()
  assert.equal(runCommand.mock.callCount(), 2)
  assert.equal(h.statuses.at(-1), undefined)

  staleQuota.resolve(usageOutput(liveGroups()))
  shutdownDisposing.resolve()
  await Promise.all([inFlightQuota, shutdownDone])
})

test('cancelled TUI quota check shares in-flight request with agent_settled, and failed runCommand closes loader', async (t) => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  initTheme('dark', false)
  const query = Promise.withResolvers()
  const runCommand = t.mock.fn(() => query.promise)
  const h = harness(t, { runCommand })
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
  assert.equal(runCommand.mock.callCount(), 1)

  h.handlers.get('agent_settled')({}, tuiCtx)
  h.handlers.get('agent_settled')({}, tuiCtx)
  assert.equal(runCommand.mock.callCount(), 1)

  query.resolve(usageOutput(liveGroups(0.1)))
  await tick()
  assert.equal(h.statuses.at(-1), 'AGY 90%')
  assert.match(h.notices.at(-1).text, /90% used/)

  now += 120_000
  runCommand.mock.mockImplementationOnce(async () => ({
    code: 1,
    stdout: '',
    stderr: 'Antigravity CLI offline',
  }))
  await h.command.handler('quota', tuiCtx)
  assert.equal(h.notices.at(-1).level, 'error')
  assert.match(h.notices.at(-1).text, /Antigravity CLI offline/)
})

test('unmatched or ambiguous quota ownership does not emit a misleading low-quota warning on settle', async (t) => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const runCommand = t.mock.fn(async () => usageOutput([group('Gemini 4 Argon', 0)]))
  const h = harness(t, {
    runCommand,
    model: { provider, id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  })
  h.handlers.get('agent_settled')({}, h.ctx)
  await tick()
  assert.equal(h.statuses.at(-1), undefined)
  assert.equal(h.notices.length, 0)

  now += 120_000
  runCommand.mock.mockImplementationOnce(async () =>
    usageOutput([group('Gemini Models', 0), group('Gemini Models', 0.1)]),
  )
  h.handlers.get('agent_settled')({}, h.ctx)
  await tick()
  assert.equal(h.statuses.at(-1), undefined)
  assert.equal(h.notices.length, 0)

  now += 120_000
  runCommand.mock.mockImplementationOnce(async () =>
    usageOutput([
      group('Claude Opus 5.5 (High)', 0),
      group('Claude and GPT models', 0.9),
    ]),
  )
  h.handlers.get('agent_settled')(
    {},
    {
      ...h.ctx,
      model: { provider, id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    },
  )
  await tick()
  assert.equal(h.statuses.at(-1), undefined)
  assert.equal(h.notices.length, 0)
})

test('quota display mode switches via /agy-acp quota, remembers last choice across reloads, and respects env override', async (t) => {
  const home = isolateHome(t)
  const runCommand = t.mock.fn(async () => usageOutput(liveGroups(0.1)))

  // Malformed settings.json falls back cleanly to "used".
  writeFileSync(join(home, 'settings.json'), '{not-json')
  const first = mountExtension(t, {
    model: { provider, id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    runCommand,
  })
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
  const second = mountExtension(t, {
    model: { provider, id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    runCommand,
  })
  await second.command.handler('quota', second.ctx)
  assert.equal(second.statuses.at(-1), 'AGY 80%')

  await second.command.handler('quota used', second.ctx)
  assert.equal(second.statuses.at(-1), 'AGY 20%')

  // Cancelled TUI loader on mode switch still refreshes the status bar pill from in-memory cache.
  await second.command.handler('quota remaining', {
    ...second.ctx,
    mode: 'tui',
    ui: { ...second.ctx.ui, custom: async () => null },
  })
  assert.equal(second.statuses.at(-1), 'AGY 80%')
  assert.equal(second.notices.at(-1).text, 'Quota check cancelled')

  // Environment variable overrides persisted preference at startup.
  process.env.PI_AGY_QUOTA_DISPLAY = 'remaining'
  const third = mountExtension(t, {
    model: { provider, id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    runCommand,
  })
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
  run.mock.mockImplementationOnce(async () => {
    throw new Error('offline')
  })
  assert.equal((await reader.read()).status, 'error')
  await reader.read()
  assert.equal(run.mock.callCount(), 2)
  assert.equal(reader.peek(), undefined)
  await reader.read(true)
  assert.equal(run.mock.callCount(), 3)
})

test('agent settlement releases its session even after provider selection changes', (t) => {
  const settle = t.mock.method(
    AntigravityRuntime.prototype,
    'settleSession',
    () => {},
  )
  const h = harness(t)
  h.ctx.model = { provider: 'other', id: 'other' }
  h.handlers.get('agent_settled')({}, h.ctx)
  assert.deepEqual(settle.mock.calls[0].arguments, ['events-session'])
})

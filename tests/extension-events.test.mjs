import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function harness(t, onRegister = () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'pi-events-'))
  const prevHome = process.env.PI_AGY_HOME
  const prevDisplay = process.env.PI_AGY_QUOTA_DISPLAY
  process.env.PI_AGY_HOME = home
  delete process.env.PI_AGY_QUOTA_DISPLAY
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
    model: { provider, id: 'claude-opus-5-5' },
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
    if (prevHome === undefined) delete process.env.PI_AGY_HOME
    else process.env.PI_AGY_HOME = prevHome
    if (prevDisplay === undefined) delete process.env.PI_AGY_QUOTA_DISPLAY
    else process.env.PI_AGY_QUOTA_DISPLAY = prevDisplay
    rmSync(home, { recursive: true, force: true })
  })
  return { handlers, registrations, command, ctx, statuses, notices }
}

test('refresh does not re-register and abort itself, forwards force/signal, and releases its guard after failure', async (t) => {
  let controller, runtime
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
  const h = harness(t, () => controller?.abort())
  controller = new AbortController()
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
  controller = undefined
  runtime.host.onModelsChanged()
  assert.equal(h.registrations.length, 2)
})

test('lifecycle uses light resets, cache warming stops, and selecting models only reads fresh memory', async (t) => {
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
  h.ctx.model = { provider: 'other', id: 'other' }
  const calls = read.mock.callCount()
  settled({}, h.ctx)
  assert.equal(read.mock.callCount(), calls)
})

test('late background results after model switches, reset, or shutdown cannot restore status or warn', async (t) => {
  let pending
  t.mock.method(QuotaReader.prototype, 'read', () => pending.promise)
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
  await h.handlers.get('session_shutdown')({}, h.ctx)
  await expectNoUpdate(() => pending.resolve(snapshot()))

  pending = Promise.withResolvers()
  h.handlers.get('agent_settled')({}, h.ctx)
  await expectNoUpdate(() => pending.resolve({ ...snapshot(), status: 'error' }))

  pending = Promise.withResolvers()
  h.handlers.get('agent_settled')({}, h.ctx)
  await expectNoUpdate(() => pending.reject(new Error('offline')))
})

test('quota selection matches specific groups, explicit members, and display names without misleading fallbacks', () => {
  assert.equal(formatQuotaStatus(snapshot(), 'gemini-4-argon'), 'AGY 20%')
  assert.equal(formatQuotaStatus(snapshot(), 'gpt-oss-120b-medium'), 'AGY 90%')
  assert.equal(formatQuotaStatus(snapshot(), 'unknown'), undefined)
  assert.equal(
    formatQuotaStatus(snapshot(), 'gemini-4-argon', 'remaining'),
    'AGY 80%',
  )
  assert.equal(
    formatQuotaStatus(snapshot(), 'gpt-oss-120b-medium', 'remaining'),
    'AGY 10%',
  )
  assert.equal(quotaForModel(snapshot(0), 'claude-opus-5-5').fraction, 0)
  assert.equal(formatQuotaStatus(snapshot(NaN), 'claude-opus-5-5'), undefined)
  assert.equal(formatQuotaStatus({ ...snapshot(), status: 'error' }), undefined)

  const specialized = {
    status: 'ok',
    updatedAt: new Date().toISOString(),
    groups: [
      {
        name: 'Gemini Models',
        description: '',
        buckets: [{ id: 'g', window: '5h', remainingFraction: 0.7 }],
      },
      {
        name: 'Claude and GPT models',
        description: '',
        buckets: [{ id: 'c', window: '5h', remainingFraction: 0.9 }],
      },
      {
        name: 'Gemini 4 Argon',
        description: '',
        buckets: [{ id: 'a', window: '5h', remainingFraction: 0 }],
      },
    ],
  }
  assert.equal(
    formatQuotaStatus(
      specialized,
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      'remaining',
    ),
    'AGY 70%',
  )
  assert.equal(
    formatQuotaStatus(
      specialized,
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
      'remaining',
    ),
    'AGY 0%',
  )
  assert.equal(
    formatQuotaStatus(specialized, 'claude-opus-5-5', 'remaining'),
    'AGY 90%',
  )
  assert.equal(
    formatQuotaStatus(specialized, 'gpt-oss-120b-medium', 'remaining'),
    'AGY 90%',
  )

  const explicitMembers = {
    status: 'ok',
    updatedAt: new Date().toISOString(),
    groups: [
      {
        name: 'Custom Tier',
        description: 'Models within this group: Gemini Flash, Claude Opus 5.5',
        buckets: [{ id: 'm', window: '5h', remainingFraction: 0.4 }],
      },
      {
        name: 'Gemini Pro',
        description: '',
        buckets: [{ id: 'p', window: '5h', remainingFraction: 0.1 }],
      },
    ],
  }
  assert.equal(
    formatQuotaStatus(
      explicitMembers,
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      'remaining',
    ),
    'AGY 40%',
  )
  assert.equal(
    formatQuotaStatus(
      explicitMembers,
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      'remaining',
    ),
    'AGY 40%',
  )

  const ambiguous = {
    status: 'ok',
    updatedAt: new Date().toISOString(),
    groups: [
      {
        name: 'Gemini 4 Argon',
        description: '',
        buckets: [{ id: 'a', window: '5h', remainingFraction: 0 }],
      },
      {
        name: 'Gemini Pro',
        description: '',
        buckets: [{ id: 'p', window: '5h', remainingFraction: 0.8 }],
      },
    ],
  }
  assert.equal(quotaForModel(ambiguous, 'gemini-3.8-flash'), undefined)

  const duplicateGeneric = {
    status: 'ok',
    updatedAt: new Date().toISOString(),
    groups: [
      {
        name: 'Gemini Models',
        description: '',
        buckets: [{ id: 'g1', window: '5h', remainingFraction: 0.2 }],
      },
      {
        name: 'Gemini Models',
        description: '',
        buckets: [{ id: 'g2', window: '5h', remainingFraction: 0.8 }],
      },
    ],
  }
  assert.equal(quotaForModel(duplicateGeneric, 'gemini-3.8-flash'), undefined)

  const multiVariant = {
    status: 'ok',
    updatedAt: new Date().toISOString(),
    groups: [
      {
        name: 'Gemini 3.8',
        description: '',
        buckets: [{ id: 'g38', window: '5h', remainingFraction: 0.2 }],
      },
      {
        name: 'Gemini Flash',
        description: '',
        buckets: [{ id: 'gf', window: '5h', remainingFraction: 0.8 }],
      },
    ],
  }
  assert.equal(quotaForModel(multiVariant, 'gemini-3.8-flash'), undefined)

  const versionMismatch = {
    status: 'ok',
    updatedAt: new Date().toISOString(),
    groups: [
      {
        name: 'Gemini 3',
        description: '',
        buckets: [{ id: 'g3', window: '5h', remainingFraction: 0.1 }],
      },
    ],
  }
  assert.equal(quotaForModel(versionMismatch, 'gemini-2.3-pro'), undefined)

  const slashSeparated = {
    status: 'ok',
    updatedAt: new Date().toISOString(),
    groups: [
      {
        name: 'Tier A',
        description: 'Gemini 3.8 Flash / Gemini 3.8 Pro',
        buckets: [{ id: 'ta', window: '5h', remainingFraction: 0.5 }],
      },
    ],
  }
  assert.equal(
    formatQuotaStatus(slashSeparated, 'gemini-3.8-flash', 'remaining'),
    'AGY 50%',
  )
})

test('ambiguous quota ownership does not emit a misleading low-quota warning on settle', async (t) => {
  const ambiguous = {
    status: 'ok',
    updatedAt: new Date().toISOString(),
    groups: [
      {
        name: 'Gemini 4 Argon',
        description: '',
        buckets: [{ id: 'a', window: '5h', remainingFraction: 0 }],
      },
    ],
  }
  t.mock.method(QuotaReader.prototype, 'read', async () => ambiguous)
  const h = harness(t)
  h.ctx.model = { provider, id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }
  h.handlers.get('agent_settled')({}, h.ctx)
  await tick()
  assert.equal(h.statuses.at(-1), undefined)
  assert.equal(h.notices.length, 0)
})

test('quota display mode switches via /agy-acp quota, remembers last choice across reloads, and respects env override', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pi-quota-pref-'))
  const prevHome = process.env.PI_AGY_HOME
  const prevDisplay = process.env.PI_AGY_QUOTA_DISPLAY
  process.env.PI_AGY_HOME = home
  delete process.env.PI_AGY_QUOTA_DISPLAY
  t.after(() => {
    if (prevHome === undefined) delete process.env.PI_AGY_HOME
    else process.env.PI_AGY_HOME = prevHome
    if (prevDisplay === undefined) delete process.env.PI_AGY_QUOTA_DISPLAY
    else process.env.PI_AGY_QUOTA_DISPLAY = prevDisplay
    rmSync(home, { recursive: true, force: true })
  })

  t.mock.method(AntigravityRuntime.prototype, 'readQuota', async () =>
    snapshot(0.1),
  )
  t.mock.method(QuotaReader.prototype, 'peek', () => snapshot(0.1))

  const loadExtension = () => {
    const statuses = []
    const notices = []
    let command
    extension({
      registerProvider() {},
      registerCommand(_name, def) {
        command = def
      },
      on() {},
    })
    const ctx = {
      hasUI: true,
      model: { provider, id: 'gemini-4-argon' },
      ui: {
        setStatus(_key, text) {
          statuses.push(text)
        },
        notify(text, level) {
          notices.push({ text, level })
        },
      },
    }
    return { command, ctx, statuses, notices }
  }

  // Malformed settings.json falls back cleanly to "used".
  writeFileSync(join(home, 'settings.json'), '{not-json')
  const first = loadExtension()
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
  const second = loadExtension()
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
  const third = loadExtension()
  await third.command.handler('quota', third.ctx)
  assert.equal(third.statuses.at(-1), 'AGY 80%')
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

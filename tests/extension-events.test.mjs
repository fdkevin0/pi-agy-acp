import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
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
  const previous = process.env.PI_AGY_HOME
  process.env.PI_AGY_HOME = home
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
    if (previous === undefined) delete process.env.PI_AGY_HOME
    else process.env.PI_AGY_HOME = previous
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
  assert.equal(h.statuses.at(-1), 'AGY 80%')
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
  assert.equal(h.statuses.at(-1), 'AGY 10%')
  assert.equal(h.notices.length, 1)
  assert.equal(h.notices[0].level, 'warning')
  assert.match(h.notices[0].text, /Claude\/GPT/)
  for (const [fraction, cycle, warnings] of [
    [0.1, 'cycle-1', 2],
    [0.1, 'cycle-1', 2],
    [0.05, 'cycle-1', 3],
    [0.04, 'cycle-1', 3],
    [0.05, 'cycle-2', 4],
  ]) {
    value = Promise.resolve(snapshot(fraction, cycle))
    settled({}, h.ctx)
    await tick()
    assert.equal(h.notices.length, warnings)
  }
  h.ctx.model = { provider: 'other', id: 'other' }
  const calls = read.mock.callCount()
  settled({}, h.ctx)
  assert.equal(read.mock.callCount(), calls)
})

test('late background results after model switches, reset, or shutdown cannot restore status or warn', async (t) => {
  let pending
  t.mock.method(QuotaReader.prototype, 'read', () => pending.promise)
  const h = harness(t)
  for (const action of ['switch', 'reset', 'shutdown', 'error', 'reject']) {
    pending = Promise.withResolvers()
    h.handlers.get('agent_settled')({}, h.ctx)
    if (action === 'switch')
      h.handlers.get('model_select')({ model: { provider: 'other' } }, h.ctx)
    if (action === 'reset') await h.command.handler('reset', h.ctx)
    if (action === 'shutdown')
      await h.handlers.get('session_shutdown')({}, h.ctx)
    const before = [h.statuses.length, h.notices.length]
    if (action === 'reject') pending.reject(new Error('offline'))
    else
      pending.resolve(
        action === 'error' ? { ...snapshot(), status: 'error' } : snapshot(),
      )
    await tick()
    assert.deepEqual([h.statuses.length, h.notices.length], before)
  }
})

test('quota selection uses the active family and falls back to the lowest valid bucket', () => {
  assert.equal(formatQuotaStatus(snapshot(), 'gemini-4-argon'), 'AGY 80%')
  assert.equal(formatQuotaStatus(snapshot(), 'gpt-oss-120b-medium'), 'AGY 10%')
  assert.equal(formatQuotaStatus(snapshot(), 'unknown'), 'AGY 10%')
  assert.equal(quotaForModel(snapshot(0), 'claude-opus-5-5').fraction, 0)
  assert.equal(formatQuotaStatus(snapshot(NaN), 'claude-opus-5-5'), undefined)
  assert.equal(formatQuotaStatus({ ...snapshot(), status: 'error' }), undefined)
})

test('quota TTL throttles successes and failures, while force bypasses it', async (t) => {
  let now = 1000,
    calls = 0,
    fail = false
  t.mock.method(Date, 'now', () => now)
  const reader = new QuotaReader(
    () => 'fake',
    async () => {
      calls++
      if (fail) throw new Error('offline')
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ command: { data: { groups: [] } } }),
      }
    },
    100,
  )
  assert.equal(reader.peek(), undefined)
  await reader.read()
  assert.equal(reader.peek().status, 'ok')
  await reader.read()
  assert.equal(calls, 1)
  now += 100
  assert.equal(reader.peek(), undefined)
  fail = true
  assert.equal((await reader.read()).status, 'error')
  await reader.read()
  assert.equal(calls, 2)
  assert.equal(reader.peek(), undefined)
  await reader.read(true)
  assert.equal(calls, 3)
})

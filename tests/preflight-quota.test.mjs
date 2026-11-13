import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import {
  resolveAgyBinary,
  assertSupportedAgyVersion,
  prepareHome,
  removeSessionArtifacts,
} from '../src/preflight.ts'
import { defaults } from '../src/config.ts'
import { AntigravityRuntime } from '../src/runtime.ts'
import { ModelCatalog, FALLBACK_MODELS } from '../src/catalog.ts'
import extension from '../index.ts'
import { formatQuota, formatStatus } from '../src/format.ts'
import { parseUsage, QuotaReader, readLoggedEmail } from '../src/quota.ts'

function isolateHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-account-'))
  const previous = process.env.PI_AGY_HOME
  process.env.PI_AGY_HOME = root
  t.after(() => {
    if (previous === undefined) delete process.env.PI_AGY_HOME
    else process.env.PI_AGY_HOME = previous
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

test('startup removes stale ACP data and numeric log backups while preserving persistent files', (t) => {
  const home = isolateHome(t)
  const stale = [
    'agy/conversations/session.db',
    'agy/conversations/session.db-wal',
    'agy/conversations/session.db-shm',
    'agy/brain/session/note.md',
    'agy/conversation_summaries.db',
    'agy/conversation_summaries.db-wal',
    'agy/conversation_summaries.db-shm',
    'agy/jetbox_summaries_proto.pb',
    'acp.log.123',
    'acp.log.456',
  ]
  const retained = [
    'acp.log',
    'catalog.json',
    'agy/antigravity-oauth-token',
    'agy/other-data',
    'acp.log.backup',
    'acp.log.123.old',
  ]
  for (const name of [...stale, ...retained]) {
    const path = join(home, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, name)
  }
  const workspace = prepareHome(home, join(home, 'no-user-auth'))
  assert.equal(existsSync(workspace), true)
  for (const name of stale)
    assert.equal(existsSync(join(home, name)), false, name)
  for (const name of retained)
    assert.equal(readFileSync(join(home, name), 'utf8'), name)
  assert.doesNotThrow(() => prepareHome(home, join(home, 'no-user-auth')))
})

test('session cleanup is scoped, idempotent, and refuses path traversal or linked parents', (t) => {
  const home = isolateHome(t)
  const target = 'session-1_abc.2'
  const paths = (id) => [
    `agy/conversations/${id}.db`,
    `agy/conversations/${id}.db-wal`,
    `agy/conversations/${id}.db-shm`,
    `agy/brain/${id}/note.md`,
  ]
  for (const name of [...paths(target), ...paths('other')]) {
    const path = join(home, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'keep until closed')
  }
  for (const invalid of [
    '',
    '.',
    '..',
    '../other',
    'a..b',
    '/other',
    'a/b',
    'a\\b',
    's\n',
    null,
  ]) {
    assert.doesNotThrow(() => removeSessionArtifacts(home, invalid))
    for (const name of [...paths(target), ...paths('other')])
      assert.equal(existsSync(join(home, name)), true)
  }
  removeSessionArtifacts(home, target)
  for (const name of paths(target))
    assert.equal(existsSync(join(home, name)), false)
  for (const name of paths('other'))
    assert.equal(existsSync(join(home, name)), true)
  assert.doesNotThrow(() => removeSessionArtifacts(home, target))

  const outside = join(home, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'linked.db'), 'untouched')
  rmSync(join(home, 'agy', 'conversations'), { recursive: true })
  symlinkSync(outside, join(home, 'agy', 'conversations'), 'junction')
  removeSessionArtifacts(home, 'linked')
  assert.equal(readFileSync(join(outside, 'linked.db'), 'utf8'), 'untouched')
  prepareHome(home, join(home, 'no-user-auth'))
  assert.equal(readFileSync(join(outside, 'linked.db'), 'utf8'), 'untouched')
})

test('tier-only metadata is validated and persisted without model changes', (t) => {
  const root = isolateHome(t)
  const path = join(root, 'catalog.json')
  const catalog = new ModelCatalog(path)
  const tier = { name: 'Google AI Ultra', id: 'ultra' }
  assert.equal(
    catalog.observe(undefined, undefined, {
      ...tier,
      upgradeUri: 'https://example.com',
    }),
    false,
  )
  assert.deepEqual(catalog.tier(), tier)
  assert.deepEqual(new ModelCatalog(path).tier(), tier)
  const saved = readFileSync(path, 'utf8')
  for (const invalid of [undefined, null, {}, { name: '  ' }, { name: 42 }])
    catalog.observe(undefined, undefined, invalid)
  assert.equal(readFileSync(path, 'utf8'), saved)
  catalog.observe([], undefined, { name: ' Google AI Pro ', id: 42 })
  assert.deepEqual(new ModelCatalog(path).tier(), { name: 'Google AI Pro' })
  assert.equal(readFileSync(path, 'utf8').includes('upgradeUri'), false)
  writeFileSync(path, JSON.stringify({ tier: { name: 123, id: 'bad' } }))
  assert.equal(new ModelCatalog(path).tier(), undefined)
})

test('login logs use the last match in the first readable matching tail', (t) => {
  const root = isolateHome(t)
  const primary = join(root, 'acp.log')
  const fallback = join(root, 'cli.log')
  const missing = join(root, 'missing')
  writeFileSync(
    primary,
    'applyAuthResult: email=old@example.com, token omitted\n' +
      'x'.repeat(70_000),
  )
  writeFileSync(
    fallback,
    'OAuth: authenticated successfully as fallback@example.com\n',
  )
  assert.equal(readLoggedEmail([primary]), undefined)
  assert.equal(
    readLoggedEmail([missing, root, primary, fallback]),
    'fallback@example.com',
  )
  writeFileSync(
    primary,
    'applyAuthResult: email=old@example.com\nOAuth: authenticated successfully as new@example.com\napplyAuthResult: email=last@example.com, ignored\n',
  )
  assert.equal(readLoggedEmail([primary, fallback]), 'last@example.com')
  assert.equal(readLoggedEmail([fallback, primary]), 'fallback@example.com')
  assert.equal(readLoggedEmail([missing]), undefined)
})

test('quota discovers account once in parallel and status only reads local data', async (t) => {
  const home = isolateHome(t)
  const runtime = new AntigravityRuntime({
    config: { ...defaults, home: '' },
    spawnAcp() {
      throw new Error('Unexpected ACP startup')
    },
    runCommand() {
      throw new Error('Unexpected command')
    },
    log: { info() {}, warn() {} },
    onModelsChanged() {},
  })
  t.after(() => runtime.dispose())
  const quota = Promise.withResolvers()
  const discovery = Promise.withResolvers()
  const read = t.mock.method(runtime.quota, 'read', () => quota.promise)
  const warmup = t.mock.method(runtime, 'warmup', async () => {
    await discovery.promise
    runtime.catalog.observe(undefined, undefined, {
      name: 'Google AI Ultra',
      id: 'ultra',
    })
  })
  assert.equal(runtime.status().account, undefined)
  assert.equal(warmup.mock.callCount(), 0)
  writeFileSync(
    join(home, 'acp.log'),
    'applyAuthResult: email=user@example.com\n',
  )
  const first = runtime.readQuota(true)
  const second = runtime.readQuota()
  assert.equal(read.mock.callCount(), 2)
  assert.deepEqual(
    read.mock.calls.map((c) => c.arguments),
    [[true], [false]],
  )
  assert.equal(warmup.mock.callCount(), 1)
  quota.resolve(quotaSnapshot([0.75]))
  discovery.resolve()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a.account, {
    email: 'user@example.com',
    plan: 'Google AI Ultra',
    tierId: 'ultra',
  })
  assert.deepEqual(a.account, b.account)
  assert.deepEqual(runtime.status().account, a.account)
  writeFileSync(
    join(home, 'acp.log'),
    'OAuth: authenticated successfully as next@example.com\n',
  )
  assert.equal((await runtime.readQuota()).account.email, 'next@example.com')
  assert.equal(warmup.mock.callCount(), 1)
  const cache = JSON.parse(readFileSync(join(home, 'catalog.json'), 'utf8'))
  assert.equal(JSON.stringify(cache).includes('@'), false)
  const cached = new AntigravityRuntime(runtime.host)
  t.after(() => cached.dispose())
  t.mock.method(cached.quota, 'read', async () => quotaSnapshot([]))
  t.mock.method(cached, 'warmup', () => {
    throw new Error('Cached tier must skip discovery')
  })
  assert.equal((await cached.readQuota()).account.plan, 'Google AI Ultra')
  assert.equal(cached.status().state, 'idle')
})

test('failed account discovery leaves quota usable, cleans startup, and attempts only once', async (t) => {
  const home = isolateHome(t)
  let attempts = 0
  const runtime = new AntigravityRuntime({
    config: { ...defaults, home },
    spawnAcp() {
      attempts++
      throw new Error('ACP unavailable')
    },
    runCommand() {
      throw new Error('Unexpected preflight')
    },
    log: { info() {}, warn() {} },
    onModelsChanged() {},
  })
  runtime.preflight = {
    binary: 'fake',
    version: '1.4.12',
    home,
    workspace: home,
    logFile: join(home, 'acp.log'),
  }
  t.after(() => runtime.dispose())
  const close = t.mock.method(runtime.bridge, 'close')
  t.mock.method(runtime.quota, 'read', async () => quotaSnapshot([0.75]))
  assert.equal((await runtime.readQuota()).status, 'ok')
  assert.equal(runtime.status().state, 'idle')
  assert.equal(runtime.status().error, undefined)
  assert.equal(runtime.sweeper, undefined)
  assert.equal(close.mock.callCount(), 1)
  await runtime.readQuota(true)
  assert.equal(attempts, 1)
  await assert.rejects(runtime.warmup(), /ACP unavailable/)
  assert.equal(attempts, 2)
  assert.equal(runtime.status().state, 'error')
})

test('account panels handle both fields, either field, and no fields', () => {
  for (const [account, expected] of [
    [
      { email: 'user@example.com', plan: 'Google AI Ultra' },
      'user@example.com · Google AI Ultra',
    ],
    [{ email: 'user@example.com' }, 'user@example.com'],
    [{ plan: 'Google AI Pro' }, 'Google AI Pro'],
    [{ tierId: 'hidden' }, undefined],
    [undefined, undefined],
  ]) {
    const quota = formatQuota(quotaSnapshot([], { account })).text.split('\n')
    const status = formatStatus({ ...statusSnapshot, account }).text.split('\n')
    if (expected) {
      assert.equal(quota[1], `  Account:  ${expected}`)
      assert.equal(status[3], `  Account:  ${expected}`)
    } else {
      assert.equal(
        quota.some((line) => line.includes('Account:')),
        false,
      )
      assert.equal(
        status.some((line) => line.includes('Account:')),
        false,
      )
    }
  }
})

test('binary discovery skips same-name directories and version error matches minimum', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-binary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bad = join(root, 'bad')
  const good = join(root, 'good')
  mkdirSync(join(bad, 'agy'), { recursive: true })
  mkdirSync(good)
  const binary = join(good, 'agy')
  writeFileSync(binary, '#!/bin/sh\n')
  assert.equal(
    resolveAgyBinary('', {
      platform: 'linux',
      home: root,
      env: { PATH: `${bad}${delimiter}${good}` },
    }),
    binary,
  )
  assert.throws(() => resolveAgyBinary(join(bad, 'agy')), /not found/)
  assert.throws(
    () => assertSupportedAgyVersion('1.4.11', binary),
    /requires >= 1\.4\.12/,
  )
  assert.doesNotThrow(() => assertSupportedAgyVersion('1.4.12', binary))
})

test('quota reads without ACP startup, coalesces requests and preserves command errors', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-quota-'))
  const command = join(root, 'agy')
  writeFileSync(command, '')
  let calls = 0,
    result = {
      code: 0,
      stdout: JSON.stringify({ command: { data: { groups: [] } } }),
      stderr: '',
    }
  const runtime = new AntigravityRuntime({
    config: { ...defaults, command, home: root },
    spawnAcp() {
      throw new Error('quota must not start ACP')
    },
    async runCommand(argv) {
      calls++
      assert.deepEqual(argv, [
        command,
        '-p',
        '/usage',
        '--output-format',
        'json',
      ])
      return result
    },
    log: { info() {}, warn() {} },
    onModelsChanged() {},
  })
  t.after(async () => {
    await runtime.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  const responses = await Promise.all([
    runtime.quota.read(),
    runtime.quota.read(),
  ])
  assert.equal(calls, 1)
  assert.equal(responses[0].status, 'ok')
  assert.equal(runtime.status().state, 'idle')
  assert.equal(runtime.status().home, root)
  assert.equal(runtime.status().binary, undefined)
  assert.equal(
    runtime.status().models.find((m) => m.id === 'gpt-oss-120b-medium')
      .fixedEffort,
    'medium',
  )
  assert.equal(runtime.status().liveSessions, 0)
  result = { code: 7, stdout: '', stderr: ' sign in required ' }
  assert.match(
    (await runtime.quota.read(true)).error,
    /exit 7.*sign in required/,
  )
  result = { code: 8, stdout: 'fallback diagnostic', stderr: '' }
  assert.match((await runtime.quota.read(true)).error, /fallback diagnostic/)
})

test('quota command survives failed optional model discovery', async (t) => {
  isolateHome(t)
  const root = mkdtempSync(join(tmpdir(), 'pi-quota-command-'))
  const command = join(root, 'agy')
  writeFileSync(
    command,
    '#!/bin/sh\ncase "$*" in "-p /usage --output-format json") echo \'{"command":{"data":{"groups":[]}}}\';; *) exit 42;; esac\n',
    { mode: 0o755 },
  )
  const old = process.env.PI_AGY_COMMAND
  process.env.PI_AGY_COMMAND = command
  t.after(() => {
    if (old === undefined) delete process.env.PI_AGY_COMMAND
    else process.env.PI_AGY_COMMAND = old
    rmSync(root, { recursive: true, force: true })
  })
  const handlers = new Map()
  let cmd, notice
  extension({
    registerProvider() {},
    on(name, fn) {
      handlers.set(name, fn)
    },
    registerCommand(_name, definition) {
      cmd = definition
    },
  })
  try {
    await cmd.handler('quota', {
      ui: {
        notify(text, level) {
          notice = { text, level }
        },
      },
    })
    assert.equal(notice.level, 'info')
    assert.match(notice.text, /Antigravity Quota[\s\S]*No quota data available/)
  } finally {
    await handlers.get('session_shutdown')()
  }
})

test('all fallback and server-advertised models remain visible, including cached models', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-catalog-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'catalog.json')
  const catalog = new ModelCatalog(path)
  assert.equal(catalog.list().length, 5)
  catalog.observe([
    {
      id: 'model',
      options: FALLBACK_MODELS.map((m) => ({ value: m.id, name: m.name })),
    },
  ])
  assert.deepEqual(
    new ModelCatalog(path).list().map((m) => m.id),
    FALLBACK_MODELS.map((m) => m.id),
  )
})

test('provider registration is lazy, refresh respects context, and catalog changes republish models', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-registration-'))
  const oldHome = process.env.PI_AGY_HOME
  process.env.PI_AGY_HOME = root
  t.after(() => {
    if (oldHome === undefined) delete process.env.PI_AGY_HOME
    else process.env.PI_AGY_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  })
  const timer = t.mock.method(globalThis, 'setInterval', () => {
    throw new Error('factory must not start timers')
  })
  let warmups = 0,
    runtime
  t.mock.method(AntigravityRuntime.prototype, 'warmup', async function () {
    warmups++
    runtime = this
    if (
      this.catalog.observe([
        { id: 'model', options: [{ value: 'gemini-test', name: 'Test' }] },
        { id: 'thought_level', options: [{ value: 'low' }, { value: 'high' }] },
      ])
    )
      this.host.onModelsChanged()
  })
  const registrations = [],
    offlineRefreshes = [],
    handlers = new Map()
  let command
  extension({
    registerProvider(_name, provider) {
      registrations.push(provider)
      // Pi restores local catalogs immediately after each registration.
      offlineRefreshes.push(
        provider.refreshModels({
          allowNetwork: false,
          signal: new AbortController().signal,
        }),
      )
    },
    on(name, handler) {
      handlers.set(name, handler)
    },
    registerCommand(_name, definition) {
      command = definition
    },
  })
  try {
    await Promise.all(offlineRefreshes)
    assert.equal(warmups, 0)
    const provider = registrations[0]
    assert.deepEqual(
      provider.models.find((m) => m.id === 'gemini-4-argon').thinkingLevelMap,
      {
        off: null,
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: null,
        max: null,
      },
    )
    assert.equal(
      provider.models.find((m) => m.id === 'gpt-oss-120b-medium')
        .thinkingLevelMap,
      undefined,
    )
    await provider.refreshModels({
      allowNetwork: true,
      signal: AbortSignal.abort(),
    })
    assert.equal(warmups, 0)
    const refreshed = await provider.refreshModels({
      allowNetwork: true,
      signal: new AbortController().signal,
    })
    await Promise.all(offlineRefreshes)
    assert.equal(warmups, 1)
    assert.equal(registrations.length, 1)
    assert.equal(refreshed[0].thinkingLevelMap.medium, null)
    assert.equal(
      runtime.catalog.observe([
        { id: 'thought_level', options: [{ value: 'high' }] },
      ]),
      true,
    )
    runtime.host.onModelsChanged()
    assert.equal(registrations.at(-1).models[0].thinkingLevelMap.low, null)
    assert.equal(registrations.length, 2)
    await provider.refreshModels()
    assert.equal(warmups, 2)
    assert.equal(handlers.has('session_before_switch'), false)
    assert.equal(handlers.has('session_before_fork'), false)
    const disposed = t.mock.method(
      AntigravityRuntime.prototype,
      'dispose',
      async () => {},
    )
    const lightReset = t.mock.method(
      runtime,
      'resetConversations',
      async () => {},
    )
    await handlers.get('session_tree')()
    await handlers.get('session_compact')()
    await handlers.get('session_shutdown')()
    assert.equal(disposed.mock.callCount(), 1)
    assert.equal(lightReset.mock.callCount(), 2)
    assert.deepEqual(
      command.getArgumentCompletions(''),
      ['status', 'quota', 'quota used', 'quota remaining', 'reset'].map(
        (value) => ({ value, label: value }),
      ),
    )
    assert.deepEqual(
      command.getArgumentCompletions(' q'),
      ['quota', 'quota used', 'quota remaining'].map((value) => ({
        value,
        label: value,
      })),
    )
    assert.equal(command.getArgumentCompletions('missing'), null)
  } finally {
    timer.mock.restore()
    await handlers.get('session_shutdown')()
  }
})

const quotaNow = Date.parse('2026-11-08T00:00:00Z')
const quotaSnapshot = (fractions, extra = {}) => ({
  status: 'ok',
  updatedAt: new Date(quotaNow).toISOString(),
  groups: [
    {
      name: 'Gemini Models',
      description: 'Models within this group: Gemini Flash, Gemini Pro',
      buckets: fractions.map((remainingFraction, i) => ({
        id: String(i),
        name: 'Five hours',
        window: '5h',
        remainingFraction,
        resetTime: '',
      })),
    },
  ],
  ...extra,
})

test('quota panel renders aligned bars, rounded percentages and relative reset times', () => {
  const snapshot = quotaSnapshot([1, 0.9091849327087402, 0.75, undefined])
  const buckets = snapshot.groups[0].buckets
  buckets[0].resetTime = new Date(
    quotaNow + (4 * 60 + 59) * 60000,
  ).toISOString()
  buckets[1].window = 'weekly'
  buckets[1].resetTime = new Date(
    quotaNow + (6 * 24 + 7) * 3600000,
  ).toISOString()
  buckets[2].resetTime = new Date(quotaNow + 45 * 60000).toISOString()
  buckets[3].window = ''
  const notice = formatQuota(snapshot, quotaNow)
  assert.equal(notice.level, 'info')
  assert.match(notice.text, /Gemini Models\n    Gemini Flash, Gemini Pro/)
  assert.match(notice.text, /5h\s+\[░░░░░░░░░░░░\]   0% · resets in 4h 59m/)
  assert.match(notice.text, /weekly\s+\[█░░░░░░░░░░░\]   9% · resets in 6d 7h/)
  assert.match(notice.text, /\[███░░░░░░░░░\]  25% · resets in 45m/)
  assert.match(notice.text, /Five hours\s+\[░░░░░░░░░░░░\]  n\/a/)

  const remainingNotice = formatQuota(snapshot, quotaNow, 'remaining')
  assert.equal(remainingNotice.level, 'info')
  assert.match(
    remainingNotice.text,
    /5h\s+\[████████████\] 100% · resets in 4h 59m/,
  )
  assert.match(
    remainingNotice.text,
    /weekly\s+\[███████████░\]  91% · resets in 6d 7h/,
  )
  assert.match(remainingNotice.text, /\[█████████░░░\]  75% · resets in 45m/)
})

test('quota severity uses exact thresholds and keeps errors above later healthy windows', () => {
  for (const [fraction, expected] of [
    [1, 'info'],
    [0.20001, 'info'],
    [0.2, 'warning'],
    [0.05001, 'warning'],
    [0.05, 'error'],
    [0, 'error'],
    [-1, 'error'],
    [2, 'info'],
    [undefined, 'info'],
    [NaN, 'info'],
  ]) {
    assert.equal(
      formatQuota(quotaSnapshot([fraction, 1]), quotaNow).level,
      expected,
      `fraction=${fraction}`,
    )
  }
  const stale = formatQuota(
    quotaSnapshot([1], { status: 'error', error: 'Sign in required' }),
    quotaNow,
  )
  assert.equal(stale.level, 'error')
  assert.match(stale.text, /Antigravity Quota \(stale\)/)
  assert.match(stale.text, /✖ Error: Sign in required/)
  assert.match(stale.text, /0%/)
  const empty = formatQuota(quotaSnapshot([], { groups: [] }), quotaNow)
  assert.match(empty.text, /No quota data available\./)
  assert.equal(empty.level, 'info')
  const error = formatQuota(
    quotaSnapshot([], { status: 'error', groups: [], error: 'Offline' }),
    quotaNow,
  )
  assert.equal(error.level, 'error')
  assert.match(error.text, /✖ Error: Offline/)
  assert.doesNotMatch(error.text, /stale/)
})

test('quota reset formatting handles expired, imminent and malformed times', () => {
  for (const [resetTime, expected] of [
    [new Date(quotaNow - 1).toISOString(), 'resetting soon'],
    [new Date(quotaNow).toISOString(), 'resetting soon'],
    [new Date(quotaNow + 30000).toISOString(), 'resets in <1m'],
    ['invalid', 'reset time unavailable'],
  ]) {
    const snapshot = quotaSnapshot([0.5])
    snapshot.groups[0].buckets[0].resetTime = resetTime
    assert.ok(formatQuota(snapshot, quotaNow).text.includes(expected))
  }
  const parsed = parseUsage(
    JSON.stringify({
      command: {
        data: {
          groups: [{ name: 'Unknown', buckets: [{ window: 'weekly' }] }],
        },
      },
    }),
  )
  assert.equal(parsed[0].buckets[0].remainingFraction, undefined)
  assert.match(
    formatQuota({ status: 'ok', groups: parsed }, quotaNow).text,
    /n\/a/,
  )
  assert.match(
    formatQuota(quotaSnapshot([-1, 2]), quotaNow).text,
    /\[████████████\] 100%/,
  )
  assert.match(
    formatQuota(quotaSnapshot([2]), quotaNow).text,
    /\[░░░░░░░░░░░░\]   0%/,
  )
})

const statusSnapshot = {
  state: 'idle',
  home: '/tmp/pi-home',
  contextWindow: 256000,
  defaultEffort: 'high',
  efforts: ['low', 'medium', 'high'],
  liveSessions: 0,
  activeTurns: 0,
  models: [
    { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['low', 'high'] },
    {
      id: 'gpt-oss-120b-medium',
      name: 'GPT-OSS',
      efforts: [],
      fixedEffort: 'medium',
    },
  ],
}

test('status panel distinguishes lazy startup, live resources, model efforts and last turn', () => {
  const idle = formatStatus(statusSnapshot)
  assert.equal(idle.level, 'info')
  assert.match(idle.text, /○ idle \(lazy — starts on first turn\)/)
  assert.match(idle.text, /Binary:\s+not probed yet/)
  assert.match(idle.text, /Home:\s+\/tmp\/pi-home/)
  assert.match(idle.text, /gemini-4-argon \(Gemini 4 Argon\) — \[low, high\]/)
  assert.match(idle.text, /\[medium\] \(fixed\)/)
  const lastTurn = {
    model: 'gemini-4-argon',
    effort: 'high',
    outcome: 'completed',
    durationMs: 1234,
    retryNotices: 2,
  }
  const ready = formatStatus({
    ...statusSnapshot,
    state: 'ready',
    binary: '/bin/agy',
    version: 'Antigravity 1.5.3',
    liveSessions: 2,
    activeTurns: 1,
    lastTurn,
  })
  assert.match(ready.text, /● ready/)
  assert.match(ready.text, /Antigravity 1.5.3 \(\/bin\/agy\)/)
  assert.match(ready.text, /2 live · 1 active turn/)
  assert.match(
    ready.text,
    /250K tokens · default effort: high \(low, medium, high\)/,
  )
  assert.match(ready.text, /completed · 1\.2s · 2 retries/)
  assert.equal(
    formatStatus({
      ...statusSnapshot,
      lastTurn: { ...lastTurn, outcome: 'error' },
    }).level,
    'warning',
  )
  assert.equal(
    formatStatus({ ...statusSnapshot, state: 'error', error: 'Process exited' })
      .level,
    'error',
  )
  assert.match(
    formatStatus({ ...statusSnapshot, state: 'error', error: 'Process exited' })
      .text,
    /✖ Error: Process exited/,
  )
  assert.match(
    formatStatus({ ...statusSnapshot, state: 'starting' }).text,
    /◐ starting/,
  )
  const aborted = formatStatus({
    ...statusSnapshot,
    lastTurn: {
      ...lastTurn,
      outcome: 'aborted',
      durationMs: 450,
      retryNotices: 0,
    },
  })
  assert.match(aborted.text, /aborted · 450ms/)
  assert.doesNotMatch(aborted.text, /retries/)
})

test('commands route formatted notices and reject unknown arguments without querying quota', async (t) => {
  isolateHome(t)
  t.mock.method(AntigravityRuntime.prototype, 'warmup', async () => {})
  const handlers = new Map()
  let command,
    notice,
    snapshot = quotaSnapshot([0.2])
  t.mock.method(AntigravityRuntime.prototype, 'status', () => statusSnapshot)
  const read = t.mock.method(
    QuotaReader.prototype,
    'read',
    async () => snapshot,
  )
  extension({
    registerProvider() {},
    on(name, handler) {
      handlers.set(name, handler)
    },
    registerCommand(_name, definition) {
      command = definition
    },
  })
  const ctx = {
    ui: {
      notify(text, level) {
        notice = { text, level }
      },
    },
  }
  try {
    await command.handler('', ctx)
    const implicit = notice
    await command.handler('status', ctx)
    assert.deepEqual(notice, implicit)
    assert.match(notice.text, /Antigravity ACP · ○ idle/)
    assert.equal(notice.level, 'info')
    await command.handler('unknown', ctx)
    assert.deepEqual(notice, {
      text: 'Usage: /agy-acp [status|quota [used|remaining]|reset]',
      level: 'warning',
    })
    assert.equal(read.mock.callCount(), 0)
    await command.handler('quota', ctx)
    assert.match(notice.text, /80%/)
    assert.equal(notice.level, 'warning')
    snapshot = quotaSnapshot([0.05])
    await command.handler('quota', ctx)
    assert.equal(notice.level, 'error')
    snapshot = quotaSnapshot([], {
      status: 'error',
      groups: [],
      error: 'Not logged in',
    })
    await command.handler('quota', ctx)
    assert.match(notice.text, /Not logged in/)
    assert.equal(notice.level, 'error')
    t.mock.method(AntigravityRuntime.prototype, 'status', () => ({
      ...statusSnapshot,
      state: 'error',
      error: 'ACP unavailable',
    }))
    await command.handler('status', ctx)
    assert.equal(notice.level, 'error')
    await command.handler('reset', ctx)
    assert.deepEqual(notice, {
      text: 'Antigravity ACP sessions reset',
      level: 'info',
    })
  } finally {
    await handlers.get('session_shutdown')()
  }
})

test('TUI quota loader closes on completion or Escape and suppresses late results', async (t) => {
  isolateHome(t)
  t.mock.method(AntigravityRuntime.prototype, 'warmup', async () => {})
  const { BorderedLoader, initTheme } =
    await import('@earendil-works/pi-coding-agent')
  initTheme('dark', false)
  for (const scenario of [
    'success',
    'error',
    'cancel-success',
    'cancel-error',
  ]) {
    await t.test(scenario, async (t) => {
      const query = Promise.withResolvers()
      const read = t.mock.method(
        QuotaReader.prototype,
        'read',
        () => query.promise,
      )
      const handlers = new Map()
      let command,
        loader,
        customCalls = 0,
        completions = 0,
        renders = 0
      const notices = []
      extension({
        registerProvider() {},
        on(name, handler) {
          handlers.set(name, handler)
        },
        registerCommand(_name, definition) {
          command = definition
        },
      })
      t.after(async () => {
        loader?.dispose()
        await handlers.get('session_shutdown')()
      })
      const ctx = {
        mode: 'tui',
        ui: {
          notify(text, level) {
            notices.push({ text, level })
          },
          custom(factory) {
            customCalls++
            return new Promise((resolve) => {
              loader = factory(
                {
                  requestRender() {
                    renders++
                  },
                },
                {
                  fg(_color, text) {
                    return text
                  },
                },
                undefined,
                (value) => {
                  completions++
                  // Pi owns component disposal when custom UI completes.
                  loader.dispose()
                  resolve(value)
                },
              )
            })
          },
        },
      }
      const pending = command.handler('quota', ctx)
      assert.equal(customCalls, 1)
      assert.ok(loader instanceof BorderedLoader)
      assert.ok(renders > 0)
      assert.match(
        loader.render(80).join('\n'),
        /Fetching Antigravity quota\.\.\./,
      )
      assert.equal(read.mock.callCount(), 1)
      assert.deepEqual(read.mock.calls[0].arguments, [true])
      assert.equal(notices.length, 0)
      const dispose = t.mock.method(loader, 'dispose')
      const snapshot = scenario.endsWith('error')
        ? quotaSnapshot([], {
            status: 'error',
            groups: [],
            error: 'Network unavailable',
          })
        : quotaSnapshot([0.75])
      if (scenario.startsWith('cancel')) {
        loader.handleInput('\x1b')
        assert.equal(loader.signal.aborted, true)
        await pending
        assert.deepEqual(notices, [
          { text: 'Quota check cancelled', level: 'info' },
        ])
        assert.equal(dispose.mock.callCount(), 1)
        query.resolve(snapshot)
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(notices.length, 1)
      } else {
        query.resolve(snapshot)
        await pending
        assert.equal(notices.length, 1)
        assert.match(notices[0].text, /Antigravity Quota/)
        assert.equal(notices[0].level, scenario === 'error' ? 'error' : 'info')
        if (scenario === 'error')
          assert.match(notices[0].text, /Network unavailable/)
        else assert.match(notices[0].text, /25%/)
      }
      assert.equal(completions, 1)
      assert.equal(dispose.mock.callCount(), 1)
    })
  }
})

test('quota queries directly outside TUI or when custom UI is unavailable', async (t) => {
  isolateHome(t)
  t.mock.method(AntigravityRuntime.prototype, 'warmup', async () => {})
  t.mock.method(QuotaReader.prototype, 'read', async () =>
    quotaSnapshot([0.75]),
  )
  const handlers = new Map()
  let command
  extension({
    registerProvider() {},
    on(name, handler) {
      handlers.set(name, handler)
    },
    registerCommand(_name, definition) {
      command = definition
    },
  })
  t.after(async () => handlers.get('session_shutdown')())
  for (const mode of ['rpc', 'print', 'tui']) {
    let notice
    const ui = {
      notify(text, level) {
        notice = { text, level }
      },
    }
    if (mode !== 'tui')
      ui.custom = () => {
        throw new Error('Only TUI may show the loader')
      }
    await command.handler('quota', { mode, ui })
    assert.equal(notice.level, 'info')
    assert.match(notice.text, /25%/)
  }
})

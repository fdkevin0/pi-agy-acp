import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  symlinkSync,
  utimesSync,
  chmodSync,
  statSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  resolveAgyBinary,
  assertSupportedAgyVersion,
  binaryFingerprint,
  defaultAgyHomes,
  prepareHome,
  syncOAuthToken,
  removeSessionArtifacts,
  extractContextWindowMetadata,
  readSessionContextMetadata,
  readSessionNextMetadataIndex,
} from '../src/preflight.ts'
import { defaults } from '../src/config.ts'
import { AntigravityRuntime } from '../src/runtime.ts'
import {
  ModelCatalog,
  flattenConfigOptions,
  nearestEffort,
} from '../src/catalog.ts'
import extension from '../index.ts'
import { formatQuota, formatStatus } from '../src/format.ts'
import { runCommand, spawnAcp } from '../src/host.ts'
import { parseUsage, QuotaReader, readLoggedEmail } from '../src/quota.ts'

function restoreEnv(key, value) {
  delete process.env[key]
  Object.assign(
    process.env,
    ...[value].filter((v) => v !== undefined).map((v) => ({ [key]: v })),
  )
}

function isolateHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-account-'))
  const previous = process.env.PI_AGY_HOME
  const prevDisplay = process.env.PI_AGY_QUOTA_DISPLAY
  const prevCliHome = process.env.ANTIGRAVITY_CLI_HOME
  const prevAgyHome = process.env.AGY_HOME
  process.env.PI_AGY_HOME = root
  delete process.env.PI_AGY_QUOTA_DISPLAY
  delete process.env.ANTIGRAVITY_CLI_HOME
  delete process.env.AGY_HOME
  t.after(() => {
    restoreEnv('PI_AGY_HOME', previous)
    restoreEnv('PI_AGY_QUOTA_DISPLAY', prevDisplay)
    restoreEnv('ANTIGRAVITY_CLI_HOME', prevCliHome)
    restoreEnv('AGY_HOME', prevAgyHome)
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

test('login logs scan tail 64 KiB first, fall back to head 64 KiB, and ignore buried middle lines', (t) => {
  const root = isolateHome(t)
  const primary = join(root, 'acp.log')
  const fallback = join(root, 'cli.log')
  const buried = join(root, 'buried.log')
  const missing = join(root, 'missing')
  writeFileSync(
    primary,
    'applyAuthResult: email=head@example.com, token omitted\n' +
      'x'.repeat(70_000),
  )
  writeFileSync(
    buried,
    'x'.repeat(70_000) +
      '\napplyAuthResult: email=middle@example.com\n' +
      'y'.repeat(70_000),
  )
  writeFileSync(
    fallback,
    'OAuth: authenticated successfully as fallback@example.com\n',
  )
  assert.equal(readLoggedEmail([primary]), 'head@example.com')
  assert.equal(readLoggedEmail([buried]), undefined)
  assert.equal(
    readLoggedEmail([missing, buried, fallback]),
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
    version: '1.5.10',
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
  chmodSync(binary, 0o755)
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
    () => assertSupportedAgyVersion('1.5.9', binary),
    /requires >= 1\.5\.10/,
  )
  assert.doesNotThrow(() => assertSupportedAgyVersion('1.5.10', binary))
})

test('quota reads without ACP startup, coalesces requests and preserves command errors', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-quota-'))
  const command = join(root, 'agy')
  writeFileSync(command, '')
  chmodSync(command, 0o755)
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
  assert.deepEqual(runtime.status().models, [])
  assert.deepEqual(runtime.status().efforts, [])
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

test('catalog starts empty without hardcoded models and persists server-advertised models and image capability', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-catalog-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'catalog.json')
  const catalog = new ModelCatalog(path)
  assert.deepEqual(catalog.list(), [])
  assert.deepEqual(catalog.effortList(), [])
  assert.deepEqual(catalog.inputModalities(), ['text', 'image'])
  const advertised = [
    { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
    { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ]
  catalog.observe(
    [
      {
        id: 'model',
        options: advertised.map((m) => ({ value: m.id, name: m.name })),
      },
    ],
    [
      { modelId: 'gemini-4-neon-low' },
      { modelId: 'gemini-4-neon-xhigh' },
      { modelId: 'gemini-pro-orchestrator-neon' },
      { modelId: 'gpt-oss-120b-medium' },
    ],
  )
  assert.equal(catalog.observeImageSupport(false), true)
  const reloaded = new ModelCatalog(path)
  assert.deepEqual(
    reloaded.list().map((m) => m.id),
    advertised.map((m) => m.id),
  )
  assert.deepEqual(reloaded.effortList(), ['low', 'xhigh'])
  assert.deepEqual(reloaded.effortsFor('gemini-pro-orchestrator-neon'), [])
  assert.equal(
    reloaded.supportsEffortSelection('gemini-pro-orchestrator-neon'),
    false,
  )
  assert.equal(reloaded.supportsEffortSelection('gpt-oss-120b-medium'), false)
  assert.equal(reloaded.supportsEffortSelection('gemini-4-neon'), true)
  assert.deepEqual(reloaded.inputModalities(), ['text'])
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
    assert.deepEqual(provider.models, [])
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
    assert.deepEqual(refreshed[0].thinkingLevelMap, {
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: null,
    })
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
    quotaNow + (4 * 60 + 30) * 60000,
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
  assert.match(notice.text, /5h\s+\[░░░░░░░░░░░░\]   0% · resets in 4h 30m/)
  assert.match(notice.text, /weekly\s+\[█░░░░░░░░░░░\]   9% · resets in 6d 7h/)
  assert.match(notice.text, /\[███░░░░░░░░░\]  25% · resets in 45m/)
  assert.match(notice.text, /Five hours\s+\[░░░░░░░░░░░░\]  n\/a/)

  const remainingNotice = formatQuota(snapshot, quotaNow, 'remaining')
  assert.equal(remainingNotice.level, 'info')
  assert.match(
    remainingNotice.text,
    /5h\s+\[████████████\] 100% · resets in 4h 30m/,
  )
  assert.match(
    remainingNotice.text,
    /weekly\s+\[███████████░\]  91% · resets in 6d 7h/,
  )
  assert.match(remainingNotice.text, /\[█████████░░░\]  75% · resets in 45m/)
})

test('quota panel suppresses untouched full-window rolling reset countdowns within 60s tolerance', () => {
  const mk = (window, remainingFraction, offsetSec) => ({
    status: 'ok',
    updatedAt: new Date(quotaNow).toISOString(),
    groups: [
      {
        name: 'Gemini Models',
        description: '',
        buckets: [
          {
            id: 'b',
            name: window,
            window,
            remainingFraction,
            resetTime: new Date(quotaNow + offsetSec * 1000).toISOString(),
          },
        ],
      },
    ],
  })

  // Untouched 100% rolling windows within ±60s omit the redundant reset suffix.
  assert.match(
    formatQuota(mk('5h', 1, 5 * 3600), quotaNow).text,
    /5h\s+\[░░░░░░░░░░░░\]   0%$/,
  )
  assert.match(
    formatQuota(mk('5h', 1, 5 * 3600 - 60), quotaNow).text,
    /5h\s+\[░░░░░░░░░░░░\]   0%$/,
  )
  assert.match(
    formatQuota(mk('5h', 1, 5 * 3600 + 60), quotaNow).text,
    /5h\s+\[░░░░░░░░░░░░\]   0%$/,
  )
  assert.match(
    formatQuota(mk('5h', 1, 5 * 3600), quotaNow, 'remaining').text,
    /5h\s+\[████████████\] 100%$/,
  )
  assert.match(
    formatQuota(mk('weekly', 1, 7 * 86400 - 60), quotaNow).text,
    /weekly\s+\[░░░░░░░░░░░░\]   0%$/,
  )
  assert.match(
    formatQuota(mk('weekly', 1, 7 * 86400 + 60), quotaNow).text,
    /weekly\s+\[░░░░░░░░░░░░\]   0%$/,
  )
  assert.match(
    formatQuota(mk('daily', 1, 86400), quotaNow).text,
    /daily\s+\[░░░░░░░░░░░░\]   0%$/,
  )

  // Outside the ±60s tolerance or below 100% remaining keeps the countdown.
  assert.match(
    formatQuota(mk('5h', 1, 5 * 3600 - 61), quotaNow).text,
    /5h\s+\[░░░░░░░░░░░░\]   0% · resets in 4h 58m$/,
  )
  assert.match(
    formatQuota(mk('5h', 1, 5 * 3600 + 61), quotaNow).text,
    /5h\s+\[░░░░░░░░░░░░\]   0% · resets in 5h 1m$/,
  )
  assert.match(
    formatQuota(mk('weekly', 1, 7 * 86400 - 61), quotaNow).text,
    /weekly\s+\[░░░░░░░░░░░░\]   0% · resets in 6d 23h$/,
  )
  assert.match(
    formatQuota(mk('5h', 0.99, 5 * 3600), quotaNow).text,
    /5h\s+\[░░░░░░░░░░░░\]   1% · resets in 5h 0m$/,
  )
  assert.match(
    formatQuota(mk('5h', 0.999, 5 * 3600), quotaNow).text,
    /5h\s+\[░░░░░░░░░░░░\]   0% · resets in 5h 0m$/,
  )
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
          groups: [
            {
              name: 'Unknown',
              buckets: [{ id: 'unknown-weekly', window: 'weekly' }],
            },
          ],
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

test('parseUsage filters disabled, empty-key, and non-object buckets while preserving valid ones', () => {
  const parsed = parseUsage(
    JSON.stringify({
      command: {
        data: {
          groups: [
            {
              name: 'Gemini Models',
              description: 'Models within this group: Gemini 4 Argon',
              buckets: [
                null,
                'not-an-object',
                42,
                true,
                ['array-entry'],
                {
                  id: 'disabled-5h',
                  window: '5h',
                  disabled: true,
                  remaining_fraction: 0,
                  reset_time: '2026-11-08T05:00:00Z',
                },
                { id: '', window: '5h', remaining_fraction: 0.5 },
                { id: '   ', window: '5h', remaining_fraction: 0.5 },
                { window: '5h', remaining_fraction: 0.5 },
                { id: 'empty-window', window: '', remaining_fraction: 0.5 },
                { id: 'space-window', window: ' \t ', remaining_fraction: 0.5 },
                { id: 'missing-window', remaining_fraction: 0.5 },
                {
                  id: 'active-5h',
                  name: 'Five hours',
                  window: '5h',
                  disabled: false,
                  remaining_fraction: 0.75,
                  reset_time: '2026-11-08T05:00:00Z',
                },
                {
                  id: ' trimmed-weekly ',
                  name: 'Weekly',
                  window: ' weekly ',
                  remaining_fraction: 'not-a-number',
                  reset_time: '2026-11-15T00:00:00Z',
                },
              ],
            },
          ],
        },
      },
    }),
  )
  assert.deepEqual(parsed[0].buckets, [
    {
      id: 'active-5h',
      name: 'Five hours',
      window: '5h',
      remainingFraction: 0.75,
      resetTime: '2026-11-08T05:00:00Z',
    },
    {
      id: 'trimmed-weekly',
      name: 'Weekly',
      window: 'weekly',
      remainingFraction: undefined,
      resetTime: '2026-11-15T00:00:00Z',
    },
  ])
})

test('QuotaReader uses monotonic clock seam with -Infinity initial timestamp and no premature expiry', async () => {
  let clock = 0
  let calls = 0
  const okRunner = async () => {
    calls++
    return {
      code: 0,
      stderr: '',
      stdout: JSON.stringify({ command: { data: { groups: [] } } }),
    }
  }
  const startupReader = new QuotaReader(
    () => 'fake',
    okRunner,
    100,
    () => clock,
  )
  // Even when the monotonic clock starts at 0, an empty cache must not look fresh.
  assert.equal(startupReader.peek(), undefined)
  assert.equal((await startupReader.read()).status, 'ok')
  assert.equal(calls, 1)

  clock = 99
  assert.equal(startupReader.peek().status, 'ok')
  await startupReader.read()
  assert.equal(calls, 1)

  clock = 100
  assert.equal(startupReader.peek(), undefined)
  await startupReader.read()
  assert.equal(calls, 2)

  // Negative monotonic clock readings still behave deterministically.
  let negativeClock = -500
  let negativeCalls = 0
  const negativeReader = new QuotaReader(
    () => 'fake',
    async () => {
      negativeCalls++
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ command: { data: { groups: [] } } }),
      }
    },
    100,
    () => negativeClock,
  )
  assert.equal(negativeReader.peek(), undefined)
  await negativeReader.read()
  assert.equal(negativeCalls, 1)

  negativeClock = -401
  assert.equal(negativeReader.peek().status, 'ok')
  await negativeReader.read()
  assert.equal(negativeCalls, 1)

  negativeClock = -400
  assert.equal(negativeReader.peek(), undefined)
  await negativeReader.read()
  assert.equal(negativeCalls, 2)
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
  const unprobed = formatStatus({
    ...statusSnapshot,
    contextWindow: undefined,
    models: [
      {
        id: 'gemini-4-argon',
        name: 'Gemini 4 Argon',
        efforts: ['low', 'high'],
        contextWindow: 512_000,
      },
    ],
  })
  assert.match(
    unprobed.text,
    /Context:\s+dynamic \(unprobed\) · default effort: high/,
  )
  assert.match(
    unprobed.text,
    /gemini-4-argon \(Gemini 4 Argon\) — \[low, high\] · 500K/,
  )
  const cold = formatStatus({
    ...statusSnapshot,
    contextWindow: undefined,
    efforts: [],
    models: [],
  })
  assert.match(cold.text, /default effort: high\n  Models:\n    No models available\./)
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

function pbField(tagByte, payload) {
  return Uint8Array.from([tagByte, payload.length, ...payload])
}

function genMetadataBlob(varintBytes) {
  const ctxWindow = Uint8Array.from([0x20, ...varintBytes])
  return pbField(0x0a, pbField(0x4a, pbField(0x52, ctxWindow)))
}

test('extractContextWindowMetadata decodes GeneratorMetadata protobuf blobs and ignores unknown or malformed fields', () => {
  const blob512k = genMetadataBlob([0x80, 0xa0, 0x1f])
  assert.deepEqual(extractContextWindowMetadata(blob512k), {
    maxContextTokens: 512_000,
  })

  const blob128k = genMetadataBlob([0x80, 0x80, 0x08])
  assert.deepEqual(extractContextWindowMetadata(blob128k), {
    maxContextTokens: 131_072,
  })

  // Unknown fields across wire types 0, 1, 2, 5 before match + empty trailing field 1 after match.
  const padded = Uint8Array.from([
    0x10, 0x01,
    0x19, 1, 2, 3, 4, 5, 6, 7, 8,
    0x22, 0x02, 0xaa, 0xbb,
    0x2d, 1, 2, 3, 4,
    ...blob512k,
    0x0a, 0x02, 0x10, 0x00,
  ])
  assert.deepEqual(extractContextWindowMetadata(padded), {
    maxContextTokens: 512_000,
  })

  // Last-wins across repeated field 4 entries.
  const repeated = pbField(
    0x0a,
    pbField(0x4a, pbField(0x52, Uint8Array.from([0x20, 0x80, 0xa0, 0x1f, 0x20, 0x80, 0x80, 0x08]))),
  )
  assert.deepEqual(extractContextWindowMetadata(repeated), {
    maxContextTokens: 131_072,
  })

  assert.equal(extractContextWindowMetadata(new Uint8Array(0)), undefined)
  assert.equal(extractContextWindowMetadata(genMetadataBlob([0x00])), undefined)
  assert.equal(
    extractContextWindowMetadata(
      genMetadataBlob([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]),
    ),
    undefined,
  )
  assert.equal(extractContextWindowMetadata(Uint8Array.from([0x0a, 0x10, 0x4a])), undefined)
  assert.equal(extractContextWindowMetadata(Uint8Array.from([0x0b, 0x01])), undefined)
  assert.equal(extractContextWindowMetadata(null), undefined)
})

test('readSessionContextMetadata reads WAL SQLite metadata safely and rejects symlinks or invalid session ids', (t) => {
  const home = isolateHome(t)
  const convDir = join(home, 'agy', 'conversations')
  mkdirSync(convDir, { recursive: true })
  const dbPath = join(convDir, 'sess-1.db')
  const db = new DatabaseSync(dbPath)
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0);',
  )
  const insert = db.prepare(
    'INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)',
  )
  const blob512k = genMetadataBlob([0x80, 0xa0, 0x1f])
  const unrelated = Uint8Array.from([0x12, 0x01, 0x00])
  insert.run(1, blob512k, blob512k.length)
  insert.run(2, unrelated, unrelated.length)

  // Skips newer row 2 lacking ContextWindowMetadata and finds row 1 from WAL while writer stays open.
  assert.deepEqual(readSessionContextMetadata(home, 'sess-1'), {
    maxContextTokens: 512_000,
  })

  const blob128k = genMetadataBlob([0x80, 0x80, 0x08])
  insert.run(3, blob128k, blob128k.length)
  assert.deepEqual(readSessionContextMetadata(home, 'sess-1'), {
    maxContextTokens: 131_072,
  })
  assert.deepEqual(readSessionContextMetadata(home, 'sess-1', 0), {
    maxContextTokens: 131_072,
  })
  assert.equal(readSessionContextMetadata(home, 'sess-1', 4), undefined)
  assert.equal(readSessionContextMetadata(home, 'sess-1', -1), undefined)
  assert.equal(readSessionNextMetadataIndex(home, 'sess-1'), 4)
  db.close()

  assert.equal(readSessionContextMetadata(home, 'missing'), undefined)
  assert.equal(readSessionNextMetadataIndex(home, 'missing'), 0)
  assert.equal(readSessionContextMetadata(home, ''), undefined)
  assert.equal(readSessionContextMetadata(home, '.'), undefined)
  assert.equal(readSessionContextMetadata(home, '../outside'), undefined)
  assert.equal(readSessionNextMetadataIndex(home, '../outside'), null)
  assert.equal(readSessionContextMetadata(home, 'a/b'), undefined)

  writeFileSync(join(convDir, 'corrupt.db'), 'not-a-sqlite-file')
  assert.equal(readSessionContextMetadata(home, 'corrupt'), undefined)
  assert.equal(readSessionNextMetadataIndex(home, 'corrupt'), null)

  const outside = join(home, 'outside')
  mkdirSync(outside)
  const outsideDbPath = join(outside, 'ext.db')
  const outsideDb = new DatabaseSync(outsideDbPath)
  outsideDb.exec('CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob);')
  outsideDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, blob512k)
  outsideDb.close()

  symlinkSync(outsideDbPath, join(convDir, 'sym-file.db'))
  assert.equal(readSessionContextMetadata(home, 'sym-file'), undefined)
  assert.equal(readSessionNextMetadataIndex(home, 'sym-file'), null)

  rmSync(convDir, { recursive: true, force: true })
  symlinkSync(outside, convDir, 'junction')
  assert.equal(readSessionContextMetadata(home, 'ext'), undefined)
  assert.equal(readSessionNextMetadataIndex(home, 'ext'), null)
})

test('ModelCatalog persists contextWindows in catalog.json and ignores invalid values', (t) => {
  const root = isolateHome(t)
  const path = join(root, 'catalog.json')
  const catalog = new ModelCatalog(path)
  assert.equal(catalog.contextWindowFor('gemini-4-argon'), undefined)
  assert.equal(catalog.observeContextWindow('', 512_000), false)
  assert.equal(catalog.observeContextWindow('gemini-4-argon', 0), false)
  assert.equal(catalog.observeContextWindow('gemini-4-argon', -1), false)
  assert.equal(catalog.observeContextWindow('gemini-4-argon', 1.5), false)
  assert.equal(catalog.observeContextWindow('gemini-4-argon', Number.NaN), false)
  assert.equal(catalog.observeContextWindow('gemini-4-argon', undefined), false)

  assert.equal(catalog.observeContextWindow('gemini-4-argon', 512_000), true)
  assert.equal(catalog.observeContextWindow('gemini-4-argon', 512_000), false)
  assert.equal(catalog.observeContextWindow('gpt-oss-120b-medium', 131_072), true)
  assert.equal(catalog.contextWindowFor('gemini-4-argon'), 512_000)
  assert.equal(catalog.contextWindowFor('gpt-oss-120b-medium'), 131_072)

  const reloaded = new ModelCatalog(path)
  assert.equal(reloaded.contextWindowFor('gemini-4-argon'), 512_000)
  assert.equal(reloaded.contextWindowFor('gpt-oss-120b-medium'), 131_072)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).contextWindows, {
    'gemini-4-argon': 512_000,
    'gpt-oss-120b-medium': 131_072,
  })
})

test('ModelCatalog flattens grouped configOptions and handles xhigh, max, and -effort suffixes', (t) => {
  const root = isolateHome(t)
  const catalog = new ModelCatalog(join(root, 'catalog.json'))

  assert.deepEqual(
    flattenConfigOptions([
      null,
      {
        group: 'google',
        options: [
          { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
          { value: 'foo-xhigh', name: 'Foo XHigh' },
        ],
      },
      { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      {
        group: 'fixed',
        options: [
          { value: 'bar-max', name: 'Bar Max' },
          { value: 'baz-high-effort', name: 'Baz High' },
        ],
      },
    ]).map((entry) => entry.value),
    ['gemini-4-argon', 'foo-xhigh', 'claude-opus-5-5', 'bar-max', 'baz-high-effort'],
  )

  const changed = catalog.observe(
    [
      {
        id: 'model',
        options: [
          {
            group: 'primary',
            options: [
              { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
              { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
            ],
          },
          { value: 'foo-xhigh', name: 'Foo XHigh' },
          { value: 'bar-max', name: 'Bar Max' },
          { value: 'baz-high-effort', name: 'Baz High' },
        ],
      },
      {
        id: 'thought_level',
        options: [
          {
            group: 'standard',
            options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
          },
          {
            group: 'extended',
            options: [{ value: 'xhigh' }, { value: 'max' }],
          },
        ],
      },
    ],
    [
      { modelId: 'gemini-4-argon-low' },
      { modelId: 'gemini-4-argon-high' },
      { modelId: 'gemini-4-argon-xhigh' },
      { modelId: 'claude-opus-5-5-low-effort' },
      { modelId: 'claude-opus-5-5-high-effort' },
      { modelId: 'claude-opus-5-5-xhigh-effort' },
      { modelId: 'claude-opus-5-5-max-effort' },
      { modelId: 'foo-xhigh' },
      { modelId: 'bar-max' },
      { modelId: 'baz-high-effort' },
    ],
  )
  assert.equal(changed, true)
  assert.deepEqual(catalog.effortList(), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(catalog.effortsFor('gemini-4-argon'), ['low', 'high', 'xhigh'])
  assert.deepEqual(catalog.effortsFor('claude-opus-5-5'), ['low', 'high', 'xhigh', 'max'])
  assert.deepEqual(catalog.effortsFor('foo-xhigh'), [])
  assert.deepEqual(catalog.effortsFor('bar-max'), [])
  assert.deepEqual(catalog.effortsFor('baz-high-effort'), [])
  assert.equal(catalog.fixedEffort('foo-xhigh'), 'xhigh')
  assert.equal(catalog.fixedEffort('bar-max'), 'max')
  assert.equal(catalog.fixedEffort('baz-high-effort'), 'high')
  assert.equal(catalog.fixedEffort('qux-xhigh-effort'), 'xhigh')
  assert.equal(catalog.fixedEffort('gemini-4-argon'), undefined)
  assert.equal(catalog.fixedEffort('-high'), undefined)
  assert.equal(nearestEffort('xhigh', ['low', 'medium', 'high']), 'high')
  assert.equal(nearestEffort('max', ['low', 'medium', 'high']), 'high')
  assert.equal(nearestEffort('xhigh', ['low', 'high', 'xhigh']), 'xhigh')
  assert.equal(nearestEffort('max', ['low', 'high', 'xhigh', 'max']), 'max')
})

test('readLoggedEmail scans directory cli.log and newest 10 rotated logs with containment and dedup', (t) => {
  const root = isolateHome(t)
  const agyDir = join(root, 'agy-home')
  const logDir = join(agyDir, 'log')
  const outsideDir = join(root, 'outside')
  mkdirSync(logDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })

  // 12 rotated logs: only the newest 10 are eligible, so emails in the 2 oldest are ignored.
  const writeLog = (name, content, ts) => {
    const file = join(logDir, name)
    writeFileSync(file, content)
    utimesSync(file, ts, ts)
  }
  writeLog('cli-01.log', 'applyAuthResult: email=too-old-1@example.com\n', 1_700_000_010)
  writeLog('acp-server-02.log', 'applyAuthResult: email=too-old-2@example.com\n', 1_700_000_020)
  writeLog('cli-03.log', 'no auth line\n', 1_700_000_030)
  writeLog('acp-server-04.log', 'no auth line\n', 1_700_000_040)
  writeLog('cli-05.log', 'no auth line\n', 1_700_000_050)
  writeLog('acp-server-06.log', 'no auth line\n', 1_700_000_060)
  writeLog('cli-07.log', 'no auth line\n', 1_700_000_070)
  writeLog('acp-server-08.log', 'no auth line\n', 1_700_000_080)
  writeLog('cli-09.log', 'no auth line\n', 1_700_000_090)
  writeLog('acp-server-10.log', 'no auth line\n', 1_700_000_100)
  writeLog('cli-11.log', 'no auth line\n', 1_700_000_110)
  writeLog('acp-server-12.log', 'no auth line\n', 1_700_000_120)
  assert.equal(readLoggedEmail([agyDir]), undefined)

  // Escaping symlink inside log/ with the newest mtime must be rejected.
  const secretLog = join(outsideDir, 'escaped.log')
  writeFileSync(secretLog, 'applyAuthResult: email=escaped@example.com\n')
  utimesSync(secretLog, 1_700_009_000, 1_700_009_000)
  symlinkSync(secretLog, join(logDir, 'cli-99.log'))
  assert.equal(readLoggedEmail([agyDir]), undefined)

  // Match inside one of the newest 10 rotated logs is found; newer rotated log beats older cli.log.
  const olderCli = join(agyDir, 'cli.log')
  writeFileSync(olderCli, 'applyAuthResult: email=older-cli@example.com\n')
  utimesSync(olderCli, 1_700_000_050, 1_700_000_050)
  const newerAcp = join(logDir, 'acp-server-12.log')
  writeFileSync(
    newerAcp,
    'applyAuthResult: email=newest-acp@example.com\n' + 'z'.repeat(70_000),
  )
  utimesSync(newerAcp, 1_700_001_000, 1_700_001_000)
  assert.equal(readLoggedEmail([agyDir]), 'newest-acp@example.com')

  // Newer cli.log wins over older rotated logs.
  writeFileSync(olderCli, 'OAuth: authenticated successfully as fresh-cli@example.com\n')
  utimesSync(olderCli, 1_700_002_000, 1_700_002_000)
  assert.equal(readLoggedEmail([agyDir]), 'fresh-cli@example.com')

  // Intra-root symlink (cli.log -> log/cli-*.log, as created by agy 1.5.14) is contained and deduplicated.
  const linkedHome = join(root, 'linked-home')
  const linkedLogDir = join(linkedHome, 'log')
  mkdirSync(linkedLogDir, { recursive: true })
  const linkedTarget = join(linkedLogDir, 'cli-20261122.log')
  writeFileSync(linkedTarget, 'applyAuthResult: email=linked-user@example.com\n')
  symlinkSync(linkedTarget, join(linkedHome, 'cli.log'))
  assert.equal(readLoggedEmail([linkedHome]), 'linked-user@example.com')

  // Escaping log directory symlink is rejected completely.
  const escapedHome = join(root, 'escaped-home')
  mkdirSync(escapedHome, { recursive: true })
  const outsideLogs = join(outsideDir, 'logs')
  mkdirSync(outsideLogs, { recursive: true })
  writeFileSync(
    join(outsideLogs, 'cli-01.log'),
    'applyAuthResult: email=dir-escape@example.com\n',
  )
  symlinkSync(outsideLogs, join(escapedHome, 'log'), 'junction')
  assert.equal(readLoggedEmail([escapedHome]), undefined)
})

test('defaultAgyHomes, syncOAuthToken, and accountInfo respect ANTIGRAVITY_CLI_HOME and AGY_HOME', (t) => {
  const root = isolateHome(t)
  const userHome = join(root, 'user')
  const cliEnvDir = join(root, 'env-cli-home')
  const agyEnvDir = join(root, 'env-agy-home')
  const defaultDir = join(userHome, '.gemini', 'antigravity-cli')
  mkdirSync(cliEnvDir, { recursive: true })
  mkdirSync(agyEnvDir, { recursive: true })
  mkdirSync(defaultDir, { recursive: true })

  assert.deepEqual(
    defaultAgyHomes(userHome, {
      ANTIGRAVITY_CLI_HOME: cliEnvDir,
      AGY_HOME: agyEnvDir,
    }),
    [cliEnvDir, agyEnvDir, defaultDir],
  )
  assert.deepEqual(
    defaultAgyHomes(userHome, {
      ANTIGRAVITY_CLI_HOME: defaultDir,
      AGY_HOME: defaultDir,
    }),
    [defaultDir],
  )

  // ANTIGRAVITY_CLI_HOME takes priority over AGY_HOME and ~/.gemini/antigravity-cli.
  writeFileSync(join(defaultDir, 'antigravity-oauth-token'), 'default-token')
  writeFileSync(join(agyEnvDir, 'antigravity-oauth-token'), 'agy-home-token')
  writeFileSync(join(cliEnvDir, 'antigravity-oauth-token'), 'cli-home-token')
  const dst1 = join(userHome, '.pi', 'agent', 'cache', 'antigravity-acp')
  syncOAuthToken(dst1, userHome, {
    ANTIGRAVITY_CLI_HOME: cliEnvDir,
    AGY_HOME: agyEnvDir,
  })
  assert.equal(
    readFileSync(join(dst1, 'agy', 'antigravity-oauth-token'), 'utf8'),
    'cli-home-token',
  )

  // When ANTIGRAVITY_CLI_HOME has no token, falls back to AGY_HOME.
  const emptyCliDir = join(root, 'empty-cli-home')
  mkdirSync(emptyCliDir, { recursive: true })
  const userHome2 = join(root, 'user-2')
  const dst2 = join(userHome2, '.pi', 'agent', 'cache', 'antigravity-acp')
  syncOAuthToken(dst2, userHome2, {
    ANTIGRAVITY_CLI_HOME: emptyCliDir,
    AGY_HOME: agyEnvDir,
  })
  assert.equal(
    readFileSync(join(dst2, 'agy', 'antigravity-oauth-token'), 'utf8'),
    'agy-home-token',
  )

  // Custom PI_AGY_HOME remains isolated and does not read global ANTIGRAVITY_CLI_HOME logs.
  writeFileSync(
    join(cliEnvDir, 'cli.log'),
    'applyAuthResult: email=global-user@example.com\n',
  )
  process.env.ANTIGRAVITY_CLI_HOME = cliEnvDir
  const runtime = new AntigravityRuntime({
    config: { ...defaults, home: join(root, 'custom-pi-home') },
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
  assert.equal(runtime.status().account, undefined)
})

test('runCommand ignores stdin, caps stdout, aborts early on auth-required stderr, and cleans Unix process groups', async (t) => {
  const root = isolateHome(t)

  // 1. Stdin is ignored (immediate EOF, does not block).
  const stdinRes = await runCommand(
    [
      process.execPath,
      '-e',
      "process.stdin.on('end', () => { process.stdout.write('eof'); process.exit(0) }); process.stdin.resume()",
    ],
    5_000,
  )
  assert.equal(stdinRes.code, 0)
  assert.equal(stdinRes.stdout, 'eof')

  // 2. Early stderr match aborts promptly instead of waiting for full timeout, and QuotaReader surfaces auth error.
  const authScript = join(root, 'auth-agy.mjs')
  writeFileSync(
    authScript,
    "#!/usr/bin/env node\nprocess.stderr.write('Authentication required. Please run agy to sign in.\\n'); setTimeout(() => {}, 30000)\n",
  )
  chmodSync(authScript, 0o755)
  const started = Date.now()
  const reader = new QuotaReader(() => authScript, runCommand, 60_000)
  const authSnap = await reader.read(true)
  assert.equal(authSnap.status, 'error')
  assert.match(authSnap.error, /Authentication required/i)
  assert.ok(
    Date.now() - started < 5_000,
    'auth-required stderr should abort long before the 45s timeout',
  )

  // 3. Stdout exceeding 1 MiB aborts QuotaReader cleanly.
  const bigStdoutScript = join(root, 'big-agy.mjs')
  writeFileSync(
    bigStdoutScript,
    "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(1024 * 1024 + 64)); setTimeout(() => {}, 30000)\n",
  )
  chmodSync(bigStdoutScript, 0o755)
  const bigReader = new QuotaReader(() => bigStdoutScript, runCommand, 60_000)
  const bigSnap = await bigReader.read(true)
  assert.equal(bigSnap.status, 'error')
  assert.match(bigSnap.error, /stdout exceeded/i)
})

test(
  'runCommand and spawnAcp clean Unix process groups so grandchildren do not become orphans',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = isolateHome(t)
    const gcMarker = join(root, 'run-grandchild.terminated')
    const gcScript = join(root, 'grandchild.mjs')
    writeFileSync(
      gcScript,
      `import { writeFileSync } from 'node:fs'
const marker = process.argv[2]
process.on('SIGTERM', () => {
  writeFileSync(marker, 'sigterm')
  process.exit(0)
})
process.stderr.write('GC_READY\\n')
setInterval(() => {}, 60000)
`,
    )
    const parentScript = join(root, 'parent.mjs')
    writeFileSync(
      parentScript,
      `import { spawn } from 'node:child_process'
const gc = spawn(process.execPath, [${JSON.stringify(gcScript)}, process.argv[2]], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
process.on('SIGTERM', () => {
  if (gc.exitCode !== null || gc.signalCode !== null) process.exit(0)
  gc.once('exit', () => process.exit(0))
})
setInterval(() => {}, 60000)
`,
    )

    // 1. runCommand aborts the entire process group (-pid) when triggered.
    const runRes = await runCommand(
      [process.execPath, parentScript, gcMarker],
      10_000,
      { abortOnStderr: /GC_READY/ },
    )
    assert.equal(runRes.abortedBy, 'stderr')
    assert.equal(readFileSync(gcMarker, 'utf8'), 'sigterm')

    // 2. spawnAcp.terminate() signals the entire process group (-pid).
    const acpMarker = join(root, 'acp-grandchild.terminated')
    const acpParentScript = join(root, 'acp-parent.mjs')
    writeFileSync(
      acpParentScript,
      `import { spawn } from 'node:child_process'
const gc = spawn(process.execPath, [${JSON.stringify(gcScript)}, ${JSON.stringify(acpMarker)}], {
  stdio: ['ignore', 'inherit', 'pipe'],
})
gc.stderr.on('data', (chunk) => process.stdout.write(chunk))
setInterval(() => {}, 60000)
`,
    )
    const acpChild = spawnAcp([process.execPath, acpParentScript], root)
    await new Promise((resolveReady) => {
      acpChild.stdout.once('data', () => resolveReady())
    })
    const closed = new Promise((resolveClose) => {
      acpChild.stdout.once('close', () => resolveClose())
    })
    acpChild.terminate()
    await Promise.all([acpChild.exited, closed])
    assert.equal(readFileSync(acpMarker, 'utf8'), 'sigterm')
  },
)

test('binaryFingerprint and ModelCatalog invalidate cached contextWindows and observed on binary change', (t) => {
  const root = isolateHome(t)
  const binPath = join(root, 'fake-bin')
  writeFileSync(binPath, 'v1')
  const real = realpathSync(binPath)
  const st = statSync(real, { bigint: true })
  const fp1 = binaryFingerprint(binPath)
  assert.equal(fp1, `${real}:${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`)
  assert.equal(binaryFingerprint(join(root, 'missing-bin')), undefined)
  assert.equal(binaryFingerprint(root), undefined)

  const cachePath = join(root, 'catalog.json')
  const catalog = new ModelCatalog(cachePath, fp1)
  catalog.observe([
    { id: 'model', options: [{ value: 'gemini-4-argon', name: 'Gemini 4 Argon' }] },
  ])
  assert.equal(catalog.observeContextWindow('gemini-4-argon', 512_000), true)
  assert.equal(catalog.observed, true)

  // Atomic save leaves no temporary files behind and persists binaryFingerprint.
  assert.deepEqual(
    readdirSync(root).filter((name) => name.endsWith('.tmp')),
    [],
  )
  assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).binaryFingerprint, fp1)

  // Reload with same fingerprint preserves contextWindows.
  const same = new ModelCatalog(cachePath, fp1)
  assert.equal(same.contextWindowFor('gemini-4-argon'), 512_000)

  // Rewrite binary -> fingerprint changes -> reload invalidates contextWindows and observed.
  writeFileSync(binPath, 'v2-longer-binary')
  const fp2 = binaryFingerprint(binPath)
  assert.notEqual(fp2, fp1)
  const updated = new ModelCatalog(cachePath, fp2)
  assert.equal(updated.contextWindowFor('gemini-4-argon'), undefined)
  assert.equal(updated.observed, false)

  // Live catalog syncBinaryFingerprint also clears contextWindows and observed immediately.
  assert.equal(catalog.syncBinaryFingerprint(fp2), true)
  assert.equal(catalog.contextWindowFor('gemini-4-argon'), undefined)
  assert.equal(catalog.observed, false)
  assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).binaryFingerprint, fp2)
  assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8')).contextWindows, {})
})

test('extractContextWindowMetadata decodes estimated_tokens_used and SQLite rejects symlinked WAL/SHM sidecars', (t) => {
  const home = isolateHome(t)
  const bothCtx = pbField(
    0x0a,
    pbField(
      0x4a,
      pbField(
        0x52,
        Uint8Array.from([0x08, 0xd2, 0x09, 0x20, 0x80, 0xa0, 0x1f]),
      ),
    ),
  )
  assert.deepEqual(extractContextWindowMetadata(bothCtx), {
    estimatedTokensUsed: 1234,
    maxContextTokens: 512_000,
  })
  const onlyEst = pbField(
    0x0a,
    pbField(0x4a, pbField(0x52, Uint8Array.from([0x08, 0xd2, 0x09]))),
  )
  assert.deepEqual(extractContextWindowMetadata(onlyEst), {
    estimatedTokensUsed: 1234,
  })
  assert.equal(extractContextWindowMetadata(onlyEst)?.maxContextTokens, undefined)

  const convDir = join(home, 'agy', 'conversations')
  const outside = join(home, 'outside')
  mkdirSync(convDir, { recursive: true })
  mkdirSync(outside, { recursive: true })

  const createDb = (name) => {
    const db = new DatabaseSync(join(convDir, `${name}.db`))
    db.exec('CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob);')
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, bothCtx)
    db.close()
  }

  createDb('good')
  assert.deepEqual(readSessionContextMetadata(home, 'good'), {
    estimatedTokensUsed: 1234,
    maxContextTokens: 512_000,
  })

  createDb('sym-wal')
  const extWal = join(outside, 'ext.db-wal')
  writeFileSync(extWal, '')
  symlinkSync(extWal, join(convDir, 'sym-wal.db-wal'))
  assert.equal(readSessionContextMetadata(home, 'sym-wal'), undefined)
  assert.equal(readSessionNextMetadataIndex(home, 'sym-wal'), null)

  createDb('sym-shm')
  const extShm = join(outside, 'ext.db-shm')
  writeFileSync(extShm, '')
  symlinkSync(extShm, join(convDir, 'sym-shm.db-shm'))
  assert.equal(readSessionContextMetadata(home, 'sym-shm'), undefined)
  assert.equal(readSessionNextMetadataIndex(home, 'sym-shm'), null)

  createDb('dir-wal')
  mkdirSync(join(convDir, 'dir-wal.db-wal'))
  assert.equal(readSessionContextMetadata(home, 'dir-wal'), undefined)
  assert.equal(readSessionNextMetadataIndex(home, 'dir-wal'), null)
})

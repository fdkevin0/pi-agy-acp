// End-to-end tests of the runtime against the scripted fake ACP agent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AntigravityRuntime } from '../src/runtime.ts'
import {
  compactBridgeTool,
  consumeToolDelta,
  toBridgeTools,
  MAX_EAGER_BRIDGE_TOOL_BYTES,
} from '../src/mcp-bridge.ts'
import { JsonRpcPeer } from '../src/jsonrpc.ts'
import { defaults } from '../src/config.ts'
import { VERSION } from '../src/version.ts'
import { AcpProcess } from '../src/acp-process.ts'
import { AcpTurn, toTokenUsage, pumpStep } from '../src/conversation.ts'
import { deferred, digest } from '../src/util.ts'
import {
  bridgeSystemPrompt,
  EMPTY_INPUT_CONTINUATION,
  REPLAY_BUDGET_BYTES,
} from '../src/history.ts'
import {
  assertSupportedAgyVersion,
  prepareHome,
  resolveAgyBinary,
  syncOAuthToken,
} from '../src/preflight.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fake = join(here, 'fake-agy.mjs')
chmodSync(fake, 0o755)

function readJsonl(path) {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
}

function makeRuntime(t, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agy-acp-test-'))
  const log = join(home, 'prompts.jsonl')
  const initLog = join(home, 'init.jsonl')
  const mcpLog = join(home, 'mcp.jsonl')
  const config = {
    provider: 'antigravity',
    displayName: 'Antigravity',
    command: fake,
    home,
    defaultEffort: 'high',
    maxLiveSessions: 16,
    idleSessionTtlMs: 600_000,
    parkSettleMs: 80,
    keepAliveMs: 1_000,
    longDecodeContinuations: 3,
    quotaTtlMs: 60_000,
    ...extra.config,
  }
  const runtime = new AntigravityRuntime({
    config,
    spawnAcp: (argv, cwd) => {
      const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], {
        cwd,
        env: {
          ...process.env,
          FAKE_AGY_LOG: log,
          FAKE_AGY_INIT: initLog,
          FAKE_AGY_MCP: mcpLog,
          ...extra.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (d) => {
        stderr += d
      })
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        exited: new Promise((resolve) =>
          child.on('exit', (code, signal) => resolve({ code, signal })),
        ),
        terminate: () => child.kill(),
        stderrTail: () => stderr,
      }
    },
    runCommand: async (argv) => ({
      code: 0,
      stdout: argv.includes('--version') ? 'fake-agy 0.0.1' : '{}',
      stderr: '',
    }),
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
    ...extra.host,
  })
  t.after(async () => {
    try { await runtime.dispose() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  const prompts = () => readJsonl(log)
  const inits = () => readJsonl(initLog)
  const mcps = () => readJsonl(mcpLog)
  return { home, runtime, prompts, inits, mcps, adapter: runtime }
}

test('warmup coalesces discovery, cleans its files, and skips a live catalog from either session path', async (t) => {
  const discovery = makeRuntime(t)
  const proc = await discovery.runtime.ensureReady()
  const closeSession = proc.closeSession.bind(proc)
  const closed = []
  t.mock.method(proc, 'closeSession', async (sessionId) => {
    assert.equal(
      existsSync(
        join(discovery.home, 'agy', 'conversations', `${sessionId}.db`),
      ),
      true,
    )
    assert.equal(
      existsSync(join(discovery.home, 'agy', 'brain', sessionId)),
      true,
    )
    await closeSession(sessionId)
    closed.push(sessionId)
  })
  await Promise.all([
    discovery.runtime.warmup(),
    discovery.runtime.warmup(),
    discovery.runtime.warmup(),
  ])
  await discovery.runtime.warmup()
  assert.equal(discovery.mcps().length, 1)
  assert.equal(closed.length, 1)
  assert.equal(existsSync(join(discovery.home, 'agy', 'conversations', `${closed[0]}.db`)), false)
  assert.equal(existsSync(join(discovery.home, 'agy', 'conversations', `${closed[0]}.db-wal`)), false)
  assert.equal(existsSync(join(discovery.home, 'agy', 'conversations', `${closed[0]}.db-shm`)), false)
  assert.equal(
    existsSync(join(discovery.home, 'agy', 'brain', closed[0])),
    false,
  )
  assert.deepEqual(discovery.runtime.catalog.tier(), {
    id: 'test-ultra',
    name: 'Google AI Ultra',
  })
  assert.equal(discovery.prompts().length, 0)
  assert.equal(discovery.runtime.status().liveSessions, 0)
  const normal = makeRuntime(t)
  await collect(
    normal.runtime.stream({
      model: 'gemini-4-argon',
      sessionId: 'TIER',
      messages: [sys, user('tier', 'hello')],
    }),
  )
  assert.deepEqual(
    normal.runtime.catalog.tier(),
    discovery.runtime.catalog.tier(),
  )
  assert.equal(normal.runtime.status().account.plan, 'Google AI Ultra')
  await normal.runtime.warmup()
  assert.equal(normal.mcps().length, 1)
})

test('warmup retries failed discovery and cleans artifacts even if session close fails', async (t) => {
  const { runtime, home } = makeRuntime(t)
  const proc = await runtime.ensureReady()
  const newSession = proc.newSession.bind(proc)
  const opening = t.mock.method(proc, 'newSession', async () => {
    throw new Error('Discovery failed')
  })
  const results = await Promise.allSettled([runtime.warmup(), runtime.warmup()])
  assert.equal(opening.mock.callCount(), 1)
  assert.ok(results.every((result) => result.status === 'rejected'))
  assert.equal(runtime.catalog.observed, false)
  opening.mock.restore()
  let id
  t.mock.method(proc, 'newSession', async (...args) => {
    const result = await newSession(...args)
    id = result.sessionId
    return result
  })
  t.mock.method(proc, 'closeSession', async () => {
    throw new Error('Close failed')
  })
  await assert.rejects(runtime.warmup(), /Close failed/)
  assert.equal(
    existsSync(join(home, 'agy', 'conversations', `${id}.db`)),
    false,
  )
  assert.equal(existsSync(join(home, 'agy', 'brain', id)), false)
})

test('resetSession removes closed session files after acknowledgement and preserves other sessions', async (t) => {
  const { runtime, home } = makeRuntime(t)
  await collect(runtime.stream({ model: 'gemini-4-argon', sessionId: 'RESET-FILES', messages: [sys, user('RESET-FILES', 'hello')] }))
  await collect(runtime.stream({ model: 'gemini-4-argon', sessionId: 'KEEP-FILES', messages: [sys, user('KEEP-FILES', 'hello')] }))
  const conv = runtime.conversations.get('RESET-FILES')
  const keep = runtime.conversations.get('KEEP-FILES').sessionId
  const id = conv.sessionId
  const proc = conv.process
  const closing = Promise.withResolvers()
  const closeSession = proc.closeSession.bind(proc)
  let closed
  t.mock.method(proc, 'closeSession', (sessionId) => {
    closed = closing.promise.then(() => closeSession(sessionId))
    return closed
  })
  const resetting = runtime.resetSession(conv)
  assert.equal(conv.sessionId, undefined)
  assert.equal(existsSync(join(home, 'agy', 'conversations', `${id}.db`)), true)
  closing.resolve()
  await closed
  await resetting
  assert.equal(existsSync(join(home, 'agy', 'conversations', `${id}.db`)), false)
  assert.equal(existsSync(join(home, 'agy', 'conversations', `${id}.db-wal`)), false)
  assert.equal(existsSync(join(home, 'agy', 'conversations', `${id}.db-shm`)), false)
  assert.equal(existsSync(join(home, 'agy', 'conversations', `${keep}.db`)), true)
  assert.equal(existsSync(join(home, 'agy', 'conversations', `${keep}.db-wal`)), true)
  assert.equal(existsSync(join(home, 'agy', 'conversations', `${keep}.db-shm`)), true)
  assert.equal(existsSync(join(home, 'agy', 'brain', id)), false)
  assert.equal(existsSync(join(home, 'agy', 'brain', keep)), true)
})

test('a process restart cleans leftovers even when preflight metadata is cached', async (t) => {
  const { runtime, home } = makeRuntime(t)
  const proc = await runtime.ensureReady()
  const leftover = join(home, 'agy', 'conversations', 'stale.db')
  mkdirSync(join(leftover, '..'), { recursive: true })
  writeFileSync(leftover, 'stale session')
  proc.stop()
  await runtime.ensureReady()
  assert.equal(existsSync(leftover), false)
})

test('forced warmup refreshes an observed catalog and aborting one waiter keeps shared discovery alive', async (t) => {
  const { runtime, mcps, home } = makeRuntime(t)
  const changed = t.mock.method(runtime.host, 'onModelsChanged')
  const proc = await runtime.ensureReady()
  assert.equal(changed.mock.callCount(), 0, 'preflight does not change models')
  await runtime.warmup()
  await runtime.warmup()
  assert.equal(mcps().length, 1)
  await runtime.warmup({ force: true })
  assert.equal(mcps().length, 2)
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const open = proc.newSession.bind(proc)
  t.mock.method(proc, 'newSession', async (...args) => {
    entered.resolve()
    await gate.promise
    return open(...args)
  })
  const controller = new AbortController()
  const cancelled = runtime.warmup({ force: true, signal: controller.signal })
  await entered.promise
  const shared = runtime.warmup({ force: true })
  controller.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })
  gate.resolve()
  await shared
  assert.equal(mcps().length, 3)
  const id = mcps().at(-1).session
  assert.equal(
    existsSync(join(home, 'agy', 'conversations', `${id}.db`)),
    false,
  )
  await assert.rejects(
    runtime.warmup({ force: true, signal: AbortSignal.abort() }),
    { name: 'AbortError' },
  )
  assert.equal(mcps().length, 3)
})

test('light conversation reset releases sessions and their files while keeping the live process and caches', async (t) => {
  const { runtime, inits, home } = makeRuntime(t)
  const request = {
    model: 'gemini-4-argon',
    sessionId: 'LIGHT',
    messages: [sys, user('light', 'hello')],
  }
  await collect(runtime.stream(request))
  const proc = await runtime.ensureReady()
  const url = runtime.bridge.url
  const preflight = runtime.preflight
  const catalog = runtime.catalog
  const quota = runtime.quota
  const id = runtime.conversations.get('LIGHT').sessionId
  await runtime.resetConversations()
  assert.equal(runtime.status().liveSessions, 0)
  assert.equal(runtime.tenants.size, 0)
  assert.equal(
    existsSync(join(home, 'agy', 'conversations', `${id}.db`)),
    false,
  )
  assert.equal(existsSync(join(home, 'agy', 'brain', id)), false)
  assert.equal(proc.alive, true)
  assert.equal(runtime.bridge.url, url)
  assert.equal(runtime.preflight, preflight)
  assert.equal(runtime.catalog, catalog)
  assert.equal(runtime.quota, quota)
  await collect(runtime.stream(request))
  assert.equal(inits().length, 1)
  assert.notEqual(runtime.conversations.get('LIGHT').sessionId, id)
})

const sys = {
  id: 'sys',
  role: 'system',
  content: [{ type: 'text', text: 'You are Pi.' }],
  source: { kind: 'system-prompt' },
}
const user = (id, text) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})
const assistant = (id, content) => ({
  id,
  role: 'assistant',
  content,
  source: { kind: 'model', provider: 'antigravity', model: 'gemini-4-argon' },
})
const tool = (id, callId, text, isError) => ({
  id,
  role: 'tool',
  toolCallId: callId,
  content: [{ type: 'text', text }],
  source: { kind: 'tool', callId },
  ...(isError ? { isError: true } : {}),
})
const bash = {
  name: 'bash',
  description: 'Run a command',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
}
const read = {
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}
const finishOf = (chunks) => chunks.at(-1)
const textOf = (chunks) =>
  chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.text)
    .join('')
const callsOf = (chunks) =>
  chunks
    .filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    .map((c) => c.block)
/** Assemble the assistant message Pi would log for one step. */
const assistantFrom = (id, chunks) =>
  assistant(
    id,
    chunks.filter((c) => c.type === 'block-end').map((c) => c.block),
  )

test('single turn streams reasoning, text, exact usage, and the selected model and effort', async (t) => {
  const { adapter, prompts } = makeRuntime(t)
  const chunks = await collect(
    adapter.stream({
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      sessionId: 'S1',
      messages: [sys, user('u1', 'hello')],
    }),
  )
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.ok(
    chunks.some(
      (c) => c.type === 'reasoning-delta' && c.text === 'thinking(low)',
    ),
  )
  assert.match(textOf(chunks), /^echo:gemini-3\.8-flash:low:/)
  const usage = chunks.find((c) => c.type === 'usage').usage
  assert.deepEqual(usage, {
    inputTokens: 600,
    outputTokens: 50,
    cacheReadTokens: 400,
    reasoningTokens: 20,
    totalTokens: 1050,
  })
  assert.match(prompts()[0].system, /primary model of a Pi coding agent/)
  assert.equal(adapter.status().lastTurn.outcome, 'completed')
  assert.equal(adapter.status().lastTurn.model, 'gemini-3.8-flash')
  assert.ok(adapter.status().lastTurn.durationMs >= 0)
  assert.equal(adapter.status().lastTurn.retryNotices, 0)
  assert.equal(adapter.status().lastTurn.usage.inputTokens, 600)
})

test('a tool call parks, ends the step, and resumes the same ACP turn with the Pi result', async (t) => {
  const { adapter, prompts } = makeRuntime(t)
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S2',
    tools: [bash],
  }
  const step1 = await collect(
    adapter.stream({
      ...base,
      messages: [sys, user('u1', 'CALL bash {"command":"ls"}')],
    }),
  )
  assert.equal(finishOf(step1).reason.kind, 'tool-calls')
  const [call] = callsOf(step1)
  assert.equal(call.name, 'bash')
  assert.deepEqual(JSON.parse(call.arguments), { command: 'ls' })
  assert.deepEqual(prompts()[0].tools, [
    'bash',
    'pi_await_result',
    'pi_call_tool',
  ])
  const history = [
    sys,
    user('u1', 'CALL bash {"command":"ls"}'),
    assistantFrom('a1', step1),
    tool('t1', call.id, 'file-a'),
  ]
  const step2 = await collect(adapter.stream({ ...base, messages: history }))
  assert.equal(finishOf(step2).reason.kind, 'stop')
  assert.equal(textOf(step2), 'RESULT(bash)=file-a')
  assert.deepEqual(step2.find((c) => c.type === 'usage').usage, {
    inputTokens: 300,
    outputTokens: 50,
    cacheReadTokens: 200,
    reasoningTokens: 20,
    totalTokens: 550,
  })
  assert.equal(
    prompts().length,
    1,
    'tool results resume the running prompt instead of sending a new one',
  )

  // The next user turn reuses the ACP session and sends only the new input.
  const next = [
    ...history,
    assistantFrom('a2', step2),
    user('u2', 'second question'),
  ]
  const step3 = await collect(adapter.stream({ ...base, messages: next }))
  assert.equal(finishOf(step3).reason.kind, 'stop')
  const third = prompts()[1]
  assert.equal(third.text, 'second question')
  assert.equal(third.session, prompts()[0].session)
})

test('parallel tool calls arrive as one Pi step', async (t) => {
  const { adapter } = makeRuntime(t)
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S3',
    tools: [bash, read],
  }
  const step1 = await collect(
    adapter.stream({
      ...base,
      messages: [
        sys,
        user(
          'u1',
          'PCALL bash {"command":"pwd"} ;; read_file {"path":"a.txt"}',
        ),
      ],
    }),
  )
  const calls = callsOf(step1)
  assert.deepEqual(calls.map((c) => c.name).sort(), ['bash', 'read_file'])
  const history = [
    sys,
    user('u1', 'x'),
    assistantFrom('a1', step1),
    ...calls.map((c, i) => tool(`t${i}`, c.id, `out-${c.name}`)),
  ]
  const step2 = await collect(adapter.stream({ ...base, messages: history }))
  assert.match(textOf(step2), /RESULT\(bash\)=out-bash/)
  assert.match(textOf(step2), /RESULT\(read_file\)=out-read_file/)
})

test('changed history rebuilds the session with a transcript replay', async (t) => {
  const { adapter, prompts } = makeRuntime(t)
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S4',
  }
  await collect(
    adapter.stream({ ...base, messages: [sys, user('u1', 'first')] }),
  )
  // A compaction replaced the earlier history with a summary node.
  const compacted = [
    sys,
    user('sum', 'Summary of earlier work'),
    assistant('a9', [{ type: 'text', text: 'ok' }]),
    user('u3', 'continue please'),
  ]
  await collect(adapter.stream({ ...base, messages: compacted }))
  const replay = prompts()[1]
  assert.notEqual(replay.session, prompts()[0].session)
  assert.match(
    replay.text,
    /<pi_history>[\s\S]*Summary of earlier work[\s\S]*<\/pi_history>/,
  )
  assert.match(replay.text, /continue please$/)
})

test('a compaction rewrite while a tool call is parked rebuilds instead of resuming the stale turn', async (t) => {
  const { adapter, prompts } = makeRuntime(t)
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S22',
    tools: [bash],
  }
  const step1 = await collect(
    adapter.stream({
      ...base,
      messages: [sys, user('u1', 'CALL bash {"command":"ls"}')],
    }),
  )
  assert.equal(finishOf(step1).reason.kind, 'tool-calls')
  const [call] = callsOf(step1)
  assert.equal(prompts().length, 1)

  // Mid-turn compaction replaced the earlier history with a summary checkpoint.
  // The turn is still parked on the tool result and the history ends with it.
  const compacted = [
    sys,
    user('compact-summary', 'Summary of earlier work: listed the workspace.'),
    assistantFrom('a1', step1),
    tool('t1', call.id, 'file-a'),
  ]
  const step2 = await collect(adapter.stream({ ...base, messages: compacted }))
  assert.equal(finishOf(step2).reason.kind, 'stop')
  assert.equal(
    prompts().length,
    2,
    'the parked turn must not absorb the compacted history',
  )
  const rebuilt = prompts()[1]
  assert.notEqual(
    rebuilt.session,
    prompts()[0].session,
    'a new ACP session rebuilds from the compacted history',
  )
  const historyBlock = /<pi_history>\n([\s\S]*?)\n<\/pi_history>/.exec(
    rebuilt.text,
  )
  assert.ok(historyBlock !== null, 'the rebuild sends a <pi_history> block')
  assert.ok(
    historyBlock[1].includes('Summary of earlier work: listed the workspace.'),
  )
  assert.ok(historyBlock[1].includes('<tool_call id="' + call.id + '"'))
  assert.ok(historyBlock[1].includes('<tool_result id="' + call.id + '">'))
  assert.ok(historyBlock[1].includes('file-a'))
  assert.ok(
    rebuilt.text.endsWith(EMPTY_INPUT_CONTINUATION),
    'the prompt ends with a live continuation instruction',
  )
  assert.ok(rebuilt.text.trim().length > 0)
})


test('an empty-input rebuild sends a non-empty continuation prompt after <pi_history>', async (t) => {
  const { adapter, prompts } = makeRuntime(t)
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S24',
  }
  await collect(
    adapter.stream({ ...base, messages: [sys, user('u1', 'start')] }),
  )
  // Compaction leaves the history ending in an assistant tool call plus its
  // result, so plan() has no trailing user/system input to deliver.
  const compacted = [
    sys,
    user('compact-summary', 'Summary: earlier work only.'),
    assistant('a1', [
      {
        type: 'tool-call',
        id: 'agy_old_1',
        name: 'bash',
        arguments: '{"command":"ls"}',
      },
    ]),
    tool('t1', 'agy_old_1', 'file-a'),
  ]
  const chunks = await collect(adapter.stream({ ...base, messages: compacted }))
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.equal(prompts().length, 2)
  const rebuilt = prompts()[1]
  assert.notEqual(rebuilt.session, prompts()[0].session)
  const historyBlock = /<pi_history>\n([\s\S]*?)\n<\/pi_history>/.exec(
    rebuilt.text,
  )
  assert.ok(historyBlock !== null)
  assert.ok(historyBlock[1].includes('Summary: earlier work only.'))
  assert.ok(historyBlock[1].includes('file-a'))
  assert.ok(
    rebuilt.text.endsWith(EMPTY_INPUT_CONTINUATION),
    'the prompt ends with a live continuation instruction',
  )
  assert.ok(rebuilt.text.trim().length > 0)
})

test('subagent sessions run concurrently while the parent waits on a tool', async (t) => {
  const { adapter } = makeRuntime(t)
  const parent = collect(
    adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      sessionId: 'P',
      tools: [bash],
      messages: [sys, user('p1', 'CALL bash {"command":"spawn"}')],
    }),
  )
  const childA = collect(
    adapter.stream({
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      sessionId: 'C1',
      messages: [sys, user('c1', 'child one')],
    }),
  )
  const childB = collect(
    adapter.stream({
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'low',
      sessionId: 'C2',
      tools: [read],
      messages: [sys, user('c2', 'CALL read_file {"path":"b"}')],
    }),
  )
  const [p, a, b] = await Promise.all([parent, childA, childB])
  assert.equal(finishOf(p).reason.kind, 'tool-calls')
  assert.equal(finishOf(a).reason.kind, 'stop')
  assert.equal(finishOf(b).reason.kind, 'tool-calls')
  const status = adapter.status()
  assert.equal(status.activeTurns, 2)
})

test('a tool that outlives the MCP deadline is relayed through pi_await_result', async (t) => {
  const { adapter, runtime } = makeRuntime(t, { host: { relayAfterMs: 20 } })
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S5',
    tools: [bash],
  }
  const step1 = await collect(
    adapter.stream({
      ...base,
      messages: [sys, user('u1', 'CALL bash {"command":"long"}')],
    }),
  )
  const [call] = callsOf(step1)
  const relayed = deferred()
  const originalCallTool = runtime.bridge.router.callTool
  t.mock.method(runtime.bridge.router, 'callTool', (req) => {
    relayed.resolve(req.name)
    return originalCallTool(req)
  })
  assert.equal(await relayed.promise, 'pi_await_result')
  const step2 = await collect(
    adapter.stream({
      ...base,
      messages: [
        sys,
        user('u1', 'x'),
        assistantFrom('a1', step1),
        tool('t1', call.id, 'done-late'),
      ],
    }),
  )
  assert.equal(textOf(step2), 'RESULT(bash)=done-late')
  assert.equal(adapter.status().lastTurn.outcome, 'completed')
})

test('steering input after tool results reaches the agent with the last result', async (t) => {
  const { adapter } = makeRuntime(t)
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S6',
    tools: [bash],
  }
  const step1 = await collect(
    adapter.stream({
      ...base,
      messages: [sys, user('u1', 'CALL bash {"command":"ls"}')],
    }),
  )
  const [call] = callsOf(step1)
  const step2 = await collect(
    adapter.stream({
      ...base,
      messages: [
        sys,
        user('u1', 'x'),
        assistantFrom('a1', step1),
        tool('t1', call.id, 'r'),
        user('u2', 'also check tests'),
      ],
    }),
  )
  assert.match(textOf(step2), /RESULT\(bash\)=r[\s\S]*also check tests/)
})

test('cancellation during deferred preflight finishes aborted without opening a session', async (t) => {
  const entered = deferred(), resume = deferred()
  const { runtime, prompts, mcps } = makeRuntime(t, { host: {
    runCommand: async () => {
      entered.resolve()
      await resume.promise
      return { code: 0, stdout: 'fake-agy 0.0.1', stderr: '' }
    },
  } })
  const controller = new AbortController()
  const request = { model: 'gemini-4-argon', sessionId: 'startup-abort',
    signal: controller.signal, messages: [sys, user('u1', 'hello')] }
  const pending = collect(runtime.stream(request))
  await entered.promise
  controller.abort()
  resume.resolve()
  const chunks = await pending
  assert.deepEqual(chunks, [{ type: 'finish', reason: {
    kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' },
  } }])
  assert.equal(prompts().length, 0)
  assert.equal(mcps().length, 0)
  assert.equal(runtime.conversations.size, 0)
  assert.equal(runtime.tenants.size, 0)
  assert.equal(runtime.status().activeTurns, 0)
  assert.equal(finishOf(await collect(runtime.stream({ ...request, signal: undefined }))).reason.kind, 'stop')
})

test('cancellation while waiting for ownership releases only the acquired session turn', async (t) => {
  const { runtime } = makeRuntime(t)
  const request = { model: 'gemini-4-argon', sessionId: 'queued-abort', tools: [bash],
    messages: [sys, user('u1', 'CALL bash {"command":"long"}')] }
  await collect(runtime.stream(request))
  await collect(runtime.stream({ ...request, sessionId: 'other-owner' }))
  const conv = runtime.conversations.get(request.sessionId)
  const oldTurn = conv.turn
  const otherTurn = runtime.conversations.get('other-owner').turn
  const waitingCall = [...oldTurn.calls.values()][0]
  const release = await runtime.mutex.acquire(request.sessionId)
  const entered = deferred()
  const acquire = runtime.mutex.acquire.bind(runtime.mutex)
  t.mock.method(runtime.mutex, 'acquire', (...args) => {
    const pending = acquire(...args)
    entered.resolve()
    return pending
  })
  const controller = new AbortController()
  const pending = collect(runtime.stream({ ...request, signal: controller.signal }))
  await entered.promise
  controller.abort()
  assert.equal(conv.turn, oldTurn, 'queued request has no ownership yet')
  release()
  assert.equal(finishOf(await pending).reason.kind, 'aborted')
  assert.equal(conv.turn, undefined)
  assert.equal(conv.opening, false)
  assert.equal(conv.dirty, true)
  assert.equal((await waitingCall.result.promise).isError, true)
  assert.equal(runtime.conversations.get('other-owner').turn, otherTurn)
})

test('startup failure remains a failure when the request also cancels', async (t) => {
  const entered = deferred(), resume = deferred()
  const { runtime } = makeRuntime(t)
  t.mock.method(runtime, 'runPreflight', async () => {
    entered.resolve()
    await resume.promise
    throw new Error('preflight failed')
  })
  const controller = new AbortController()
  const failed = assert.rejects(collect(runtime.stream({ model: 'gemini-4-argon',
    signal: controller.signal, messages: [sys, user('u1', 'hello')],
  })), /preflight failed/)
  await entered.promise
  controller.abort()
  resume.resolve()
  await failed
  assert.equal(runtime.conversations.size, 0)
  assert.equal(runtime.bridge.server, undefined)
})

test('disposal remains a failure when the request also cancels', async (t) => {
  const entered = deferred(), resume = deferred()
  const { runtime } = makeRuntime(t)
  t.mock.method(runtime, 'runPreflight', async () => {
    entered.resolve()
    await resume.promise
    throw new Error('preflight failed')
  })
  const controller = new AbortController()
  const failed = assert.rejects(collect(runtime.stream({ model: 'gemini-4-argon',
    signal: controller.signal, messages: [sys, user('u1', 'hello')],
  })), /disposed/)
  await entered.promise
  controller.abort()
  await runtime.dispose()
  resume.resolve()
  await failed
  assert.equal(runtime.conversations.size, 0)
  assert.equal(runtime.bridge.server, undefined)
})

test('cancellation aborts the step and the next turn rebuilds', async (t) => {
  const { adapter, prompts } = makeRuntime(t)
  const proc = await adapter.ensureReady()
  const entered = deferred()
  const prompt = proc.prompt.bind(proc)
  t.mock.method(proc, 'prompt', (...args) => {
    const pending = prompt(...args)
    entered.resolve()
    return pending
  })
  const controller = new AbortController()
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S7',
  }
  const pending = collect(
    adapter.stream({
      ...base,
      signal: controller.signal,
      messages: [sys, user('u1', 'SLEEP 2000')],
    }),
  )
  await entered.promise
  controller.abort()
  const chunks = await pending
  assert.equal(finishOf(chunks).reason.kind, 'aborted')
  assert.equal(adapter.status().lastTurn.outcome, 'aborted')
  await collect(
    adapter.stream({
      ...base,
      messages: [
        sys,
        user('u1', 'SLEEP 2000'),
        assistant('a1', [{ type: 'text', text: 'partial' }]),
        user('u2', 'again'),
      ],
    }),
  )
  const rebuilt = prompts().at(-1)
  assert.notEqual(rebuilt.session, prompts()[0].session)
  assert.match(
    rebuilt.text,
    /<pi_history>[\s\S]*partial[\s\S]*<\/pi_history>[\s\S]*again$/,
  )
})

async function assertCancelledSettlement(t, promptFn, expectedPrompts, settle) {
  const { runtime } = makeRuntime(t)
  const conv = runtime.createConversation('settlement')
  const turn = (conv.turn = new AcpTurn('test'))
  const pending = deferred()
  const proc = {
    alive: true,
    stop: () => {},
    prompt: t.mock.fn(() => pending.promise),
    cancel: () => {},
  }
  promptFn(proc.prompt, pending)
  runtime.process = conv.process = proc
  conv.sessionId = 'settlement'
  runtime.startPrompt(conv, turn, proc, [])
  const controller = new AbortController()
  const stream = runtime.pump(
    conv, turn,
    proc,
    { model: 'gemini-4-argon', signal: controller.signal },
    'high',
  )
  const finish = stream.next()
  await new Promise(setImmediate)
  assert.equal(proc.prompt.mock.callCount(), expectedPrompts)
  controller.abort()
  turn.events.push({ kind: 'text', text: 'late text' })
  assert.equal((await finish).value.reason.kind, 'aborted')
  let settled = false
  const done = stream.next().then((result) => {
    settled = true
    return result
  })
  await new Promise(setImmediate)
  assert.equal(settled, false, 'cleanup waits for the pending prompt')
  settle(pending)
  assert.equal((await done).done, true)
  assert.equal(
    turn.events.peek().kind,
    'text',
    'settlement does not depend on draining output',
  )
  assert.equal(conv.dirty, true)
  assert.equal(conv.turn, undefined)
}

test('cancelled prompt settles despite queued text when transport resolves', { timeout: 1500 }, (t) =>
  assertCancelledSettlement(t, () => {}, 1, (pending) => pending.resolve({ stopReason: 'cancelled' })))

test('cancelled continuation prompt settles despite queued text when transport rejects', { timeout: 1500 }, (t) =>
  assertCancelledSettlement(
    t,
    (prompt) => prompt.mock.mockImplementationOnce(async () => ({ stopReason: 'max_tokens' })),
    2,
    (pending) => pending.reject(new Error('cancelled transport')),
  ))

test('an output-length stop continues automatically (long decode)', async (t) => {
  const { adapter } = makeRuntime(t)
  const chunks = await collect(
    adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      sessionId: 'S8',
      messages: [sys, user('u1', 'MAXTOK write a lot')],
    }),
  )
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.match(textOf(chunks), /^part-one echo:/)
  assert.equal(adapter.status().lastTurn.usage.inputTokens, 600)
})

test('images in user input are sent as ACP image blocks', async (t) => {
  const { adapter, prompts } = makeRuntime(t)
  const image = { type: 'image', data: 'aW1n', mimeType: 'image/png' }
  await collect(
    adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      sessionId: 'S10',
      messages: [
        sys,
        {
          id: 'u1',
          role: 'user',
          content: [{ type: 'text', text: 'see' }, image],
          source: { kind: 'user' },
        },
      ],
    }),
  )
  assert.equal(prompts()[0].images, 1)
})

test('agent transport retry notices never reach the model output', async (t) => {
  const { adapter } = makeRuntime(t)
  const chunks = await collect(
    adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      sessionId: 'S11',
      messages: [sys, user('u1', 'NOTICE hi')],
    }),
  )
  assert.doesNotMatch(textOf(chunks), /API error/)
  assert.equal(adapter.status().lastTurn.retryNotices, 1)
  assert.match(textOf(chunks), /^echo:/)
})

test('agy output-limit continuation notices never reach the model output', async (t) => {
  const { adapter } = makeRuntime(t)
  const chunks = await collect(
    adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      sessionId: 'S11b',
      messages: [sys, user('u1', 'OUTLIMIT hi')],
    }),
  )
  assert.doesNotMatch(textOf(chunks), /output token limit/)
  assert.doesNotMatch(textOf(chunks), /Retries remaining/)
  assert.match(textOf(chunks), /^echo:/)
})

test('cache reads stay disjoint from the uncached input count', () => {
  const usage = toTokenUsage({
    inputTokens: 11_677,
    outputTokens: 321,
    cachedReadTokens: 31_377,
    cachedWriteTokens: 0,
    totalTokens: 43_375,
  })
  assert.deepEqual(usage, {
    inputTokens: 11_677,
    outputTokens: 321,
    cacheReadTokens: 31_377,
    totalTokens: 11_677 + 31_377 + 321,
  })
  assert.equal(toTokenUsage(undefined), undefined)
})

test('bounded replay drops the oldest history, closes the block, and keeps the latest input intact', async (t) => {
  const { adapter, prompts } = makeRuntime(t)
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S12',
  }
  await collect(
    adapter.stream({ ...base, messages: [sys, user('u1', 'bootstrap')] }),
  )
  const old1 = `OLD-1 ${'x'.repeat(55_000)}`
  const old2 = `OLD-2 ${'y'.repeat(55_000)}`
  const old3 = `OLD-3 ${'z'.repeat(55_000)}`
  const old4 = `OLD-4 ${'w'.repeat(55_000)}`
  const latest = `LATEST ${'keep this question '.repeat(100)}`
  const history = [
    sys,
    user('u1', old1),
    assistant('a1', [{ type: 'text', text: 'ack one' }]),
    user('u2', old2),
    assistant('a2', [{ type: 'text', text: 'ack two' }]),
    user('u3', old3),
    assistant('a3', [{ type: 'text', text: 'ack three' }]),
    user('u4', old4),
    assistant('a4', [{ type: 'text', text: 'ack four' }]),
  ]
  await collect(
    adapter.stream({ ...base, messages: [...history, user('u9', latest)] }),
  )
  const replay = prompts().at(-1)
  assert.notEqual(replay.session, prompts()[0].session)
  assert.match(replay.text, /^<pi_history>\n/)
  assert.match(replay.text, /\n<\/pi_history>\n\nLATEST /)
  assert.ok(replay.text.endsWith(latest))
  assert.ok(!replay.text.includes('OLD-1'))
  assert.ok(!replay.text.includes('OLD-2'))
  assert.ok(replay.text.includes('OLD-3'))
  assert.ok(replay.text.includes('OLD-4'))
  assert.match(
    replay.text,
    /Earlier 3 history messages omitted to fit the context replay budget/,
  )
  const inputBytes = Buffer.byteLength(latest, 'utf8')
  assert.ok(
    Buffer.byteLength(replay.text, 'utf8') <= REPLAY_BUDGET_BYTES + inputBytes,
  )
})


test('Claude honors the requested thinking level', async (t) => {
  const { adapter, prompts } = makeRuntime(t)
  const chunks = await collect(
    adapter.stream({
      provider: 'antigravity',
      model: 'claude-opus-5-5',
      reasoningEffort: 'high',
      sessionId: 'S14',
      messages: [sys, user('u1', 'hello')],
    }),
  )
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.equal(prompts()[0].model, 'claude-opus-5-5')
  assert.equal(prompts()[0].level, 'high')
})

test('a fixed-effort family still runs at medium without a thought_level write', async (t) => {
  const { adapter, prompts } = makeRuntime(t)
  const chunks = await collect(
    adapter.stream({
      provider: 'antigravity',
      model: 'gpt-oss-120b-medium',
      reasoningEffort: 'high',
      sessionId: 'S15',
      messages: [sys, user('u1', 'hello')],
    }),
  )
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.match(textOf(chunks), /^echo:gpt-oss-120b-medium:medium:/)
  assert.equal(prompts()[0].level, 'medium')
})

test('oversized tool schemas compact below agy eager cutoff and pi_call_tool dispatches native calls', async (t) => {
  const hugeTool = {
    name: 'bash',
    description: `${'Execute a bash command and return stdout/stderr. '.repeat(25)}Provide description first.`,
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Verbose example description. '.repeat(20),
        },
        command: {
          type: 'string',
          description: 'Command string to run. '.repeat(20),
        },
        sandbox_permissions: {
          type: 'string',
          enum: ['workspace-write', 'danger-full-access'],
          description: 'Escalation mode. '.repeat(20),
        },
      },
      required: ['description', 'command'],
    },
  }
  assert.ok(Buffer.byteLength(JSON.stringify(hugeTool), 'utf8') > 2200)
  const compacted = compactBridgeTool(hugeTool)
  assert.ok(
    Buffer.byteLength(JSON.stringify(compacted), 'utf8') <=
      MAX_EAGER_BRIDGE_TOOL_BYTES,
  )
  assert.deepEqual(compacted.inputSchema.required, ['description', 'command'])
  assert.deepEqual(compacted.inputSchema.properties.sandbox_permissions.enum, [
    'workspace-write',
    'danger-full-access',
  ])

  const { adapter } = makeRuntime(t)
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S17',
    tools: [bash],
  }
  const step1 = await collect(
    adapter.stream({
      ...base,
      messages: [
        sys,
        user(
          'u1',
          'CALL pi_call_tool {"name":"mcp_pi_bash","arguments":{"command":"pwd"}}',
        ),
      ],
    }),
  )
  assert.equal(finishOf(step1).reason.kind, 'tool-calls')
  const [call] = callsOf(step1)
  assert.equal(call.name, 'bash')
  assert.deepEqual(JSON.parse(call.arguments), { command: 'pwd' })
  const history = [
    sys,
    user('u1', 'x'),
    assistantFrom('a1', step1),
    tool('t1', call.id, '/workspace'),
  ]
  const step2 = await collect(adapter.stream({ ...base, messages: history }))
  assert.equal(textOf(step2), 'RESULT(pi_call_tool)=/workspace')
})

test('permission gate rejects spoofed native tools and grants genuinely reported bridge calls', async (t) => {
  const { adapter } = makeRuntime(t)
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S25',
    tools: [bash, read],
  }

  // ① A native tool whose rawInput merely embeds "mcp_pi_bash" must be rejected.
  // ② A title faking "mcp_pi_read" without structured metadata must be rejected.
  const hostile = await collect(
    adapter.stream({
      ...base,
      messages: [
        sys,
        user(
          'u1',
          'DENYCALL bash {"command":"ls"}\nSPOOFCALL read_file {"path":"a"}',
        ),
      ],
    }),
  )
  assert.equal(finishOf(hostile).reason.kind, 'stop')
  assert.match(textOf(hostile), /RESULT\(bash\)=PERMISSION_REJECTED/)
  assert.match(textOf(hostile), /RESULT\(read_file\)=PERMISSION_REJECTED/)

  // A permission request whose structured claim was never reported is rejected.
  const stale = await collect(
    adapter.stream({
      ...base,
      messages: [sys, user('u1', 'STALECALL bash {"command":"ls"}')],
    }),
  )
  assert.match(textOf(stale), /RESULT\(bash\)=PERMISSION_REJECTED/)

  // A permission request that contradicts the reported tool name is rejected.
  const conflict = await collect(
    adapter.stream({
      ...base,
      messages: [
        sys,
        user('u1', 'CONFLICTCALL bash {"command":"ls"} ;; read_file'),
      ],
    }),
  )
  assert.match(textOf(conflict), /RESULT\(bash\)=PERMISSION_REJECTED/)

  // ③ Real structured reporting of bash is allowed end-to-end: permission grants the call.
  const step1 = await collect(
    adapter.stream({
      ...base,
      messages: [sys, user('u1', 'CALL bash {"command":"pwd"}')],
    }),
  )
  assert.equal(finishOf(step1).reason.kind, 'tool-calls')
  const [call] = callsOf(step1)
  const resumed = await collect(
    adapter.stream({
      ...base,
      messages: [
        sys,
        user('u1', 'CALL bash {"command":"pwd"}'),
        assistantFrom('a1', step1),
        tool('t1', call.id, '/workspace'),
      ],
    }),
  )
  assert.equal(finishOf(resumed).reason.kind, 'stop')
  assert.equal(textOf(resumed), 'RESULT(bash)=/workspace')

  // pi_call_tool is allowed by the gate and dispatches to the target Pi tool.
  const dispatch = await collect(
    adapter.stream({
      ...base,
      messages: [
        sys,
        user(
          'u2',
          'CALL pi_call_tool {"name":"mcp_pi_read_file","arguments":{"path":"README.md"}}',
        ),
      ],
    }),
  )
  assert.equal(finishOf(dispatch).reason.kind, 'tool-calls')
  const [dispatched] = callsOf(dispatch)
  assert.equal(dispatched.name, 'read_file')
  assert.deepEqual(JSON.parse(dispatched.arguments), { path: 'README.md' })

  // The MCP server loading probe (no tool name, no identity) is allowed exactly
  // once — never as allow_always.
  const probe = await collect(
    adapter.stream({ ...base, messages: [sys, user('u1', 'PROBECALL')] }),
  )
  assert.match(textOf(probe), /PROBE_OK:allow-once/)
})

test('the permission gate binds the loading probe to a handshake and keeps identities across updates', async (t) => {
  const { adapter } = makeRuntime(t)
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S31',
    tools: [bash, read],
  }

  // A probe whose options only offer allow_always is refused outright.
  const alwaysOnlyProbe = await collect(
    adapter.stream({
      ...base,
      messages: [sys, user('u2', 'PROBECALL_ALWAYSONLY')],
    }),
  )
  assert.match(textOf(alwaysOnlyProbe), /PROBE_DENIED:cancelled/)

  // A genuinely reported call is likewise never granted allow_always.
  const alwaysOnlyCall = await collect(
    adapter.stream({
      ...base,
      messages: [sys, user('u3', 'CALL_ALWAYSONLY bash {"command":"ls"}')],
    }),
  )
  assert.equal(finishOf(alwaysOnlyCall).reason.kind, 'stop')
  assert.match(textOf(alwaysOnlyCall), /RESULT\(bash\)=PERMISSION_CANCELLED/)

  // A status-only tool_call_update preserves the established identity.
  const statusStep = await collect(
    adapter.stream({
      ...base,
      messages: [
        sys,
        user('u4', 'STATUSUPDCALL read_file {"path":"README.md"}'),
      ],
    }),
  )
  assert.equal(finishOf(statusStep).reason.kind, 'tool-calls')
  const [statusCall] = callsOf(statusStep)
  assert.equal(statusCall.name, 'read_file')
  const statusHistory = [
    sys,
    user('u4', 'STATUSUPDCALL read_file {"path":"README.md"}'),
    assistantFrom('a1', statusStep),
    tool('t1', statusCall.id, 'ok'),
  ]
  const statusResumed = await collect(
    adapter.stream({ ...base, messages: statusHistory }),
  )
  assert.equal(finishOf(statusResumed).reason.kind, 'stop')
  assert.equal(textOf(statusResumed), 'RESULT(read_file)=ok')

  // A tool_call_update contradicting the reported identity marks the call
  // anomalous: neither the original claim nor the conflicting one may pass.
  const conflictUpdate = await collect(
    adapter.stream({
      ...base,
      messages: [
        sys,
        user('u5', 'CONFLICTUPDCALL bash {"command":"ls"} ;; read_file'),
      ],
    }),
  )
  assert.equal(finishOf(conflictUpdate).reason.kind, 'stop')
  assert.match(
    textOf(conflictUpdate),
    /RESULT\(bash\)=PERMISSION_REJECTED CONFLICT_CLAIM_read_file_DENIED/,
  )

  // Reported identities are cleared with their turn: replaying a previous
  // turn's id in the same (reused) session is rejected even though the claimed
  // identity itself matches what was once reported.
  const callStep = await collect(
    adapter.stream({
      ...base,
      messages: [sys, user('u6', 'CALL bash {"command":"pwd"}')],
    }),
  )
  assert.equal(finishOf(callStep).reason.kind, 'tool-calls')
  const [call] = callsOf(callStep)
  const callHistory = [
    sys,
    user('u6', 'CALL bash {"command":"pwd"}'),
    assistantFrom('a1', callStep),
    tool('t1', call.id, '/workspace'),
  ]
  const resumed = await collect(
    adapter.stream({ ...base, messages: callHistory }),
  )
  assert.equal(textOf(resumed), 'RESULT(bash)=/workspace')
  const nextTurn = [
    ...callHistory,
    assistantFrom('a2', resumed),
    user('u7', 'REPLAYCALL bash {"command":"ls"}'),
  ]
  const replay = await collect(adapter.stream({ ...base, messages: nextTurn }))
  assert.match(textOf(replay), /RESULT\(bash\)=PERMISSION_REJECTED/)
})

test('a session whose agent never completed the MCP handshake refuses identity-less probes', async (t) => {
  const { adapter } = makeRuntime(t, { env: { FAKE_AGY_NO_HANDSHAKE: '1' } })
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S32',
    tools: [bash],
  }
  const probe = await collect(
    adapter.stream({ ...base, messages: [sys, user('u1', 'PROBECALL')] }),
  )
  assert.match(textOf(probe), /PROBE_DENIED:reject-once/)
})

test('permission requests naming another session are refused', async (t) => {
  const { adapter } = makeRuntime(t)
  await collect(
    adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      sessionId: 'S26',
      tools: [bash],
      messages: [sys, user('u1', 'hello')],
    }),
  )
  const step = await collect(
    adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      sessionId: 'S27',
      tools: [bash],
      messages: [sys, user('u1', 'CROSSCALL s1 bash {"command":"ls"}')],
    }),
  )
  assert.match(textOf(step), /RESULT\(bash\)=PERMISSION_REJECTED/)
})

test('the MCP bridge enforces per-tenant bearer secrets and drops the conversationId fallback', async (t) => {
  const { adapter, mcps } = makeRuntime(t)
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    tools: [bash],
  }
  await collect(
    adapter.stream({
      ...base,
      sessionId: 'S28',
      messages: [sys, user('u1', 'hello')],
    }),
  )
  await collect(
    adapter.stream({
      ...base,
      sessionId: 'S29',
      messages: [sys, user('u1', 'hello')],
    }),
  )
  const records = mcps().slice(-2)
  assert.equal(records.length, 2)
  const [first, second] = records
  const post = (url, authorization, body) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(authorization !== undefined ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    })

  // Tenant A's secret is rejected on Tenant B's endpoint.
  const cross = await post(second.url, first.authorization, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  })
  assert.equal(cross.status, 401)

  // The tenant-less root path never exposes tools/list, even with a valid secret.
  const rootUrl = new URL(second.url)
  rootUrl.pathname = '/mcp'
  const root = await post(rootUrl.href, second.authorization, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  })
  assert.equal(root.status, 401)

  // A valid tenant whose conversationId names another session fails with a tenant mismatch.
  const forged = await post(first.url, first.authorization, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'bash',
      arguments: { command: 'ls' },
      _meta: { 'antigravity.google/conversation_id': 's1-forged' },
    },
  })
  assert.equal(forged.status, 200)
  const forgedText = await forged.text()
  assert.match(forgedText, /Tenant session mismatch/)
  assert.match(forgedText, /"isError":true/)

  // The genuine tenant still lists its own tools.
  const own = await post(second.url, second.authorization, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/list',
    params: {},
  })
  assert.equal(own.status, 200)
  const ownBody = await own.json()
  assert.ok(ownBody.result.tools.some((t) => t.name === 'pi_call_tool'))
})

test('a session reset revokes its tenant secret immediately', async (t) => {
  const { adapter, mcps } = makeRuntime(t)
  await collect(
    adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      tools: [bash],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'title this' }] },
      ],
    }),
  )
  const [record] = mcps().slice(-1)
  assert.ok(record.url, 'the anonymous session mounted the MCP bridge')
  const res = await fetch(record.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: record.authorization,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  })
  assert.equal(res.status, 401)
})

test('maxLiveSessions rejects overflow with CAPACITY_EXCEEDED and evicts the oldest idle session', async (t) => {
  const { adapter, runtime } = makeRuntime(t, { config: { maxLiveSessions: 2 } })
  const base = { provider: 'antigravity', model: 'gemini-4-argon', tools: [bash] }
  const stepA = await collect(
    adapter.stream({
      ...base,
      sessionId: 'CAP-A',
      messages: [sys, user('a', 'CALL bash {"command":"hold"}')],
    }),
  )
  await collect(
    adapter.stream({
      ...base,
      sessionId: 'CAP-B',
      messages: [sys, user('b', 'CALL bash {"command":"hold"}')],
    }),
  )
  assert.equal(runtime.status().activeTurns, 2)
  assert.ok(runtime.status().liveSessions <= 2)

  // The third concurrent session is rejected immediately instead of queueing.
  await assert.rejects(
    collect(
      adapter.stream({
        ...base,
        sessionId: 'CAP-C',
        messages: [sys, user('c', 'hello')],
      }),
    ),
    (error) =>
      error?.code === 'RATE_LIMIT' && /CAPACITY_EXCEEDED/.test(error.message),
  )
  assert.ok(runtime.status().liveSessions <= 2)

  // Once a live session finishes, a new one evicts the oldest idle and succeeds.
  const [callA] = callsOf(stepA)
  await collect(
    adapter.stream({
      ...base,
      sessionId: 'CAP-A',
      messages: [
        sys,
        user('a', 'x'),
        assistantFrom('a1', stepA),
        tool('t1', callA.id, 'done'),
      ],
    }),
  )
  const third = await collect(
    adapter.stream({
      ...base,
      sessionId: 'CAP-C',
      messages: [sys, user('c', 'hello')],
    }),
  )
  assert.equal(finishOf(third).reason.kind, 'stop')
  const live = runtime.status().liveSessions
  assert.ok(live <= 2, `liveSessions=${live} exceeded the cap`)
  assert.ok(runtime.conversations.has('CAP-C'))
})

test('dynamic tool additions, removals, and same-turn unlocks keep the ACP session alive and dispatch via pi_call_tool', async (t) => {
  const { adapter, prompts } = makeRuntime(t)
  const session = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S18',
  }
  const toolList = {
    name: 'tool_list',
    description: 'Open a tool group',
    parameters: {
      type: 'object',
      properties: { group: { type: 'string' } },
      required: ['group'],
    },
  }
  const preview = {
    name: 'preview_page',
    description: 'Preview a page URL',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  }

  // Scenario A: same-turn unlock during deliverResults immediately allows pi_call_tool without session rebuild.
  const turn1Prompt = [
    'CALL tool_list {"group":"ui"}',
    'CALL pi_call_tool {"name":"preview_page","arguments":{"url":"http://127.0.0.1:3000"}}',
  ].join('\n')
  const s1 = await collect(
    adapter.stream({
      ...session,
      tools: [toolList],
      messages: [sys, user('u1', turn1Prompt)],
    }),
  )
  assert.equal(finishOf(s1).reason.kind, 'tool-calls')
  const [c1] = callsOf(s1)
  assert.equal(c1.name, 'tool_list')
  assert.deepEqual(prompts()[0].tools, [
    'tool_list',
    'pi_await_result',
    'pi_call_tool',
  ])

  let hist = [
    sys,
    user('u1', turn1Prompt),
    assistantFrom('a1', s1),
    tool('t1', c1.id, 'opened ui'),
  ]
  const s2 = await collect(
    adapter.stream({ ...session, tools: [toolList, preview], messages: hist }),
  )
  assert.equal(finishOf(s2).reason.kind, 'tool-calls')
  const [c2] = callsOf(s2)
  assert.equal(c2.name, 'preview_page')
  assert.deepEqual(JSON.parse(c2.arguments), { url: 'http://127.0.0.1:3000' })

  hist = [...hist, assistantFrom('a2', s2), tool('t2', c2.id, 'preview-ready')]
  const s3 = await collect(
    adapter.stream({ ...session, tools: [toolList, preview], messages: hist }),
  )
  assert.equal(finishOf(s3).reason.kind, 'stop')
  assert.equal(
    prompts().length,
    1,
    'same-turn unlock resumed the live ACP turn without sending a second prompt',
  )
  assert.match(
    textOf(s3),
    /<harness_tool_update>[\s\S]*tool available via mcp_pi_pi_call_tool with \{"name":"preview_page"/,
  )
  assert.match(textOf(s3), /RESULT\(pi_call_tool\)=preview-ready/)

  // Scenario B: cross-turn tool addition sends <harness_tool_update>, keeps the same ACP session, and has no <pi_history>.
  hist = [
    ...hist,
    assistantFrom('a3', s3),
    user(
      'u2',
      'CALL pi_call_tool {"name":"read_file","arguments":{"path":"README.md"}}',
    ),
  ]
  const s4 = await collect(
    adapter.stream({
      ...session,
      tools: [toolList, preview, read],
      messages: hist,
    }),
  )
  assert.equal(finishOf(s4).reason.kind, 'tool-calls')
  assert.equal(prompts()[1].session, prompts()[0].session)
  assert.doesNotMatch(prompts()[1].text, /<pi_history>/)
  assert.match(
    prompts()[1].text,
    /^<harness_tool_update>\n\[tool available via mcp_pi_pi_call_tool with \{"name":"read_file"/,
  )
  assert.deepEqual(
    prompts()[1].tools,
    ['tool_list', 'pi_await_result', 'pi_call_tool'],
    'advertised MCP tool prefix stays frozen',
  )
  const [c3] = callsOf(s4)
  assert.equal(c3.name, 'read_file')
  hist = [...hist, assistantFrom('a4', s4), tool('t3', c3.id, 'readme-body')]
  const s5 = await collect(
    adapter.stream({
      ...session,
      tools: [toolList, preview, read],
      messages: hist,
    }),
  )
  assert.equal(finishOf(s5).reason.kind, 'stop')
  assert.equal(textOf(s5), 'RESULT(pi_call_tool)=readme-body')

  // Scenario C: removing tools notifies <harness_tool_update> and rejects pi_call_tool without rebuilding the session.
  hist = [
    ...hist,
    assistantFrom('a5', s5),
    user(
      'u3',
      'CALL pi_call_tool {"name":"read_file","arguments":{"path":"README.md"}}',
    ),
  ]
  const s6 = await collect(
    adapter.stream({ ...session, tools: [], messages: hist }),
  )
  assert.equal(finishOf(s6).reason.kind, 'stop')
  assert.equal(prompts()[2].session, prompts()[0].session)
  assert.doesNotMatch(prompts()[2].text, /<pi_history>/)
  assert.match(prompts()[2].text, /\[tool disabled: read_file\]/)
  assert.match(prompts()[2].text, /\[tool disabled: tool_list\]/)
  assert.match(textOf(s6), /The harness has no tool named read_file/)

  // Scenario D: re-enabling an initially advertised tool emits [tool restored: ...] on the same session.
  hist = [
    ...hist,
    assistantFrom('a6', s6),
    user('u4', 'CALL tool_list {"group":"core"}'),
  ]
  const s7 = await collect(
    adapter.stream({ ...session, tools: [toolList], messages: hist }),
  )
  assert.equal(finishOf(s7).reason.kind, 'tool-calls')
  assert.equal(prompts()[3].session, prompts()[0].session)
  assert.match(prompts()[3].text, /\[tool restored: mcp_pi_tool_list\]/)
  const [c4] = callsOf(s7)
  hist = [...hist, assistantFrom('a7', s7), tool('t4', c4.id, 'restored-ok')]
  const s8 = await collect(
    adapter.stream({ ...session, tools: [toolList], messages: hist }),
  )
  assert.equal(textOf(s8), 'RESULT(tool_list)=restored-ok')

  // Scenario E: a main session opened with no initial tools still mounts the MCP bridge for later dynamic tools.
  const emptyInit = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S18-empty',
  }
  const e1 = await collect(
    adapter.stream({
      ...emptyInit,
      tools: [],
      messages: [sys, user('eu1', 'hello')],
    }),
  )
  assert.deepEqual(prompts().at(-1).tools, ['pi_await_result', 'pi_call_tool'])
  const eHist = [
    sys,
    user('eu1', 'hello'),
    assistantFrom('ea1', e1),
    user(
      'eu2',
      'CALL pi_call_tool {"name":"bash","arguments":{"command":"echo hi"}}',
    ),
  ]
  const e2 = await collect(
    adapter.stream({ ...emptyInit, tools: [bash], messages: eHist }),
  )
  assert.equal(finishOf(e2).reason.kind, 'tool-calls')
  assert.equal(prompts().at(-1).session, prompts().at(-2).session)
  const [ec] = callsOf(e2)
  const e3 = await collect(
    adapter.stream({
      ...emptyInit,
      tools: [bash],
      messages: [...eHist, assistantFrom('ea2', e2), tool('et1', ec.id, 'hi')],
    }),
  )
  assert.equal(textOf(e3), 'RESULT(pi_call_tool)=hi')
})


test('Windows preflight locates agy.exe in LOCALAPPDATA and PATH while skipping IDE shims and non-executable wrappers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-win-preflight-'))
  const ideBin = join(root, 'Programs', 'Antigravity', 'bin')
  const pathBin = join(root, 'custom-bin')
  const localAppData = join(root, 'AppData', 'Local')
  mkdirSync(ideBin, { recursive: true })
  mkdirSync(pathBin, { recursive: true })
  // Extensionless IDE shell shim and .cmd wrapper must not match on win32.
  writeFileSync(join(ideBin, 'agy'), '#!/bin/sh\n')
  writeFileSync(join(ideBin, 'agy.cmd'), '@echo off\r\n')
  const pathAgyExe = join(pathBin, 'agy.exe')
  writeFileSync(pathAgyExe, 'MZ')

  assert.equal(
    resolveAgyBinary('', {
      platform: 'win32',
      home: root,
      env: { LOCALAPPDATA: localAppData, Path: `${ideBin};"${pathBin}"` },
    }),
    pathAgyExe,
  )

  const defaultWinExe = join(localAppData, 'agy', 'bin', 'agy.exe')
  mkdirSync(dirname(defaultWinExe), { recursive: true })
  writeFileSync(defaultWinExe, 'MZ')
  assert.equal(
    resolveAgyBinary('', {
      platform: 'win32',
      home: root,
      env: { LOCALAPPDATA: localAppData, PATH: `${ideBin};${pathBin}` },
    }),
    defaultWinExe,
  )

  assert.throws(
    () => assertSupportedAgyVersion('1.2.7', defaultWinExe),
    /1\.2\.7.*agy update/,
  )
  assert.doesNotThrow(() => assertSupportedAgyVersion('1.5.2', defaultWinExe))
  assert.doesNotThrow(() =>
    assertSupportedAgyVersion('Antigravity CLI 1.5.2', defaultWinExe),
  )
  assert.doesNotThrow(() =>
    assertSupportedAgyVersion('fake-agy 0.0.1', defaultWinExe),
  )

  // File-backed OAuth token sync seeds isolated home and updates only when source is newer.
  const cliAuthDir = join(root, '.gemini', 'antigravity-cli')
  const isolatedHome = join(root, '.pi', 'cache', 'antigravity-acp')
  mkdirSync(cliAuthDir, { recursive: true })
  const srcToken = join(cliAuthDir, 'antigravity-oauth-token')
  const dstToken = join(isolatedHome, 'agy', 'antigravity-oauth-token')
  writeFileSync(srcToken, 'token-v1')
  utimesSync(srcToken, 1_700_000_100, 1_700_000_100)
  prepareHome(isolatedHome, root)
  assert.equal(readFileSync(dstToken, 'utf8'), 'token-v1')

  // Newer refreshed token in isolated home is preserved over older CLI token.
  writeFileSync(dstToken, 'token-refreshed')
  utimesSync(dstToken, 1_700_000_200, 1_700_000_200)
  syncOAuthToken(isolatedHome, root)
  assert.equal(readFileSync(dstToken, 'utf8'), 'token-refreshed')

  // Fresh terminal `agy` sign-in updates isolated home when source mtime advances.
  writeFileSync(srcToken, 'token-v3')
  utimesSync(srcToken, 1_700_000_300, 1_700_000_300)
  syncOAuthToken(isolatedHome, root)
  assert.equal(readFileSync(dstToken, 'utf8'), 'token-v3')
})

test('multi-turn tool calls mint distinct session-wide IDs', async (t) => {
  const { adapter } = makeRuntime(t)
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S-unique',
    tools: [bash],
  }
  let history = [sys]
  const seenCallIds = new Set()
  const runTurn = async (turnIdx) => {
    history = [
      ...history,
      user(`u${turnIdx}`, `CALL bash {"command":"echo turn-${turnIdx}"}`),
    ]
    const step1 = await collect(adapter.stream({ ...base, messages: history }))
    assert.equal(finishOf(step1).reason.kind, 'tool-calls')
    const [call] = callsOf(step1)
    assert.match(
      call.id,
      /^agy_[0-9a-f]{12}_1$/,
      'ToolCallId uses [a-z0-9_] only for cross-provider safety',
    )
    assert.equal(
      seenCallIds.has(call.id),
      false,
      `turn ${turnIdx} repeated ToolCallId ${call.id}`,
    )
    seenCallIds.add(call.id)

    history = [
      ...history,
      assistantFrom(`a${turnIdx}-1`, step1),
      tool(`t${turnIdx}`, call.id, `out-${turnIdx}`),
    ]
    const step2 = await collect(adapter.stream({ ...base, messages: history }))
    assert.equal(finishOf(step2).reason.kind, 'stop')
    history = [...history, assistantFrom(`a${turnIdx}-2`, step2)]
  }
  await runTurn(1)
  await runTurn(2)
  await runTurn(3)
  assert.equal(seenCallIds.size, 3)
})

test('last turn reports both transport failures and provider error outcomes', async (t) => {
  const { runtime } = makeRuntime(t)
  const proc = await runtime.ensureReady()
  const prompt = t.mock.method(proc, 'prompt', async () => ({ stopReason: 'refusal' }))
  prompt.mock.mockImplementationOnce(async () => {
    throw new Error('Prompt transport failed')
  })
  const request = {
    model: 'gemini-4-argon',
    sessionId: 'STATUS-ERROR',
    messages: [sys, user('error', 'hello')],
  }
  await assert.rejects(
    collect(runtime.stream(request)),
    /Prompt transport failed/,
  )
  assert.equal(runtime.status().lastTurn.outcome, 'error')
  assert.ok(runtime.status().lastTurn.durationMs >= 0)
  const chunks = await collect(runtime.stream(request))
  assert.equal(finishOf(chunks).reason.kind, 'error')
  assert.equal(runtime.status().lastTurn.outcome, 'error')
})

test('dispose cancels blocked preflight without resurrecting shared startup', { timeout: 1_500 }, async (t) => {
  const entered = deferred()
  const resume = deferred()
  let spawned = 0
  const { runtime } = makeRuntime(t, { host: {
    runCommand: async () => {
      entered.resolve()
      await resume.promise
      return { code: 0, stdout: 'fake-agy 0.0.1', stderr: '' }
    },
    spawnAcp: () => { spawned++; throw new Error('unexpected spawn') },
  } })
  const first = runtime.ensureReady()
  const second = runtime.ensureReady()
  const failures = Promise.all([assert.rejects(first, /disposed/), assert.rejects(second, /disposed/)])
  await entered.promise
  try {
    await Promise.all([runtime.dispose(), runtime.dispose(), failures])
  } finally {
    resume.resolve()
  }
  await failures
  assert.equal(spawned, 0)
  assert.equal(runtime.process, undefined)
  assert.equal(runtime.bridge.server, undefined)
})

test('dispose drains bridge binding before closing its listener', async (t) => {
  const { runtime } = makeRuntime(t)
  const entered = deferred()
  const resume = deferred()
  const bind = runtime.bridge.start.bind(runtime.bridge)
  t.mock.method(runtime.bridge, 'start', async () => {
    entered.resolve()
    await resume.promise
    await bind()
  })
  const startup = assert.rejects(runtime.ensureReady(), /disposed/)
  await entered.promise
  const disposal = runtime.dispose()
  assert.equal(disposal, runtime.dispose())
  resume.resolve()
  await Promise.all([startup, disposal])
  assert.equal(runtime.bridge.server, undefined)
  assert.equal(runtime.process, undefined)
})

test('dispose stops a child blocked in the ACP initialize RPC', { timeout: 1_500 }, async (t) => {
  const entered = deferred()
  const exited = deferred()
  let terminated = 0
  const { runtime } = makeRuntime(t, { host: { spawnAcp: () => ({
    stdin: new Writable({ write(_data, _encoding, done) { entered.resolve(); done() } }),
    stdout: new PassThrough(),
    exited: exited.promise,
    terminate: () => { terminated++ },
    stderrTail: () => '',
  }) } })
  const startup = assert.rejects(runtime.ensureReady(), /disposed/)
  await entered.promise
  const initializing = runtime.process
  assert.ok(initializing)
  try {
    await Promise.all([runtime.dispose(), startup])
    assert.equal(exited.settled, false)
    assert.equal(initializing.peer.pending.size, 0)
    assert.equal(initializing.listeners.size, 0)
    assert.ok(terminated >= 1)
    assert.equal(initializing.alive, false)
    assert.equal(runtime.process, undefined)
    assert.equal(runtime.bridge.server, undefined)
  } finally {
    exited.resolve({ code: 0, signal: null })
    await runtime.dispose()
  }
})

function sendWireResult(request, wire, result) {
  wire.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
}

function exitBeforeWireReply(request, wire, result) {
  wire.exited.resolve({ code: 1, signal: null })
  sendWireResult(request, wire, result)
}

function exitAfterWireReply(request, wire, result) {
  sendWireResult(request, wire, result)
  wire.exited.resolve({ code: 1, signal: null })
}

function scriptedChild(exchanges) {
  const wire = { stdout: new PassThrough(), exited: deferred() }
  const methods = {
    initialize: (request) => sendWireResult(request, wire, {}),
    'session/close': (request) => sendWireResult(request, wire, {}),
    'session/cancel': () => {},
    ...exchanges,
  }
  return {
    stdout: wire.stdout, exited: wire.exited.promise, stderrTail: () => '',
    terminate: () => wire.exited.resolve({ code: 0, signal: null }),
    stdin: new Writable({ write(data, _encoding, done) {
      const request = JSON.parse(data)
      assert.equal(typeof methods[request.method], 'function', `unexpected wire method ${request.method}`)
      methods[request.method](request, wire)
      done()
    } }),
  }
}

function sessionWireResult(home, id) {
  mkdirSync(join(home, 'agy', 'conversations'), { recursive: true })
  writeFileSync(join(home, 'agy', 'conversations', `${id}.db`), 'session')
  return { sessionId: id, configOptions: [],
    models: { availableModels: [{ modelId: 'obsolete-model', name: 'Obsolete' }] },
    _meta: { antigravity: { tier: { name: 'Obsolete' } } } }
}

function selectionExchange(configId, action, configOptions = []) {
  return (request, wire) => {
    assert.equal(request.params.configId, configId)
    action(request, wire, { configOptions })
  }
}

function makeWireRuntime(t, sessionAction, selections = []) {
  const spawnAcp = t.mock.fn()
  const fixture = makeRuntime(t, { config: { maxLiveSessions: 1 }, host: { spawnAcp } })
  const old = scriptedChild({
    'session/new': (request, wire) => sessionAction(request, wire, sessionWireResult(fixture.home, 'late-1')),
    'session/set_config_option': (request, wire) => selections.shift()(request, wire),
  })
  const replacement = scriptedChild({
    'session/new': (request, wire) => sendWireResult(request, wire, sessionWireResult(fixture.home, 'late-2')),
    'session/set_config_option': selectionExchange('model', sendWireResult),
    'session/prompt': (request, wire) => {
      wire.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: request.params.sessionId, update: { sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'recovered' } },
      } }) + '\n')
      sendWireResult(request, wire, { stopReason: 'end_turn' })
    },
  })
  const children = [old, replacement]
  spawnAcp.mock.mockImplementation(() => children.shift())
  return { ...fixture, spawnAcp }
}

async function assertWireLoss(fixture, old, request) {
  const { runtime } = fixture
  await assert.rejects(collect(runtime.stream(request)), { code: 'TRANSPORT' })
  assert.equal(runtime.process, undefined)
  assert.equal(old.alive, false)
  assert.equal(old.listeners.size, 0)
  assert.equal(old.peer.pending.size, 0)
  assert.equal(runtime.conversations.size, 0)
  assert.equal(runtime.tenants.size, 0)
  assert.equal(runtime.status().liveSessions, 0)
  assert.equal(runtime.status().activeTurns, 0)
}

async function assertWireRecovery(fixture, request) {
  const { runtime, spawnAcp } = fixture
  const next = await collect(runtime.stream(request))
  assert.equal(textOf(next), 'recovered')
  assert.equal(finishOf(next).reason.kind, 'stop')
  assert.equal(spawnAcp.mock.callCount(), 2)
  const replacement = runtime.conversations.get(request.sessionId)
  assert.equal(replacement.process, runtime.process)
  assert.equal(replacement.process.alive, true)
  assert.equal(replacement.sessionId, 'late-2')
  assert.equal(runtime.tenants.size, 1)
  assert.equal(replacement.process.listeners.size, 1)
}

async function assertSessionReplyLoss(t, action) {
  const fixture = makeWireRuntime(t, action)
  const { runtime, home } = fixture
  const old = await runtime.ensureReady()
  const request = { model: 'gemini-4-argon', sessionId: 'owner', messages: [sys, user('u1', 'hello')] }
  await assertWireLoss(fixture, old, request)
  assert.equal(existsSync(join(home, 'agy', 'conversations', 'late-1.db')), false)
  assert.equal(runtime.catalog.observed, false)
  assert.equal(runtime.catalog.tier(), undefined)
  assert.equal(existsSync(join(home, 'catalog.json')), false)
  await assertWireRecovery(fixture, request)
}

async function assertSelectionReplyLoss(t, selections) {
  const fixture = makeWireRuntime(t, sendWireResult, selections)
  const old = await fixture.runtime.ensureReady()
  const request = { model: 'gemini-4-argon', sessionId: 'owner', reasoningEffort: 'high', messages: [sys, user('u1', 'hello')] }
  await assertWireLoss(fixture, old, request)
  await assertWireRecovery(fixture, { ...request, sessionId: 'second' })
}

test('a buffered session/new reply cannot register a listener after stop', async (t) => {
  const child = scriptedChild({ 'session/new': (request, wire) => {
    sendWireResult(request, wire, { sessionId: 'buffered' })
    proc.stop()
  } })
  const proc = new AcpProcess({ argv: [], cwd: tmpdir(), clientName: 'test', clientVersion: '1', spawn: () => child })
  t.after(() => proc.stop())
  await proc.start(1_500)
  assert.deepEqual(await proc.newSession({}, { onUpdate() {} }, 1_500), { sessionId: 'buffered' })
  assert.equal(proc.alive, false)
  assert.equal(proc.listeners.size, 0)
  assert.equal(proc.peer.pending.size, 0)
})

test('session installation rejects exit before buffered reply', t => assertSessionReplyLoss(t, exitBeforeWireReply))
test('session installation rejects exit after buffered reply', t => assertSessionReplyLoss(t, exitAfterWireReply))

test('model selection rejects exit before buffered reply', t => assertSelectionReplyLoss(t, [
  selectionExchange('model', exitBeforeWireReply),
]))
test('model selection rejects exit after buffered reply', t => assertSelectionReplyLoss(t, [
  selectionExchange('model', exitAfterWireReply),
]))
test('thinking selection rejects exit before buffered reply', t => assertSelectionReplyLoss(t, [
  selectionExchange('model', sendWireResult, [{ id: 'thought_level', currentValue: 'low' }]),
  selectionExchange('thought_level', exitBeforeWireReply),
]))
test('thinking selection rejects exit after buffered reply', t => assertSelectionReplyLoss(t, [
  selectionExchange('model', sendWireResult, [{ id: 'thought_level', currentValue: 'low' }]),
  selectionExchange('thought_level', exitAfterWireReply),
]))

test('dispose rolls back a session/new reply that was already received', async (t) => {
  const { runtime, home } = makeRuntime(t)
  const proc = await runtime.ensureReady()
  const newSession = proc.newSession.bind(proc)
  const entered = deferred()
  const resume = deferred()
  let id
  t.mock.method(proc, 'newSession', async (...args) => {
    const result = await newSession(...args)
    id = result.sessionId
    entered.resolve()
    await resume.promise
    return result
  })
  const request = assert.rejects(collect(runtime.stream({
    model: 'gemini-4-argon', sessionId: 'closing', messages: [sys, user('closing', 'hello')],
  })), /disposed/)
  await entered.promise
  assert.equal(runtime.tenants.size, 1)
  await runtime.dispose()
  resume.resolve()
  await request
  assert.equal(runtime.conversations.size, 0)
  assert.equal(runtime.tenants.size, 0)
  assert.equal(proc.alive, false)
  assert.equal(proc.listeners.size, 0)
  assert.equal(existsSync(join(home, 'agy', 'conversations', `${id}.db`)), false)
})

async function assertDisposedLockWaiter(t, selectMutex, key) {
  const { runtime } = makeRuntime(t)
  const proc = await runtime.ensureReady()
  const mutex = selectMutex(runtime)
  const release = await mutex.acquire(key)
  t.after(release)
  const entered = deferred()
  const acquire = mutex.acquire.bind(mutex)
  t.mock.method(mutex, 'acquire', (...args) => {
    const waiting = acquire(...args)
    entered.resolve()
    return waiting
  })
  const request = assert.rejects(collect(runtime.stream({ model: 'gemini-4-argon', sessionId: 'queued',
    messages: [sys, user('queued', 'hello')] })), /disposed/)
  await entered.promise
  await runtime.dispose()
  await request
  assert.equal(runtime.conversations.size, 0)
  assert.equal(runtime.tenants.size, 0)
  assert.equal(proc.alive, false)
}

test('dispose rejects a conversation lock waiter before release', t =>
  assertDisposedLockWaiter(t, runtime => runtime.mutex, 'queued'))
test('dispose rejects a capacity lock waiter before release', t =>
  assertDisposedLockWaiter(t, runtime => runtime.capacityMutex, 'capacity'))

test('normal concurrent startup shares one initialized child', async (t) => {
  const { runtime, inits } = makeRuntime(t)
  const [first, second] = await Promise.all([runtime.ensureReady(), runtime.ensureReady()])
  assert.equal(first, second)
  assert.equal(first.alive, true)
  assert.equal(inits().length, 1)
  await runtime.dispose()
  await assert.rejects(runtime.ensureReady(), /disposed/)
  await assert.rejects(runtime.warmup(), /disposed/)
  await assert.rejects(runtime.readQuota(), /disposed/)
})

test('cancelling the last lock waiter cannot bypass the current holder', async () => {
  const { KeyedMutex } = await import('../src/util.ts')
  const mutex = new KeyedMutex()
  const release = await mutex.acquire('key')
  const controller = new AbortController()
  const cancelled = assert.rejects(mutex.acquire('key', controller.signal), /cancelled/)
  controller.abort(new Error('cancelled'))
  await cancelled
  let acquired = false
  const next = mutex.acquire('key').then((unlock) => { acquired = true; unlock() })
  await new Promise(setImmediate)
  assert.equal(acquired, false)
  release()
  await next
  assert.equal(acquired, true)
})

test('dispose drains discovery and discards its late catalog result', async (t) => {
  const { runtime } = makeRuntime(t)
  const proc = await runtime.ensureReady()
  const newSession = proc.newSession.bind(proc)
  const entered = deferred(), resume = deferred()
  t.mock.method(proc, 'newSession', async (...args) => {
    const result = await newSession(...args)
    entered.resolve()
    await resume.promise
    return result
  })
  const warmup = assert.rejects(runtime.warmup(), /disposed/)
  await entered.promise
  const disposal = runtime.dispose()
  resume.resolve()
  await Promise.all([warmup, disposal])
  assert.equal(runtime.catalog.observed, false)
  assert.equal(proc.alive, false)
  assert.equal(proc.listeners.size, 0)
  assert.equal(runtime.bridge.server, undefined)
})

test('dispose during capacity eviction cannot register a replacement conversation', async (t) => {
  const { runtime } = makeRuntime(t, { config: { maxLiveSessions: 1 } })
  await collect(runtime.stream({
    model: 'gemini-4-argon', sessionId: 'old', messages: [sys, user('old', 'hello')],
  }))
  const proc = await runtime.ensureReady()
  const close = proc.closeSession.bind(proc)
  const entered = deferred(), resume = deferred()
  t.mock.method(proc, 'closeSession', async (...args) => {
    entered.resolve()
    await resume.promise
    await close(...args)
  })
  const request = assert.rejects(collect(runtime.stream({
    model: 'gemini-4-argon', sessionId: 'new', messages: [sys, user('new', 'hello')],
  })), /disposed/)
  await entered.promise
  await runtime.dispose()
  resume.resolve()
  await request
  assert.equal(runtime.conversations.size, 0)
  assert.equal(runtime.tenants.size, 0)
})

test('dispose during model selection cannot start a prompt', async (t) => {
  const { runtime, prompts } = makeRuntime(t)
  const proc = await runtime.ensureReady()
  const entered = deferred(), resume = deferred()
  t.mock.method(proc, 'setConfigOption', async () => {
    entered.resolve()
    await resume.promise
    return []
  })
  const request = assert.rejects(collect(runtime.stream({
    model: 'claude-sonnet-5-5', sessionId: 'selecting', messages: [sys, user('selecting', 'hello')],
  })), /disposed/)
  await entered.promise
  await runtime.dispose()
  resume.resolve()
  await request
  assert.equal(prompts().length, 0)
  assert.equal(runtime.conversations.size, 0)
})

test('parked cancellation settles bridge calls and releases capacity without a follow-up', async (t) => {
  const { runtime } = makeRuntime(t, { config: { maxLiveSessions: 1 } })
  const controller = new AbortController()
  const request = { model: 'gemini-4-argon', sessionId: 'park-owner', tools: [bash],
    signal: controller.signal, messages: [sys, user('u1', 'CALL bash {"command":"long"}')] }
  await collect(runtime.stream(request))
  const conv = runtime.conversations.get(request.sessionId)
  const turn = conv.turn
  const pending = [...turn.calls.values()]
  assert.equal(pending.length, 1)
  controller.abort()
  assert.equal(runtime.status().activeTurns, 0)
  assert.equal((await pending[0].result.promise).isError, true)
  const chunks = await collect(runtime.stream({ model: request.model, sessionId: 'second', messages: [sys, user('u2', 'hello')] }))
  assert.equal(finishOf(chunks).reason.kind, 'stop')
})

test('tool-result microtask cancellation finishes aborted and recovers capacity', async (t) => {
  const { runtime } = makeRuntime(t, { config: { maxLiveSessions: 1 } })
  const controller = new AbortController()
  const request = { model: 'gemini-4-argon', sessionId: 'resume-owner', tools: [bash],
    signal: controller.signal, messages: [sys, user('u1', 'CALL bash {"command":"long"}')] }
  const first = await collect(runtime.stream(request))
  const conv = runtime.conversations.get(request.sessionId)
  const turn = conv.turn
  const [call] = turn.pendingCalls.values()
  // Resolve the tool first, then abort before the resuming caller's next microtask.
  const cancelled = call.result.promise.then(() => controller.abort())
  const chunks = await collect(runtime.stream({ ...request, messages: [
    ...request.messages, assistantFrom('a1', first), tool('t1', call.id, 'finished'),
  ] }))
  await cancelled
  assert.deepEqual(chunks.map(chunk => chunk.type), ['finish'])
  assert.equal(finishOf(chunks).reason.kind, 'aborted')
  assert.equal(conv.turn, undefined)
  assert.equal(turn.cancellation.signal.aborted, true)
  assert.equal(turn.releaseSignal, undefined)
  assert.equal(runtime.status().activeTurns, 0)
  assert.equal(runtime.status().lastTurn.outcome, 'aborted')
  const next = await collect(runtime.stream({ model: request.model, sessionId: 'second',
    messages: [sys, user('u2', 'hello')] }))
  assert.equal(finishOf(next).reason.kind, 'stop')
})

test('already-aborted follow-up settles only its own parked session', async (t) => {
  const { runtime } = makeRuntime(t)
  const request = { model: 'gemini-4-argon', tools: [bash], messages: [sys, user('u1', 'CALL bash {"command":"long"}')] }
  await collect(runtime.stream({ ...request, sessionId: 'one' }))
  await collect(runtime.stream({ ...request, sessionId: 'two' }))
  const other = runtime.conversations.get('two').turn
  const chunks = await collect(runtime.stream({ ...request, sessionId: 'one', signal: AbortSignal.abort() }))
  assert.equal(finishOf(chunks).reason.kind, 'aborted')
  assert.equal(runtime.conversations.get('one').turn, undefined)
  assert.equal(runtime.conversations.get('two').turn, other)
  runtime.settleSession('two')
  assert.equal(runtime.status().activeTurns, 0)
})

test('early iterator closure abandons a running turn before its first tool call', async (t) => {
  const { runtime } = makeRuntime(t)
  const stream = runtime.stream({ model: 'gemini-4-argon', sessionId: 'closed', tools: [bash],
    messages: [sys, user('u1', 'CALL bash {"command":"long"}')] })
  await stream.next()
  const turn = runtime.conversations.get('closed').turn
  await stream.return()
  assert.equal(runtime.status().activeTurns, 0)
  assert.equal(turn.cancellation.signal.aborted, true)
  assert.equal(turn.releaseSignal, undefined)
  assert.equal(turn.pendingCalls.size, 0)
})

test('early iterator closure at the handoff finish abandons its tool waiter', async (t) => {
  const { runtime } = makeRuntime(t)
  const stream = runtime.stream({ model: 'gemini-4-argon', sessionId: 'closed', tools: [bash],
    messages: [sys, user('u1', 'CALL bash {"command":"long"}')] })
  const before = await Promise.all([stream.next(), stream.next(), stream.next(), stream.next(), stream.next(), stream.next(), stream.next()])
  assert.equal(before.at(-1).value.reason.kind, 'tool-calls')
  const turn = runtime.conversations.get('closed').turn
  const [call] = turn.calls.values()
  await stream.return()
  assert.equal(runtime.status().activeTurns, 0)
  assert.equal((await call.result.promise).isError, true)
  assert.equal(turn.pendingCalls.size, 0)
  assert.equal(turn.releaseSignal, undefined)
})

async function assertBufferedCancellation(t, seed) {
  const { runtime } = makeRuntime(t)
  const conv = runtime.createConversation('buffered')
  const turn = conv.turn = new AcpTurn('buffered')
  const assertWaiters = seed(turn)
  const chunks = await collect(runtime.pump(conv, turn, { cancel() {} }, { model: 'test', signal: AbortSignal.abort() }, 'high'))
  assert.equal(chunks.length, 1)
  assert.equal(finishOf(chunks).reason.kind, 'aborted')
  assert.equal(conv.turn, undefined)
  await assertWaiters()
}

test('cancellation beats buffered text at runtime entry', t => assertBufferedCancellation(t, queueTerminalText))
test('cancellation beats buffered park at runtime entry', t => assertBufferedCancellation(t, queueTerminalTool))
test('cancellation beats buffered done at runtime entry', t => assertBufferedCancellation(t, queueTerminalDone))

test('old cancellation signals cannot cancel replacement turns', async (t) => {
  const { runtime } = makeRuntime(t)
  const conv = runtime.createConversation('replacement')
  const old = conv.turn = new AcpTurn('old')
  const controller = new AbortController()
  const call = old.park('bash', {})
  await collect(runtime.pump(conv, old, { cancel() {} }, { model: 'test', signal: controller.signal }, 'high'))
  runtime.dropTurn(conv, 'replaced')
  const replacement = conv.turn = new AcpTurn('new')
  controller.abort()
  old.events.push({ kind: 'done', result: { stopReason: 'cancelled' } })
  assert.equal(conv.turn, replacement)
  assert.equal((await call.result.promise).isError, true)
})

test('a parked tool survives sweeping regardless of elapsed idle time and resumes', async (t) => {
  const { runtime, prompts } = makeRuntime(t, { config: { idleSessionTtlMs: 1 } })
  const request = { model: 'gemini-4-argon', sessionId: 'long-tool', tools: [bash], messages: [sys, user('u1', 'CALL bash {"command":"long"}')] }
  const first = await collect(runtime.stream(request))
  const conv = runtime.conversations.get(request.sessionId)
  conv.lastUsed = 0
  runtime.sweep()
  assert.equal(runtime.conversations.get(request.sessionId), conv)
  const next = await collect(runtime.stream({ ...request, messages: [...request.messages, assistantFrom('a1', first), tool('t1', callsOf(first)[0].id, 'finished')] }))
  assert.equal(textOf(next), 'RESULT(bash)=finished')
  assert.equal(prompts().length, 1)
})

test('settling a session wakes a pending MCP await-result handler', async (t) => {
  const { runtime } = makeRuntime(t)
  const request = { model: 'gemini-4-argon', sessionId: 'mcp-waiter', tools: [bash],
    messages: [sys, user('u1', 'CALL bash {"command":"long"}')] }
  const chunks = await collect(runtime.stream(request))
  const conv = runtime.conversations.get(request.sessionId)
  const waiter = runtime.callTool({ tenantKey: conv.tenantKey, name: 'pi_await_result',
    arguments: { call_id: callsOf(chunks)[0].id }, signal: new AbortController().signal })
  runtime.settleSession(request.sessionId)
  assert.equal((await waiter).isError, true)
})

test('late session callbacks and old signals cannot modify a replacement ACP session', async (t) => {
  const { runtime } = makeRuntime(t)
  const proc = await runtime.ensureReady()
  const open = proc.newSession.bind(proc)
  const callbacks = []
  t.mock.method(proc, 'newSession', (params, handlers, timeout) => {
    callbacks.push(handlers)
    return open(params, handlers, timeout)
  })
  const oldSignal = new AbortController()
  const request = { model: 'gemini-4-argon', sessionId: 'same', tools: [bash],
    messages: [sys, user('u1', 'CALL bash {"command":"long"}')] }
  await collect(runtime.stream({ ...request, signal: oldSignal.signal }))
  runtime.settleSession('same')
  await collect(runtime.stream(request))
  const conv = runtime.conversations.get('same')
  const replacement = conv.turn
  const queued = replacement.events.size
  oldSignal.abort()
  callbacks[0].onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale' } })
  callbacks[0].onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'stale', kind: 'execute' })
  assert.equal(conv.turn, replacement)
  assert.equal(replacement.events.size, queued)
  assert.equal(conv.reportedToolCalls.has('stale'), false)
  assert.deepEqual(callbacks[0].onPermission({}), { outcome: 'cancelled' })
})

test('cancellation during the parallel-tool batching boundary suppresses the handoff', async (t) => {
  const { runtime } = makeRuntime(t)
  const conv = runtime.createConversation('batch-cancel')
  const turn = conv.turn = new AcpTurn('batch')
  const call = turn.park('bash', {})
  const controller = new AbortController()
  const wait = t.mock.method(turn.events, 'wait', turn.events.wait.bind(turn.events))
  wait.mock.mockImplementationOnce(async () => { controller.abort(); return false }, 1)
  const chunks = await collect(runtime.pump(conv, conv.turn, { cancel() {} }, { model: 'test', signal: controller.signal }, 'high'))
  assert.deepEqual(chunks.map(c => c.type), ['finish'])
  assert.equal(finishOf(chunks).reason.kind, 'aborted')
  assert.equal((await call.result.promise).isError, true)
})


async function dispatchFixture(t) {
  const { runtime } = makeRuntime(t, { config: { maxLiveSessions: 1 } })
  const proc = await runtime.ensureReady()
  const request = { model: 'gemini-4-argon', sessionId: 'dispatch', tools: [bash], messages: [sys, user('u1', 'hello')] }
  return { runtime, proc, request }
}

async function prepareToolContinuation(fixture) {
  const { runtime, request } = fixture
  request.messages = [sys, user('u1', 'CALL bash {"command":"long"}')]
  const first = await collect(runtime.stream(request))
  const turn = runtime.conversations.get(request.sessionId).turn
  const [call] = turn.pendingCalls.values()
  turn.finished = true
  request.messages.push(assistantFrom('a1', first), tool('t1', call.id, 'done'))
}

async function assertDispatchRecovery(fixture, prompt) {
  const { runtime, request } = fixture
  assert.equal(runtime.status().activeTurns, 0)
  assert.equal(runtime.status().lastTurn.outcome, 'error')
  assert.equal(runtime.conversations.get(request.sessionId)?.turn, undefined)
  prompt.mock.restore()
  const next = await collect(runtime.stream({ ...request, sessionId: 'second', messages: [sys, user('u2', 'hello')] }))
  assert.equal(finishOf(next).reason.kind, 'stop')
}
test('synchronous prompt dispatch throw cleans a new turn', async (t) => {
  const fixture = await dispatchFixture(t)
  const { runtime, proc, request } = fixture
  const failure = new Error('synchronous dispatch failure')
  const prompt = t.mock.method(proc, 'prompt', () => {
    throw failure
  })
  await assert.rejects(collect(runtime.stream(request)), error => error.code === 'TRANSPORT' && error.cause === failure)
  await assertDispatchRecovery(fixture, prompt)
})

test('synchronous prompt dispatch exit then throw cleans a tool-continuation turn', async (t) => {
  const fixture = await dispatchFixture(t)
  await prepareToolContinuation(fixture)
  const { runtime, proc, request } = fixture
  const failure = new Error('synchronous dispatch failure')
  const prompt = t.mock.method(proc, 'prompt', () => {
    proc.stop()
    throw failure
  })
  await assert.rejects(collect(runtime.stream(request)), { code: 'TRANSPORT', message: 'Antigravity ACP process exited: ACP process stopped' })
  await assertDispatchRecovery(fixture, prompt)
})

test('process loss releases parked ownership and its waiter', async (t) => {
  const { runtime } = makeRuntime(t, { config: { maxLiveSessions: 1 } })
  const request = { model: 'gemini-4-argon', sessionId: 'lost-process', tools: [bash],
    messages: [sys, user('u1', 'CALL bash {"command":"long"}')] }
  await collect(runtime.stream(request))
  const conv = runtime.conversations.get(request.sessionId), turn = conv.turn
  const [call] = turn.calls.values()
  conv.process.stop()
  assert.equal(conv.turn, undefined)
  assert.equal(turn.cancellation.signal.aborted, false)
  assert.equal(turn.releaseSignal, undefined)
  assert.equal(runtime.status().activeTurns, 0)
  assert.equal((await call.result.promise).isError, true)
  const next = await collect(runtime.stream({ ...request, sessionId: 'second', messages: [sys, user('u2', 'hello')] }))
  assert.equal(finishOf(next).reason.kind, 'stop')
})

test('process loss keeps a running failure distinct from abort and recovers capacity', async (t) => {
  const { runtime } = makeRuntime(t, { config: { maxLiveSessions: 1 } })
  const request = { model: 'gemini-4-argon', sessionId: 'lost-process', tools: [bash],
    messages: [sys, user('u1', 'CALL bash {"command":"long"}')] }
  const stream = runtime.stream(request)
  await stream.next()
  const conv = runtime.conversations.get(request.sessionId), turn = conv.turn
  conv.process.stop()
  assert.equal(conv.turn, undefined)
  assert.equal(turn.cancellation.signal.aborted, false)
  assert.equal(turn.releaseSignal, undefined)
  assert.equal(runtime.status().activeTurns, 0)
  await assert.rejects(stream.next(), { code: 'TRANSPORT' })
  assert.equal(runtime.status().lastTurn.outcome, 'error')
  const next = await collect(runtime.stream({ ...request, sessionId: 'second', messages: [sys, user('u2', 'hello')] }))
  assert.equal(finishOf(next).reason.kind, 'stop')
})

test('conversation ownership lasts through asynchronous step cleanup', async (t) => {
  const { runtime } = makeRuntime(t, { config: { maxLiveSessions: 1 } })
  const proc = await runtime.ensureReady()
  const entered = deferred(), resume = deferred()
  const close = proc.closeSession.bind(proc)
  t.mock.method(proc, 'closeSession', async (...args) => {
    entered.resolve()
    await resume.promise
    return close(...args)
  })
  const request = { model: 'gemini-4-argon', sessionId: 'anon-cleanup',
    messages: [sys, user('u1', 'hello')] }
  const first = collect(runtime.stream(request))
  await entered.promise
  let acquired = false
  const lease = runtime.mutex.acquire(request.sessionId).then(release => {
    acquired = true
    return release
  })
  try {
    await new Promise(setImmediate)
    assert.equal(acquired, false, 'a replacement cannot enter before old session cleanup finishes')
  } finally {
    resume.resolve()
    await first
    const release = await lease
    release()
  }
  const second = await collect(runtime.stream({ ...request, sessionId: 'second' }))
  assert.equal(finishOf(second).reason.kind, 'stop')
  assert.equal(runtime.conversations.get('second').process, runtime.process)
})

test('process exit during tool block-start rejects the handoff and recovers capacity', async (t) => {
  const { runtime } = makeRuntime(t, { config: { maxLiveSessions: 1 } })
  const stream = runtime.stream({ model: 'gemini-4-argon', sessionId: 'exit-handoff', tools: [bash],
    messages: [sys, user('u1', 'CALL bash {"command":"long"}')] })
  const before = await Promise.all([stream.next(), stream.next(), stream.next(), stream.next()])
  assert.equal(before.at(-1).done, false)
  assert.equal(before.at(-1).value.type, 'block-start')
  assert.equal(before.at(-1).value.blockType, 'tool-call')
  const conv = runtime.conversations.get('exit-handoff')
  const turn = conv.turn
  const [call] = turn.calls.values()
  const proc = conv.process
  const exited = new Promise(resolve => proc.onExit(resolve))
  proc.child.terminate()
  await exited
  assert.equal(conv.turn, undefined)
  await assert.rejects(stream.next(), { code: 'TRANSPORT', message: /process exited/ })
  assert.equal((await stream.next()).done, true)
  assert.equal(turn.toolSteps, 0)
  assert.equal(turn.pendingCalls.size, 0)
  assert.equal(turn.releaseSignal, undefined)
  assert.equal((await call.result.promise).isError, true)
  assert.equal(runtime.status().lastTurn.outcome, 'error')
  assert.equal(runtime.status().activeTurns, 0)
  const second = await collect(runtime.stream({ model: 'gemini-4-argon', sessionId: 'second',
    messages: [sys, user('u2', 'hello')] }))
  assert.equal(finishOf(second).reason.kind, 'stop')
})

test('process exit during tool batching rejects before emission and recovers capacity', async (t) => {
  const { runtime } = makeRuntime(t, { config: { maxLiveSessions: 1 } })
  const proc = await runtime.ensureReady()
  const conv = runtime.createConversation('exit-batch')
  conv.process = proc
  conv.sessionId = 'exit-batch'
  const turn = conv.turn = new AcpTurn('batch')
  const call = turn.park('bash', {})
  const wait = t.mock.method(turn.events, 'wait', turn.events.wait.bind(turn.events))
  wait.mock.mockImplementationOnce(async () => { proc.stop(); return false }, 1)
  const stream = runtime.pump(conv, turn, proc, { model: 'test' }, 'high')
  await assert.rejects(stream.next(), { code: 'TRANSPORT' })
  assert.equal(wait.mock.calls[1].arguments[1], runtime.host.config.parkSettleMs)
  assert.equal((await stream.next()).done, true)
  assert.equal(turn.toolSteps, 0)
  assert.equal(turn.pendingCalls.size, 0)
  assert.equal((await call.result.promise).isError, true)
  assert.equal(runtime.status().lastTurn.outcome, 'error')
  const second = await collect(runtime.stream({ model: 'gemini-4-argon', sessionId: 'second',
    messages: [sys, user('u2', 'hello')] }))
  assert.equal(finishOf(second).reason.kind, 'stop')
})

function queueTerminalTool(turn) {
  const call = turn.park('bash', {})
  return async () => assert.equal((await call.result.promise).isError, true)
}

function queueTerminalText(turn) {
  turn.events.push({ kind: 'text', text: 'output' })
  turn.events.push({ kind: 'done', result: { stopReason: 'end_turn', usage: { outputTokens: 1 } } })
  return async () => assert.equal(turn.calls.size, 0)
}

function queueTerminalDone(turn) {
  turn.events.push({ kind: 'done', result: { stopReason: 'end_turn' } })
  return async () => assert.equal(turn.calls.size, 0)
}

async function assertTerminalBoundary(t, seed, advance, expectedType, toolSteps = 0, issuedIds = 0) {
  const { runtime } = makeRuntime(t)
  const proc = await runtime.ensureReady()
  const conv = runtime.createConversation('boundary')
  conv.process = proc
  conv.sessionId = 'boundary'
  const turn = conv.turn = new AcpTurn('boundary')
  const assertWaiters = seed(turn)
  const stream = runtime.pump(conv, turn, proc, { model: 'test' }, 'high')
  const reached = (await advance(stream)).at(-1)
  assert.equal(reached.done, false)
  assert.equal(reached.value.type, expectedType)
  assert.equal(conv.issuedIds.size, issuedIds)
  proc.stop()
  await assert.rejects(stream.next(), { code: 'TRANSPORT' })
  assert.equal((await stream.next()).done, true)
  assert.equal(runtime.status().lastTurn.outcome, 'error')
  assert.equal(turn.pendingCalls.size, 0)
  assert.equal(conv.turn, undefined)
  await assertWaiters()
  assert.equal(turn.toolSteps, toolSteps)
}

test('terminal failure after tool yield 1 (block-start)', t =>
  assertTerminalBoundary(t, queueTerminalTool, stream => Promise.all([stream.next()]), 'block-start', 0))

test('terminal failure after tool yield 3 (block-end)', t =>
  assertTerminalBoundary(t, queueTerminalTool, stream => Promise.all([stream.next(), stream.next(), stream.next()]), 'block-end', 0, 1))

test('terminal failure after tool yield 4 (finish)', t =>
  assertTerminalBoundary(t, queueTerminalTool, stream => Promise.all([stream.next(), stream.next(), stream.next(), stream.next()]), 'finish', 1, 1))

async function assertFailureFirst(seed) {
  const turn = new AcpTurn('failure-first')
  const assertWaiters = seed(turn)
  const error = new Error('original failure')
  const controller = new AbortController()
  const stream = pumpStep(turn, { parkSettleMs: 0, maxContinuations: 0, cancel() {},
    continuePrompt() { assert.fail('no continuation') } }, controller.signal)
  turn.fail(error)
  turn.fail(new Error('later failure'))
  controller.abort()
  await assert.rejects(stream.next(), value => value === error)
  assert.equal(turn.cancellation.signal.aborted, false)
  assert.equal(turn.pendingCalls.size, 0)
  await assertWaiters()
}

async function assertCancellationFirst(seed) {
  const turn = new AcpTurn('cancel-first')
  const assertWaiters = seed(turn)
  const stream = pumpStep(turn, { parkSettleMs: 0, maxContinuations: 0, cancel() {},
    continuePrompt() { assert.fail('no continuation') } }, undefined)
  turn.abandon('cancelled first')
  turn.fail(new Error('later failure'))
  const chunks = await collect(stream)
  assert.equal(chunks.length, 1)
  assert.equal(finishOf(chunks).reason.kind, 'aborted')
  assert.equal(turn.pendingCalls.size, 0)
  await assertWaiters()
}

test('first interruption failure beats queued park and cancellation', () => assertFailureFirst(queueTerminalTool))
test('first interruption cancellation beats queued park and failure', () => assertCancellationFirst(queueTerminalTool))

test('terminal failure in the generator delivery microtask precedes runtime accounting', async (t) => {
  const { runtime } = makeRuntime(t)
  const proc = await runtime.ensureReady()
  const conv = runtime.createConversation('delivery-gap')
  conv.process = proc
  conv.sessionId = 'delivery-gap'
  const turn = conv.turn = new AcpTurn('delivery-gap')
  const call = turn.park('bash', {})
  const stream = runtime.pump(conv, turn, proc, { model: 'test' }, 'high')
  assert.equal((await stream.next()).value.type, 'block-start')
  assert.equal((await stream.next()).value.type, 'tool-call-delta')
  const guard = turn.guard.bind(turn)
  const mocked = t.mock.method(turn, 'guard', guard)
  mocked.mock.mockImplementationOnce((chunk, signal) => {
    const guarded = guard(chunk, signal)
    queueMicrotask(() => proc.stop())
    return guarded
  }, 1)
  await assert.rejects(stream.next(), { code: 'TRANSPORT' })
  assert.equal(mocked.mock.calls[1].arguments[0].type, 'block-end')
  assert.equal(conv.issuedIds.size, 0)
  assert.equal(turn.toolSteps, 0)
  assert.equal((await call.result.promise).isError, true)
  assert.equal(runtime.status().lastTurn.outcome, 'error')
})

test('obsolete process and prompt callbacks cannot poison a replacement turn', async (t) => {
  const { runtime } = makeRuntime(t)
  const oldProc = await runtime.ensureReady()
  oldProc.stop()
  const proc = await runtime.ensureReady()
  const conv = runtime.createConversation('replacement-terminal')
  conv.process = proc
  conv.sessionId = 'replacement-terminal'
  const old = conv.turn = new AcpTurn('old')
  runtime.dropTurn(conv, 'replaced')
  const replacement = conv.turn = new AcpTurn('new')
  old.fail(new Error('late prompt rejection'))
  runtime.onProcessExit(oldProc, new Error('late child exit'))
  assert.equal(runtime.process, proc)
  assert.equal(runtime.status().state, 'ready')
  assert.equal(conv.turn, replacement)
  replacement.events.push({ kind: 'text', text: 'replacement output' })
  replacement.events.push({ kind: 'done', result: { stopReason: 'end_turn' } })
  const chunks = await collect(runtime.pump(conv, replacement, proc, { model: 'test' }, 'high'))
  assert.equal(textOf(chunks), 'replacement output')
  assert.equal(finishOf(chunks).reason.kind, 'stop')
})

test('terminal failure during a long-decode continuation retains its original rejection', async () => {
  const turn = new AcpTurn('continuation')
  const result = deferred()
  const dispatched = deferred()
  const stream = pumpStep(turn, { parkSettleMs: 0, maxContinuations: 1, cancel() {},
    continuePrompt() { dispatched.resolve(); return result.promise } }, undefined)
  turn.events.push({ kind: 'done', result: { stopReason: 'max_tokens' } })
  const next = stream.next()
  await dispatched.promise
  const call = turn.park('bash', {})
  const error = new Error('original continuation failure')
  result.reject(error)
  await turn.promptSettled
  await assert.rejects(next, value => value === error)
  assert.equal(turn.toolSteps, 0)
  assert.equal(turn.pendingCalls.size, 0)
  assert.equal((await call.result.promise).isError, true)
  assert.equal(turn.cancellation.signal.aborted, false)
})

test('synchronous continuation failure preserves the first terminal event', async () => {
  const turn = new AcpTurn('continuation-throw')
  const original = new Error('original transport failure')
  const later = new Error('later synchronous throw')
  const call = turn.park('bash', {})
  turn.events.shift() // Keep a waiter without a tool handoff ahead of the continuation.
  turn.events.push({ kind: 'done', result: { stopReason: 'max_tokens' } })
  const stream = pumpStep(turn, { parkSettleMs: 0, maxContinuations: 1, cancel() {},
    continuePrompt() {
      turn.fail(original)
      throw later
    } }, undefined)
  await assert.rejects(stream.next(), error => error === original)
  assert.equal((await call.result.promise).isError, true)
  assert.equal(turn.pendingCalls.size, 0)
  assert.equal(turn.toolSteps, 0)
})

test('JSON-RPC invalid error objects reject the affected request without throwing and keep the link open', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const protocolErrors = []
  const rpc = new JsonRpcPeer(input, output, {
    onNotification() {},
    async onRequest() { return null },
    onProtocolError(message) { protocolErrors.push(message) },
  })
  const first = rpc.request('session/prompt', {})
  const second = rpc.request('session/prompt', {})
  input.write('{"jsonrpc":"2.0","id":1,"error":null}\n')
  await assert.rejects(first, { message: 'session/prompt: invalid error response' })
  input.write('{"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n')
  assert.deepEqual(await second, { ok: true })
  assert.equal(protocolErrors.length, 1)
  rpc.close(new Error('done'))
})

test('parked-turn model or effort change abandons the old turn and rebuilds on the requested selection', async (t) => {
  const { runtime, prompts } = makeRuntime(t)
  const firstRequest = {
    model: 'gemini-4-argon',
    reasoningEffort: 'high',
    sessionId: 'switch-parked',
    tools: [bash],
    messages: [sys, user('u1', 'CALL bash {"command":"pwd"}')],
  }
  const first = await collect(runtime.stream(firstRequest))
  const call = first.find((c) => c.type === 'block-end' && c.block.type === 'tool-call').block
  const second = await collect(runtime.stream({
    ...firstRequest,
    model: 'claude-opus-5-5',
    reasoningEffort: 'low',
    messages: [
      ...firstRequest.messages,
      assistant('a1', [{ type: 'tool-call', id: call.id, name: 'bash', arguments: call.arguments }]),
      { id: 'tr1', role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: '/tmp' }] },
    ],
  }))
  assert.equal(finishOf(second).reason.kind, 'tool-calls')
  const entries = prompts()
  assert.equal(entries.length, 2)
  assert.notEqual(entries[0].session, entries[1].session)
  assert.equal(entries[1].model, 'claude-opus-5-5')
  assert.equal(entries[1].level, 'low')
  const conv = runtime.conversations.get('switch-parked')
  assert.equal(conv.model, 'claude-opus-5-5')
  assert.equal(conv.effort, 'low')
})

test('multi-call relay preserves buffered output once all relayed calls are awaited', async () => {
  const turn = new AcpTurn('relay-multi')
  const c1 = turn.park('bash', { command: 'a' })
  const c2 = turn.park('bash', { command: 'b' })
  turn.events.shift()
  turn.events.shift()
  turn.markRelayed(c1.id)
  turn.markRelayed(c2.id)
  turn.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'buffered ' } })
  turn.resumeRelay(c1.id)
  assert.equal(turn.isRelaying, true)
  assert.equal(turn.events.peek(), undefined)
  turn.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'text' } })
  turn.resumeRelay(c2.id)
  assert.equal(turn.isRelaying, false)
  turn.events.push({ kind: 'done', result: { stopReason: 'end_turn' } })
  const chunks = await collect(pumpStep(turn, {
    parkSettleMs: 0, maxContinuations: 0,
    continuePrompt: async () => ({ stopReason: 'end_turn' }), cancel() {},
  }, undefined))
  assert.equal(textOf(chunks), 'buffered text')
  assert.equal(finishOf(chunks).reason.kind, 'stop')
})

test('premature completion while relayed calls remain unawaited fails with PROVIDER_ERROR', async () => {
  const turn = new AcpTurn('relay-premature')
  const call = turn.park('bash', { command: 'a' })
  turn.events.shift()
  turn.produced = true
  turn.markRelayed(call.id)
  turn.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ungrounded' } })
  turn.events.push({ kind: 'done', result: { stopReason: 'end_turn' } })
  await assert.rejects(
    collect(pumpStep(turn, {
      parkSettleMs: 0, maxContinuations: 0,
      continuePrompt: async () => ({ stopReason: 'end_turn' }), cancel() {},
    }, undefined)),
    { code: 'PROVIDER_ERROR' },
  )
  assert.equal(turn.isRelaying, false)
})

test('dynamic tool updates distinguish restored vs modified schemas and preserve compacted initial instructions', () => {
  const longDesc = `${'Detailed tool instruction. '.repeat(60)}UNIQUE_TAIL_MARKER`
  const initialRaw = toBridgeTools([
    { name: 'bash', description: longDesc, parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  ])
  const compacted = initialRaw.map(compactBridgeTool)
  assert.notEqual(digest(compacted[0]), digest(initialRaw[0]))
  const promptText = bridgeSystemPrompt('base', initialRaw)
  assert.match(promptText, /<harness_tool_instructions>/)
  assert.match(promptText, /UNIQUE_TAIL_MARKER/)

  const conv = {
    advertisedToolDigests: new Map(initialRaw.map((tool) => [tool.name, digest(tool)])),
    knownTools: new Map(initialRaw.map((tool) => [tool.name, digest(tool)])),
  }
  assert.equal(consumeToolDelta(conv, initialRaw), '')
  assert.match(consumeToolDelta(conv, []), /\[tool disabled: bash\]/)
  assert.match(consumeToolDelta(conv, initialRaw), /\[tool restored: mcp_pi_bash\]/)

  const tailChanged = toBridgeTools([
    { name: 'bash', description: `${longDesc}_CHANGED`, parameters: initialRaw[0].inputSchema },
  ])
  const tailDelta = consumeToolDelta(conv, tailChanged)
  assert.match(tailDelta, /pi_call_tool/)
  assert.match(tailDelta, /UNIQUE_TAIL_MARKER_CHANGED/)

  const schemaChanged = toBridgeTools([
    { name: 'bash', description: longDesc, parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] } },
  ])
  const schemaDelta = consumeToolDelta(conv, schemaChanged)
  assert.match(schemaDelta, /pi_call_tool/)
  assert.match(schemaDelta, /"script"/)
})

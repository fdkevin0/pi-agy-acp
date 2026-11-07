// End-to-end tests of the runtime against the scripted fake ACP agent.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdtempSync,
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
import {
  AntigravityRuntime,
  compactBridgeTool,
  DEFAULT_RELAY_AFTER_MS,
  MAX_EAGER_BRIDGE_TOOL_BYTES,
} from '../src/runtime.ts'
import { defaults } from '../src/config.ts'
const Config = (values) => ({ ...defaults, ...values })
import { toTokenUsage } from '../src/conversation.ts'
import {
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
const runtimes = []

function makeRuntime(extra = {}) {
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
  runtimes.push(runtime)
  const prompts = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : []
  const inits = () =>
    existsSync(initLog)
      ? readFileSync(initLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : []
  const mcps = () =>
    existsSync(mcpLog)
      ? readFileSync(mcpLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : []
  return { home, runtime, prompts, inits, mcps, adapter: runtime }
}

after(async () => {
  for (const r of runtimes) await r.dispose()
})

test('ACP tier metadata reaches the catalog through discovery and normal sessions', async () => {
  const discovery = makeRuntime()
  await discovery.runtime.warmup()
  assert.deepEqual(discovery.runtime.catalog.tier(), {
    id: 'test-ultra',
    name: 'Google AI Ultra',
  })
  assert.equal(discovery.prompts().length, 0)
  assert.equal(discovery.runtime.status().liveSessions, 0)
  const normal = makeRuntime()
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

test('single turn streams reasoning, text, exact usage, and the selected model and effort', async () => {
  const { adapter, prompts } = makeRuntime()
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
})

test('a tool call parks, ends the step, and resumes the same ACP turn with the Pi result', async () => {
  const { adapter, prompts } = makeRuntime()
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

test('parallel tool calls arrive as one Pi step', async () => {
  const { adapter } = makeRuntime()
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

test('changed history rebuilds the session with a transcript replay', async () => {
  const { adapter, prompts } = makeRuntime()
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

test('a compaction rewrite while a tool call is parked rebuilds instead of resuming the stale turn', async () => {
  const { adapter, prompts } = makeRuntime()
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

test('append-only tool results still resume the parked turn in the same ACP session', async () => {
  const { adapter, prompts } = makeRuntime()
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S23',
    tools: [bash],
  }
  const step1 = await collect(
    adapter.stream({
      ...base,
      messages: [sys, user('u1', 'CALL bash {"command":"pwd"}')],
    }),
  )
  assert.equal(finishOf(step1).reason.kind, 'tool-calls')
  const [call] = callsOf(step1)
  const history = [
    sys,
    user('u1', 'CALL bash {"command":"pwd"}'),
    assistantFrom('a1', step1),
    tool('t1', call.id, '/workspace'),
  ]
  const step2 = await collect(adapter.stream({ ...base, messages: history }))
  assert.equal(finishOf(step2).reason.kind, 'stop')
  assert.equal(textOf(step2), 'RESULT(bash)=/workspace')
  assert.equal(
    prompts().length,
    1,
    'append-only history resumes in place without opening a new session',
  )
})

test('an empty-input rebuild sends a non-empty continuation prompt after <pi_history>', async () => {
  const { adapter, prompts } = makeRuntime()
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

test('subagent sessions run concurrently while the parent waits on a tool', async () => {
  const { adapter } = makeRuntime()
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
  const status = runtimes.at(-1).status()
  assert.equal(status.activeTurns, 2)
})

test('a tool that outlives the MCP deadline is relayed through pi_await_result', async () => {
  const { adapter } = makeRuntime({ host: { relayAfterMs: 150 } })
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
  await new Promise((r) => setTimeout(r, 700))
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
  assert.ok(adapter.status().lastTurn.durationMs >= 700)
})

test('steering input after tool results reaches the agent with the last result', async () => {
  const { adapter } = makeRuntime()
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

test('cancellation aborts the step and the next turn rebuilds', async () => {
  const { adapter, prompts } = makeRuntime()
  const controller = new AbortController()
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S7',
  }
  setTimeout(() => controller.abort(), 150)
  const chunks = await collect(
    adapter.stream({
      ...base,
      signal: controller.signal,
      messages: [sys, user('u1', 'SLEEP 2000')],
    }),
  )
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

test('an output-length stop continues automatically (long decode)', async () => {
  const { adapter } = makeRuntime()
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
})

test('images in user input are sent as ACP image blocks', async () => {
  const { adapter, prompts } = makeRuntime()
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

test('agent transport retry notices never reach the model output', async () => {
  const { adapter } = makeRuntime()
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

test('agy output-limit continuation notices never reach the model output', async () => {
  const { adapter } = makeRuntime()
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

test('bounded replay drops the oldest history, closes the block, and keeps the latest input intact', async () => {
  const { adapter, prompts } = makeRuntime()
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

test('the ACP client identifies itself as pi-agy-acp', async () => {
  const { adapter, inits } = makeRuntime()
  await collect(
    adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      sessionId: 'S13',
      messages: [sys, user('u1', 'hello')],
    }),
  )
  assert.equal(inits()[0].clientInfo.name, 'pi-agy-acp')
})

test('Claude honors the requested thinking level', async () => {
  const { adapter, prompts } = makeRuntime()
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

test('a fixed-effort family still runs at medium without a thought_level write', async () => {
  const { adapter, prompts } = makeRuntime()
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

test('oversized tool schemas compact below agy eager cutoff and pi_call_tool dispatches native calls', async () => {
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

  const { adapter } = makeRuntime()
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

test('permission gate rejects spoofed native tools and grants genuinely reported bridge calls', async () => {
  const { adapter } = makeRuntime()
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

test('the permission gate binds the loading probe to a handshake and keeps identities across updates', async () => {
  const { adapter } = makeRuntime()
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

test('a session whose agent never completed the MCP handshake refuses identity-less probes', async () => {
  const { adapter } = makeRuntime({ env: { FAKE_AGY_NO_HANDSHAKE: '1' } })
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

test('permission requests naming another session are refused', async () => {
  const { adapter } = makeRuntime()
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

test('the MCP bridge enforces per-tenant bearer secrets and drops the conversationId fallback', async () => {
  const { adapter, mcps } = makeRuntime()
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

test('a session reset revokes its tenant secret immediately', async () => {
  const { adapter, mcps } = makeRuntime()
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

test('maxLiveSessions rejects overflow with CAPACITY_EXCEEDED and evicts the oldest idle session', async () => {
  const { adapter, runtime } = makeRuntime({ config: { maxLiveSessions: 2 } })
  const base = { provider: 'antigravity', model: 'gemini-4-argon' }
  const slow1 = collect(
    adapter.stream({
      ...base,
      sessionId: 'CAP-A',
      messages: [sys, user('a', 'SLEEP 300')],
    }),
  )
  const slow2 = collect(
    adapter.stream({
      ...base,
      sessionId: 'CAP-B',
      messages: [sys, user('b', 'SLEEP 300')],
    }),
  )
  for (let i = 0; i < 100 && runtime.status().activeTurns < 2; i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
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
  await Promise.all([slow1, slow2])
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

test('dynamic tool additions, removals, and same-turn unlocks keep the ACP session alive and dispatch via pi_call_tool', async () => {
  const { adapter, prompts } = makeRuntime()
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

test('Config defaults relayAfterMs to 85_000ms and config.relayAfterMs overrides the relay threshold', async () => {
  assert.equal(DEFAULT_RELAY_AFTER_MS, 85_000)
  const defaults = Config({})
  assert.equal(defaults.relayAfterMs, 85_000)
  const custom = Config({ relayAfterMs: 60_000 })
  assert.equal(custom.relayAfterMs, 60_000)

  const { adapter } = makeRuntime({ config: { relayAfterMs: 120 } })
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S19',
    tools: [bash],
  }
  const step1 = await collect(
    adapter.stream({
      ...base,
      messages: [sys, user('u1', 'CALL bash {"command":"slow"}')],
    }),
  )
  const [call] = callsOf(step1)
  await new Promise((r) => setTimeout(r, 450))
  const step2 = await collect(
    adapter.stream({
      ...base,
      messages: [
        sys,
        user('u1', 'x'),
        assistantFrom('a1', step1),
        tool('t1', call.id, 'relayed-by-config'),
      ],
    }),
  )
  assert.equal(textOf(step2), 'RESULT(bash)=relayed-by-config')
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

test('multi-turn tool calls mint distinct session-wide IDs', async () => {
  const { adapter } = makeRuntime()
  const base = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S-unique',
    tools: [bash],
  }
  let history = [sys]
  const seenCallIds = new Set()

  for (let turnIdx = 1; turnIdx <= 3; turnIdx++) {
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
  assert.equal(seenCallIds.size, 3)
})

test('last turn reports both transport failures and provider error outcomes', async (t) => {
  const { runtime } = makeRuntime()
  const proc = await runtime.ensureReady()
  let rejectPrompt = true
  t.mock.method(proc, 'prompt', async () => {
    if (rejectPrompt) throw new Error('Prompt transport failed')
    return { stopReason: 'refusal' }
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
  rejectPrompt = false
  const chunks = await collect(runtime.stream(request))
  assert.equal(finishOf(chunks).reason.kind, 'error')
  assert.equal(runtime.status().lastTurn.outcome, 'error')
})

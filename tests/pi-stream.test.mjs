import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { streamPi, requestMessages } from '../src/pi-stream.ts'
import { AntigravityRuntime, mapError } from '../src/runtime.ts'
import { LlmError } from '../src/protocol.ts'
import { splitSystem, renderTranscript } from '../src/history.ts'
import {
  isContextOverflow,
  isRetryableAssistantError,
} from '@earendil-works/pi-ai'
import { defaults } from '../src/config.ts'
import { spawnAcp } from '../src/host.ts'
const model = {
  id: 'gemini-4-argon',
  provider: 'antigravity-acp',
  api: 'antigravity-acp',
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
const user = (text) => ({ role: 'user', content: text, timestamp: 1 })
const system = {
  role: 'system',
  content: 'Test',
  timestamp: 0,
  toolsAdded: [
    {
      name: 'bash',
      description: 'shell',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  ],
}
const context = (...messages) => ({ messages })
const options = { sessionId: 'pi-test' }
async function result(runtime, ctx, opts = options) {
  const events = []
  const stream = streamPi(runtime, model, ctx, opts)
  for await (const e of stream) events.push(e)
  return { message: await stream.result(), events }
}
test('Pi to ACP tool loop, next turn, rewritten history, usage and images', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pi-acp-'))
  const fake = resolve('tests/fake-agy.mjs')
  chmodSync(fake, 0o755)
  const runtime = new AntigravityRuntime({
    config: { ...defaults, command: fake, home },
    spawnAcp,
    runCommand: async () => ({ code: 0, stdout: '1.5.0', stderr: '' }),
    log: { info() {}, warn() {} },
    onModelsChanged() {},
  })
  try {
    const first = user('CALL bash {"command":"pwd"}')
    const a = await result(runtime, context(system, first))
    assert.equal(a.message.stopReason, 'toolUse', a.message.errorMessage)
    const call = a.message.content.find((b) => b.type === 'toolCall')
    assert.deepEqual(call.arguments, { command: 'pwd' })
    const tool = {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: 'bash',
      content: [{ type: 'text', text: '/tmp/pi' }],
      isError: false,
      timestamp: 2,
    }
    const b = await result(runtime, context(system, first, a.message, tool))
    assert.equal(b.message.stopReason, 'stop')
    assert.match(JSON.stringify(b.message.content), /\/tmp\/pi/)
    assert.ok(b.message.usage.totalTokens > 0)
    assert.equal(runtime.status().liveSessions, 1)
    const c = await result(
      runtime,
      context(system, first, a.message, tool, b.message, user('next')),
    )
    assert.equal(c.message.stopReason, 'stop')
    const d = await result(runtime, context(system, user('rewritten')))
    assert.equal(d.message.stopReason, 'stop')
    const image = { type: 'image', data: 'aW1n', mimeType: 'image/png' }
    const e = await result(
      runtime,
      context(system, { role: 'user', content: [image], timestamp: 3 }),
    )
    assert.equal(e.message.stopReason, 'stop')
    const assertSingleTerminal = (response) => {
      assert.equal(response.events[0].type, 'start')
      assert.equal(
        response.events.filter((e) => e.type === 'done' || e.type === 'error')
          .length,
        1,
      )
    }
    assertSingleTerminal(a)
    assertSingleTerminal(b)
    assertSingleTerminal(c)
    assertSingleTerminal(d)
    assertSingleTerminal(e)
  } finally {
    await runtime.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
test('digest detects content rewrites and preserves inline tool images and error flag', () => {
  assert.notEqual(
    requestMessages([user('a')])[0].id,
    requestMessages([user('b')])[0].id,
  )
  const msg = {
    role: 'toolResult',
    toolCallId: 'x',
    toolName: 'x',
    timestamp: 1,
    isError: true,
    content: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }],
  }
  const converted = requestMessages([msg])[0]
  assert.equal(converted.role, 'tool')
  assert.equal(converted.isError, true)
  assert.equal(converted.content[0].data, 'YWJj')
})
test('aborted requests terminate once', async () => {
  const controller = new AbortController()
  controller.abort()
  const runtime = {
    async *stream() {
      throw new Error('cancelled')
    },
  }
  const r = await result(runtime, context(user('hi')), {
    signal: controller.signal,
  })
  assert.equal(r.message.stopReason, 'aborted')
  assert.equal(r.events.at(-1).type, 'error')
})
test('payload replacement, raw events, Unicode and partial stream failure', async () => {
  let seen,
    observed = 0
  const runtime = {
    async *stream(request) {
      seen = request
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '你好🌏' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: '你好🌏' },
      }
    },
  }
  const r = await result(runtime, context(user('hi')), {
    onPayload: (p) => ({ ...p, model: 'replacement' }),
    onProviderStreamEvent: () => {
      observed++
    },
  })
  assert.equal(seen.model, 'replacement')
  assert.equal(observed, 3)
  assert.equal(r.message.content[0].text, '你好🌏')
  assert.equal(r.message.stopReason, 'error')
  assert.match(r.message.errorMessage, /without a finish/)
})


test('response instrumentation precedes events and pricing overrides update costs', async () => {
  const order = []
  const pricedModel = {
    ...model,
    cost: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 },
  }
  const runtime = {
    async *stream() {
      order.push('request')
      yield {
        type: 'usage',
        usage: {
          inputTokens: 1000000,
          outputTokens: 2000000,
          cacheReadTokens: 500000,
          cacheWriteTokens: 200000,
          totalTokens: 3700000,
        },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const stream = streamPi(runtime, pricedModel, context(user('hi')), {
    onPayload() {
      order.push('payload')
    },
    async onResponse(response, receivedModel) {
      assert.deepEqual(response, { status: 200, headers: {} })
      assert.equal(receivedModel, pricedModel)
      await Promise.resolve()
      order.push('response')
    },
    onProviderStreamEvent(event) {
      order.push(event.type)
    },
  })
  const message = await stream.result()
  assert.equal(message.stopReason, 'stop')
  assert.deepEqual(order, ['payload', 'request', 'response', 'usage', 'finish'])
  assert.deepEqual(message.usage.cost, {
    input: 2,
    output: 6,
    cacheRead: 2,
    cacheWrite: 1,
    total: 11,
    totalFromProvider: false,
  })
})

test('setup failure does not report a successful response', async () => {
  let responses = 0
  const r = await result(
    {
      async *stream() {
        throw new Error('startup failed')
      },
    },
    context(user('hi')),
    {
      onResponse() {
        responses++
      },
    },
  )
  assert.equal(r.message.stopReason, 'error')
  assert.equal(responses, 0)
})

test('leading system sections stay in the prompt and empty tool updates disappear', () => {
  const converted = requestMessages([
    system,
    { role: 'system', content: 'Second', sections: { rules: 'Keep it brief' } },
    user('hello'),
    { role: 'system', content: '  ', toolsRemoved: ['bash'] },
    { role: 'system', content: '', sections: { rules: 'Be precise' } },
  ])
  assert.equal(converted.length, 4)
  const split = splitSystem({ messages: converted })
  assert.match(split.system, /Second\n\nKeep it brief/)
  assert.doesNotMatch(split.system, /Updated system prompt section/)
  const transcript = renderTranscript(split.messages)
  assert.match(transcript, /Updated system prompt section "rules"/)
  assert.doesNotMatch(transcript, /<system_update>\s*<\/system_update>/)
})

test('timeout and cancellation cannot masquerade as overflow; quota and overflow reach Pi classifiers', async () => {
  assert.equal(mapError(new Error('context deadline exceeded')).code, 'TIMEOUT')
  assert.equal(mapError(new Error('context canceled')).code, 'TRANSPORT')
  assert.equal(
    mapError(new Error('context window limit exceeded')).code,
    'CONTEXT_WINDOW_EXCEEDED',
  )
  assert.equal(
    mapError(new Error('context limit reached')).code,
    'CONTEXT_WINDOW_EXCEEDED',
  )
  assert.equal(mapError(new Error('rate limit reached')).code, 'RATE_LIMIT')
  const overflow = await result(
    {
      async *stream() {
        throw new LlmError('Input is too large', 'CONTEXT_WINDOW_EXCEEDED')
      },
    },
    context(user('hi')),
  )
  assert.equal(
    overflow.message.errorMessage,
    'context_length_exceeded: Input is too large',
  )
  assert.equal(isContextOverflow(overflow.message), true)

  const quota = await result(
    {
      async *stream() {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: 'ResourceExhausted: weekly allowance',
              code: 'QUOTA',
            },
          },
        }
      },
    },
    context(user('hi')),
  )
  assert.equal(
    quota.message.errorMessage,
    'quota exceeded: ResourceExhausted: weekly allowance',
  )
  assert.equal(isRetryableAssistantError(quota.message), false)
})

test('an initial aborted finish does not report a synthetic successful response', async () => {
  let responses = 0
  const r = await result(
    {
      async *stream() {
        yield { type: 'finish', reason: { kind: 'aborted' } }
      },
    },
    context(user('hi')),
    {
      signal: AbortSignal.abort(),
      onResponse() {
        responses++
      },
    },
  )
  assert.equal(r.message.stopReason, 'aborted')
  assert.equal(responses, 0)
})


test('a direct provider callback failure closes the runtime iterator and abandons its turn', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pi-callback-'))
  const runtime = new AntigravityRuntime({
    config: { ...defaults, command: resolve('tests/fake-agy.mjs'), home },
    spawnAcp, runCommand: async () => ({ code: 0, stdout: '1.5.0', stderr: '' }),
    log: { info() {}, warn() {} }, onModelsChanged() {},
  })
  try {
    const { message } = await result(runtime, context(system, user('CALL bash {"command":"pwd"}')), {
      ...options, onProviderStreamEvent() { throw new Error('callback failed') },
    })
    assert.equal(message.stopReason, 'error')
    assert.match(message.errorMessage, /callback failed/)
    assert.equal(runtime.status().activeTurns, 0)
    assert.equal(runtime.conversations.get(options.sessionId).turn, undefined)
  } finally {
    await runtime.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('onPayload preserves routing metadata, inherits omitted tools, keeps empty tools, and rejects invalid payloads', async () => {
  const seen = []
  const runtime = {
    async *stream(request) {
      seen.push(request)
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const controller = new AbortController()
  const toolDef = { name: 'bash', description: 'run', parameters: { type: 'object' } }
  const ctx = {
    messages: [
      { role: 'system', content: 'sys', toolsAdded: [toolDef] },
      user('hi'),
    ],
  }
  await result(runtime, ctx, {
    sessionId: 'sess-1',
    signal: controller.signal,
    onPayload: (p) => ({ model: 'custom-model', messages: p.messages }),
  })
  assert.equal(seen[0].sessionId, 'sess-1')
  assert.equal(seen[0].signal, controller.signal)
  assert.equal(seen[0].tools.length, 1)

  await result(runtime, ctx, {
    sessionId: 'sess-2',
    signal: controller.signal,
    onPayload: (p) => ({ model: 'custom-model', messages: p.messages, tools: [] }),
  })
  assert.equal(seen[1].sessionId, 'sess-2')
  assert.deepEqual(seen[1].tools, [])

  const badNull = await result(runtime, ctx, { onPayload: () => null })
  assert.equal(badNull.message.stopReason, 'error')
  assert.match(badNull.message.errorMessage, /payload object/)

  const badModel = await result(runtime, ctx, { onPayload: () => ({ model: '', messages: [] }) })
  assert.equal(badModel.message.stopReason, 'error')
  assert.match(badModel.message.errorMessage, /non-empty string model/)

  const badMessages = await result(runtime, ctx, { onPayload: () => ({ model: 'm', messages: 'nope' }) })
  assert.equal(badMessages.message.stopReason, 'error')
  assert.match(badMessages.message.errorMessage, /messages array/)
})

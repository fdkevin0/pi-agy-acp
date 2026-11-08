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
    for (const response of [a, b, c, d, e]) {
      assert.equal(response.events[0].type, 'start')
      assert.equal(
        response.events.filter((e) => e.type === 'done' || e.type === 'error')
          .length,
        1,
      )
    }
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

test('all Pi reasoning levels map to supported ACP efforts', async () => {
  for (const [reasoning, expected] of [
    ['minimal', 'low'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'high'],
    ['max', 'high'],
    ['off', undefined],
    [undefined, undefined],
  ]) {
    let effort
    const runtime = {
      async *stream(request) {
        effort = request.reasoningEffort
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const r = await result(runtime, context(user('hi')), { reasoning })
    assert.equal(r.message.stopReason, 'stop')
    assert.equal(effort, expected, `reasoning=${reasoning}`)
  }
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
  for (const [code, text, prefix] of [
    [
      'CONTEXT_WINDOW_EXCEEDED',
      'Input is too large',
      'context_length_exceeded: ',
    ],
    ['QUOTA', 'ResourceExhausted: weekly allowance', 'quota exceeded: '],
    ['CONTEXT_WINDOW_EXCEEDED', 'context_length_exceeded: original', ''],
    ['QUOTA', 'insufficient_quota: original', ''],
  ]) {
    for (const terminal of ['throw', 'finish']) {
      const r = await result(
        {
          async *stream() {
            if (terminal === 'throw') throw new LlmError(text, code)
            yield {
              type: 'finish',
              reason: { kind: 'error', failure: { message: text, code } },
            }
          },
        },
        context(user('hi')),
      )
      assert.equal(r.message.errorMessage, prefix + text)
      if (code === 'CONTEXT_WINDOW_EXCEEDED')
        assert.equal(isContextOverflow(r.message), true)
      else assert.equal(isRetryableAssistantError(r.message), false)
    }
  }
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

test('fragmented tool JSON emits one start and reports malformed final arguments safely', async () => {
  for (const text of ['{"command":"pwd"}', '{"command":']) {
    const r = await result(
      {
        async *stream() {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          for (const piece of [text.slice(0, 5), text.slice(5)])
            yield {
              type: 'tool-call-delta',
              index: 0,
              id: 'call-1',
              name: 'bash',
              argumentsDelta: piece,
            }
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'call-1',
              name: 'bash',
              arguments: text,
            },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        },
      },
      context(user('hi')),
    )
    assert.equal(r.message.stopReason, 'toolUse')
    assert.equal(r.events.filter((e) => e.type === 'toolcall_start').length, 1)
    assert.equal(r.events.filter((e) => e.type === 'toolcall_delta').length, 2)
    assert.equal(r.events.filter((e) => e.type === 'toolcall_end').length, 1)
    if (text.endsWith('}'))
      assert.deepEqual(r.message.content[0].arguments, { command: 'pwd' })
    else assert.ok(r.message.content[0].argumentsError)
  }
})

import {
  createAssistantMessageEventStream,
  calculateCost,
  getCurrentTools,
  getSystemMessageText,
  renderSystemMessageUpdate,
  ToolCallArgumentsStream,
} from '@earendil-works/pi-ai'
import type {
  AssistantMessage,
  Message,
  Model,
  Api,
  SimpleStreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai'
import type {
  ContentBlock,
  GenerateOptions,
  RequestMessage,
  StreamChunk,
} from './protocol.ts'
import { LlmError } from './protocol.ts'
import { digest } from './util.ts'

export function requestMessages(messages: Message[]): RequestMessage[] {
  let leadingSystem = true
  return messages.flatMap<RequestMessage>((message) => {
    const id = digest(message)
    if (message.role === 'system') {
      const text = leadingSystem
        ? getSystemMessageText(message)
        : renderSystemMessageUpdate(message)
      if (!leadingSystem && text.trim().length === 0) return []
      return {
        id,
        role: 'system',
        content: [
          {
            type: 'text',
            text,
          },
        ],
      }
    }
    leadingSystem = false
    const content: ContentBlock[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content.map((block) => {
            switch (block.type) {
              case 'thinking':
                return { type: 'reasoning', text: block.thinking }
              case 'toolCall':
                return {
                  type: 'tool-call',
                  id: block.id,
                  name: block.name,
                  arguments: JSON.stringify(block.arguments),
                }
              default:
                return block
            }
          })
    if (message.role === 'toolResult')
      return {
        id,
        role: 'tool',
        toolCallId: message.toolCallId,
        isError: message.isError,
        content,
      }
    if (message.role === 'assistant')
      return {
        id,
        role: 'assistant',
        source: { kind: 'model', provider: message.provider },
        content,
      }
    return { id, role: 'user', content }
  })
}

function errorMessage(
  message: string | undefined,
  code?: string,
): string | undefined {
  if (
    code === 'CONTEXT_WINDOW_EXCEEDED' &&
    !/context_length_exceeded/i.test(message ?? '')
  )
    return `context_length_exceeded: ${message ?? ''}`
  if (
    code === 'QUOTA' &&
    !/quota exceeded|insufficient_quota/i.test(message ?? '')
  )
    return `quota exceeded: ${message ?? ''}`
  return message
}
export interface StreamRuntime {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
export function streamPi(
  runtime: StreamRuntime,
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions = {},
) {
  const stream = createAssistantMessageEventStream()
  const message: AssistantMessage = {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason: 'pending',
    content: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
  void (async () => {
    try {
      let request: GenerateOptions = {
        model: model.id,
        messages: requestMessages(context.messages),
        tools: getCurrentTools(context.messages).map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>,
        })),
        sessionId: options.sessionId,
        signal: options.signal,
        reasoningEffort: {
          off: undefined,
          minimal: 'low',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'high',
          max: 'high',
        }[options.reasoning ?? 'off'],
      }
      // onPayload may replace request content, but harness-owned routing/cancellation
      // metadata (sessionId, signal) is always preserved. Omitting `tools` inherits
      // the original tools; passing `tools: []` explicitly disables them.
      const replacement = await options.onPayload?.(request, model)
      if (replacement !== undefined) {
        if (
          replacement === null ||
          typeof replacement !== 'object' ||
          Array.isArray(replacement)
        ) {
          throw new LlmError(
            'onPayload must return a payload object or undefined',
            'INVALID_PAYLOAD',
          )
        }
        const candidate = replacement as Record<string, unknown>
        if (
          typeof candidate.model !== 'string' ||
          candidate.model.trim().length === 0
        ) {
          throw new LlmError(
            'onPayload replacement must include a non-empty string model',
            'INVALID_PAYLOAD',
          )
        }
        if (!Array.isArray(candidate.messages)) {
          throw new LlmError(
            'onPayload replacement must include a messages array',
            'INVALID_PAYLOAD',
          )
        }
        if (candidate.tools !== undefined && !Array.isArray(candidate.tools)) {
          throw new LlmError(
            'onPayload replacement tools must be an array when provided',
            'INVALID_PAYLOAD',
          )
        }
        request = {
          ...(candidate as unknown as GenerateOptions),
          tools:
            candidate.tools === undefined
              ? request.tools
              : (candidate.tools as GenerateOptions['tools']),
          sessionId: options.sessionId,
          signal: options.signal,
        }
      }
      stream.push({ type: 'start', partial: message })
      let finish: Extract<StreamChunk, { type: 'finish' }> | undefined
      let responseReported = false
      const toolArguments = new Map<number, ToolCallArgumentsStream>()
      for await (const chunk of runtime.stream(request)) {
        if (
          !responseReported &&
          !(chunk.type === 'finish' && chunk.reason.kind === 'aborted')
        ) {
          // ACP has no HTTP headers; report a synthetic response before its first event.
          await options.onResponse?.({ status: 200, headers: {} }, model)
          responseReported = true
        }
        await options.onProviderStreamEvent?.(chunk, model)
        if (chunk.type === 'usage') {
          const u = chunk.usage
          Object.assign(message.usage, {
            input: u.inputTokens,
            output: u.outputTokens,
            cacheRead: u.cacheReadTokens ?? 0,
            cacheWrite: u.cacheWriteTokens ?? 0,
            reasoning: u.reasoningTokens,
            totalTokens: u.totalTokens,
          })
          calculateCost(model, message.usage)
        } else if (chunk.type === 'block-start') {
          const contentIndex = chunk.index
          if (chunk.blockType === 'tool-call') continue // Identity arrives with the first tool delta.
          const thinking = chunk.blockType === 'reasoning'
          message.content[contentIndex] = thinking
            ? { type: 'thinking', thinking: '' }
            : { type: 'text', text: '' }
          stream.push({
            type: thinking ? 'thinking_start' : 'text_start',
            contentIndex,
            partial: message,
          })
        } else if (
          chunk.type === 'text-delta' ||
          chunk.type === 'reasoning-delta'
        ) {
          const block = message.content[chunk.index]!
          if (block.type === 'text') block.text += chunk.text
          if (block.type === 'thinking') block.thinking += chunk.text
          stream.push({
            type: chunk.type === 'text-delta' ? 'text_delta' : 'thinking_delta',
            contentIndex: chunk.index,
            delta: chunk.text,
            partial: message,
          })
        } else if (chunk.type === 'tool-call-delta') {
          let args = toolArguments.get(chunk.index)
          if (!args) {
            args = new ToolCallArgumentsStream()
            toolArguments.set(chunk.index, args)
            message.content[chunk.index] = {
              type: 'toolCall',
              id: chunk.id,
              name: chunk.name,
              arguments: {},
            }
            stream.push({
              type: 'toolcall_start',
              contentIndex: chunk.index,
              partial: message,
            })
          }
          const block = message.content[chunk.index]!
          if (block.type === 'toolCall')
            block.arguments = args.append(chunk.argumentsDelta)
          stream.push({
            type: 'toolcall_delta',
            contentIndex: chunk.index,
            delta: chunk.argumentsDelta,
            partial: message,
          })
        } else if (chunk.type === 'block-end') {
          const block = message.content[chunk.index]!
          if (block.type === 'toolCall') {
            const args = toolArguments.get(chunk.index)!
            if (chunk.block.type === 'tool-call')
              args.replace(chunk.block.arguments)
            Object.assign(block, args.finish())
            stream.push({
              type: 'toolcall_end',
              contentIndex: chunk.index,
              toolCall: block,
              partial: message,
            })
          } else
            stream.push({
              type: block.type === 'thinking' ? 'thinking_end' : 'text_end',
              contentIndex: chunk.index,
              content: block.type === 'thinking' ? block.thinking : block.text,
              partial: message,
            })
        } else if (chunk.type === 'finish') {
          finish = chunk
        }
      }
      // Drain the generator before publishing completion so runtime cleanup finishes before the next Pi step.
      if (finish) {
        const reason = finish.reason.kind
        if (reason === 'aborted' || reason === 'error') {
          message.stopReason = reason
          message.errorMessage = errorMessage(
            finish.reason.failure?.message,
            finish.reason.failure?.code,
          )
          stream.push({ type: 'error', reason, error: message })
        } else {
          message.stopReason =
            reason === 'tool-calls'
              ? 'toolUse'
              : reason === 'max-tokens'
                ? 'length'
                : 'stop'
          stream.push({ type: 'done', reason: message.stopReason, message })
        }
        return
      }
      throw new Error('ACP stream ended without a finish event')
    } catch (error) {
      message.stopReason = options.signal?.aborted ? 'aborted' : 'error'
      message.errorMessage = errorMessage(
        error instanceof Error ? error.message : String(error),
        error instanceof LlmError ? error.code : undefined,
      )
      stream.push({ type: 'error', reason: message.stopReason, error: message })
    } finally {
      stream.end()
    }
  })()
  return stream
}

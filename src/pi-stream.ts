import { createHash } from 'node:crypto'
import {
  createAssistantMessageEventStream,
  calculateCost,
  getCurrentTools,
  getSystemMessageText,
  renderSystemMessageUpdate,
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

export function requestMessages(messages: Message[]): RequestMessage[] {
  return messages.map((message, index) => {
    const id = createHash('sha256')
      .update(JSON.stringify(message))
      .digest('hex')
    if (message.role === 'system')
      return {
        id,
        role: 'system',
        content: [
          {
            type: 'text',
            text:
              index === 0
                ? getSystemMessageText(message)
                : renderSystemMessageUpdate(message),
          },
        ],
      }
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
              case 'image':
                return block
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
        reasoningEffort:
          options.reasoning === 'minimal'
            ? 'low'
            : options.reasoning === 'xhigh' || options.reasoning === 'max'
              ? 'high'
              : options.reasoning === 'low' ||
                  options.reasoning === 'medium' ||
                  options.reasoning === 'high'
                ? options.reasoning
                : undefined,
      }
      const replacement = await options.onPayload?.(request, model)
      if (replacement !== undefined)
        request = {
          ...(replacement as GenerateOptions),
          signal: options.signal,
        }
      stream.push({ type: 'start', partial: message })
      let finish: Extract<StreamChunk, { type: 'finish' }> | undefined
      let responseReported = false
      for await (const chunk of runtime.stream(request)) {
        if (!responseReported) {
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
          message.content[chunk.index] = {
            type: 'toolCall',
            id: chunk.id,
            name: chunk.name,
            arguments: JSON.parse(chunk.argumentsDelta),
          }
          stream.push({
            type: 'toolcall_delta',
            contentIndex: chunk.index,
            delta: chunk.argumentsDelta,
            partial: message,
          })
        } else if (chunk.type === 'block-end') {
          const block = message.content[chunk.index]!
          if (block.type === 'toolCall')
            stream.push({
              type: 'toolcall_end',
              contentIndex: chunk.index,
              toolCall: block,
              partial: message,
            })
          else
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
          message.errorMessage = finish.reason.failure?.message
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
      message.errorMessage =
        error instanceof Error ? error.message : String(error)
      stream.push({ type: 'error', reason: message.stopReason, error: message })
    } finally {
      stream.end()
    }
  })()
  return stream
}

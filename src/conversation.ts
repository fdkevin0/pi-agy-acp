/**
 * Per-conversation ACP session state and the turn pump that maps one ACP
 * prompt turn onto Pi model steps.
 *
 * An ACP prompt turn can span many model calls: the agent calls a Pi tool
 * through the MCP bridge, the call parks, and the pump ends the current Pi
 * step with `finish(tool-calls)`. Pi runs the tool through its own pipeline
 * and opens the next step with the result, which resolves the parked call and
 * resumes the same ACP turn. Parked calls that outlive the agent's MCP
 * deadline are relayed through the `pi_await_result` tool.
 * @module pi-agy-acp/conversation
 */

import { LlmError } from './protocol.ts'
import type { ContentBlock, StreamChunk, TokenUsage } from './protocol.ts'
import type {
  AcpPromptResult,
  AcpSessionUpdate,
  AcpPermissionRequest,
  AcpToolCallMeta,
} from './acp-process.ts'
import type { BridgeTool, BridgeToolResult } from './mcp-bridge.ts'
import { AGENT_TOOL_PREFIX, CALL_TOOL_NAME } from './history.ts'
import { AsyncQueue, deferred, type Deferred } from './util.ts'

/** Agent-side transport retry notice streamed as message text, e.g. `⚠ API error (attempt 1): …`. */
const AGENT_RETRY_NOTICE = /^\s*⚠\s*API error \(attempt \d+\)/
/** First sentence of the notice agy inserts when one generation hits its own output cap. */
const OUTPUT_LIMIT_HEAD =
  'your previous response was cut off because it exceeded the output token limit'
/** Second sentence of that same notice. */
const OUTPUT_LIMIT_TAIL =
  'please continue from where you left off, keeping your response shorter'

/** Collapse agy's warning mark and line breaks so the notice can be recognized across chunks. */
function noticeText(raw: string): string {
  return raw
    .replace(/⚠/g, ' ')
    .replace(/\bError:/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Classify text against agy's output-cap continuation notice.
 * `drop` is only that notice, `hold` is still a prefix of it, `emit` is model text.
 */
export function classifyOutputLimitNotice(
  raw: string,
): 'drop' | 'hold' | 'emit' {
  const text = noticeText(raw)
  if (text.length === 0) return 'emit'
  const stripped = text.replace(/\s*retries remaining:\s*\d*\s*$/i, '').trim()
  const retry = text.slice(stripped.length).trim()
  if (retry.length > 0 && !/^retries remaining:\s*\d*$/i.test(retry))
    return 'emit'
  if (stripped.length === 0)
    return /^retries remaining:\s*\d+$/i.test(text) ? 'drop' : 'emit'
  const full = `${OUTPUT_LIMIT_HEAD} ${OUTPUT_LIMIT_TAIL}`
  if (
    stripped === full ||
    stripped === OUTPUT_LIMIT_HEAD ||
    stripped === OUTPUT_LIMIT_TAIL
  )
    return 'drop'
  if (full.startsWith(stripped) && stripped.startsWith('your previous'))
    return 'hold'
  if (
    OUTPUT_LIMIT_TAIL.startsWith(stripped) &&
    stripped.startsWith('please continue from where you left off')
  )
    return 'hold'
  if ('retries remaining:'.startsWith(text) && text.startsWith('retries'))
    return 'hold'
  return 'emit'
}

/** Tool the agent calls to keep waiting on a relayed Pi tool result. */
export const AWAIT_TOOL_NAME = 'pi_await_result'

/** MCP descriptor of {@link AWAIT_TOOL_NAME}. */
export const AWAIT_TOOL: BridgeTool = {
  name: AWAIT_TOOL_NAME,
  description:
    'Wait for the result of a harness tool call that reported it is still running. Call this only when a tool result tells you to, passing the call_id it gave.',
  inputSchema: {
    type: 'object',
    properties: {
      call_id: {
        type: 'string',
        description: 'The call id from the still-running notice.',
      },
    },
    required: ['call_id'],
  },
}

/** MCP descriptor of {@link CALL_TOOL_NAME} (~340B, stays below agy's lazy cutoff). */
export const CALL_TOOL: BridgeTool = {
  name: CALL_TOOL_NAME,
  description:
    'Invoke any harness tool by exact name when mcp_pi_<name> is absent from your direct tool declarations.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Exact Pi tool name without mcp_pi_ prefix.',
      },
      arguments: {
        type: 'object',
        description: 'Arguments object matching that tool schema.',
      },
    },
    required: ['name'],
  },
}

/** One tool call the agent issued and Pi has to run. */
export interface ParkedCall {
  readonly id: string
  readonly name: string
  readonly argumentsJson: string
  readonly result: Deferred<BridgeToolResult>
}

/** Event observed during one ACP turn. */
export type TurnEvent =
  | { kind: 'thought'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'park'; call: ParkedCall }
  | { kind: 'done'; result: AcpPromptResult }
  | { kind: 'error'; error: Error }

/** One running ACP prompt turn. */
export class AcpTurn {
  readonly startedAt = performance.now()
  readonly events = new AsyncQueue<TurnEvent>()
  /** Calls handed to Pi whose results have not arrived yet. */
  readonly pendingCalls = new Map<string, ParkedCall>()
  /** Calls the agent issued during this turn. */
  readonly calls = new Map<string, ParkedCall>()
  /** Pi steps this turn has ended with `tool-calls`. */
  toolSteps = 0
  /** Long-decode continuations sent in this turn. */
  continuations = 0
  /** The agent ended the prompt. */
  finished = false
  /** Settles after the current prompt's result or error has been queued. */
  promptSettled: Promise<void> = Promise.resolve()
  usage?: AcpPromptResult['usage']
  /** A parked call was answered with a still-running notice and the agent has not resumed waiting yet. */
  relaying = false
  /** The turn produced visible text or a tool call. */
  produced = false
  /** Agent-side transport retry notices dropped from the output. */
  retryNotices = 0
  /** Message text that may still be the start of agy's output-cap notice. */
  private noticeHold = ''
  private nextCall = 0
  private readonly turnTag: string

  /** @param turnTag - unique per-turn hex tag used in synthesized call ids (`agy_<turnTag>_<n>`). */
  constructor(turnTag: string) {
    this.turnTag = turnTag
  }

  /**
   * Register one agent tool call.
   * @param name - Pi tool name.
   * @param args - parsed arguments.
   * @returns the parked call.
   */
  park(name: string, args: Record<string, unknown>): ParkedCall {
    const call: ParkedCall = {
      id: `agy_${this.turnTag}_${++this.nextCall}`,
      name,
      argumentsJson: JSON.stringify(args),
      result: deferred<BridgeToolResult>(),
    }
    this.calls.set(call.id, call)
    this.events.push({ kind: 'park', call })
    return call
  }

  /**
   * Route one ACP session update into the event queue.
   * @param update - the agent notification.
   */
  onUpdate(update: AcpSessionUpdate): void {
    const text =
      update.content?.type === 'text' ? (update.content.text ?? '') : ''
    if (update.sessionUpdate === 'agent_message_chunk' && text.length > 0) {
      this.consumeMessage(text)
      return
    }
    if (update.sessionUpdate === 'agent_thought_chunk') {
      const held = this.recoverNoticeHold()
      if (held.length > 0 && !this.relaying)
        this.events.push({ kind: 'text', text: held })
      if (text.length > 0 && !this.relaying)
        this.events.push({ kind: 'thought', text })
    }
  }

  /**
   * Keep a message chunk out of the chat while it is only agy's output-cap notice.
   * @param text - one streamed message chunk.
   */
  private consumeMessage(text: string): void {
    const combined = this.noticeHold + text
    const kind = classifyOutputLimitNotice(combined)
    if (kind === 'hold') {
      this.noticeHold = combined
      return
    }
    this.noticeHold = ''
    if (kind === 'drop' || AGENT_RETRY_NOTICE.test(combined)) {
      this.retryNotices++
      return
    }
    if (!this.relaying) this.events.push({ kind: 'text', text: combined })
  }

  /**
   * Release a held prefix once the message stream moves on.
   * A finished output-cap notice is counted and discarded; anything else is returned for emission.
   * @returns model text to show, or an empty string.
   */
  recoverNoticeHold(): string {
    if (this.noticeHold.length === 0) return ''
    const held = this.noticeHold
    this.noticeHold = ''
    if (classifyOutputLimitNotice(held) === 'drop') {
      this.retryNotices++
      return ''
    }
    return this.relaying ? '' : held
  }

  /**
   * Abandon every parked call with an error result.
   * @param reason - message delivered to the agent.
   */
  abandon(reason: string): void {
    for (const call of this.calls.values()) {
      call.result.resolve({
        content: [{ type: 'text', text: reason }],
        isError: true,
      })
    }
    this.pendingCalls.clear()
  }
}

/** Effects the pump needs from its owner. */
export interface PumpHost {
  /** Window that groups parallel tool calls. */
  parkSettleMs: number
  /** Allowed long-decode continuations. */
  maxContinuations: number
  /** Send one continuation prompt in the same session; resolves with its result. */
  continuePrompt(): Promise<AcpPromptResult>
  /** Request cancellation of the running turn. */
  cancel(): void
}

/**
 * Map one completed prompt or step sample to Pi token usage. When a single
 * sample spanned `calls` internal model steps (tool rounds or continuations),
 * prompt buckets are normalized by `calls` so Pi's native ContextMeter reflects
 * single-request context occupancy rather than the multi-step sum.
 *
 * `agy acp` reports `inputTokens` as uncached input only, disjoint from
 * `cachedReadTokens` and `cachedWriteTokens`, so every bucket is kept as
 * reported and the total is their sum.
 * @param usage - the agent's step or turn usage.
 * @param calls - model calls executed inside this sample (>= 1).
 * @returns Pi usage.
 */
export function toTokenUsage(
  usage: AcpPromptResult['usage'],
  calls = 1,
): TokenUsage | undefined {
  if (usage === undefined) return undefined
  const scale = Math.max(1, calls)
  const input = Math.max(0, Math.round((usage.inputTokens ?? 0) / scale))
  const cacheRead = Math.max(
    0,
    Math.round((usage.cachedReadTokens ?? 0) / scale),
  )
  const cacheWrite = Math.max(
    0,
    Math.round((usage.cachedWriteTokens ?? 0) / scale),
  )
  const output = Math.max(0, usage.outputTokens ?? 0)
  const reasoning =
    usage.thoughtTokens !== undefined && usage.thoughtTokens > 0
      ? Math.min(output, usage.thoughtTokens)
      : undefined
  return {
    inputTokens: input,
    outputTokens: output,
    ...(usage.cachedReadTokens !== undefined || cacheRead > 0
      ? { cacheReadTokens: cacheRead }
      : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined && reasoning > 0
      ? { reasoningTokens: reasoning }
      : {}),
    totalTokens: input + cacheRead + cacheWrite + output,
  }
}

/**
 * Stream one Pi step out of the running turn.
 * @param turn - the running ACP turn.
 * @param host - owner effects.
 * @param signal - Pi cancellation.
 * @yields Pi stream chunks ending with one finish chunk.
 */
export async function* pumpStep(
  turn: AcpTurn,
  host: PumpHost,
  signal: AbortSignal | undefined,
): AsyncGenerator<StreamChunk> {
  let index = 0
  let open:
    { index: number; type: 'text' | 'reasoning'; text: string } | undefined
  const close = function* (): Generator<StreamChunk> {
    if (open === undefined) return
    const block: ContentBlock =
      open.type === 'text'
        ? { type: 'text', text: open.text }
        : { type: 'reasoning', text: open.text }
    yield { type: 'block-end', index: open.index, block }
    open = undefined
  }
  const append = function* (
    type: 'text' | 'reasoning',
    text: string,
  ): Generator<StreamChunk> {
    if (open?.type !== type) {
      yield* close()
      open = { index: index++, type, text: '' }
      yield { type: 'block-start', index: open.index, blockType: type }
    }
    open.text += text
    yield type === 'text'
      ? { type: 'text-delta', index: open.index, text }
      : { type: 'reasoning-delta', index: open.index, text }
  }

  for (;;) {
    const ready = await turn.events.wait(signal)
    if (!ready) {
      host.cancel()
      turn.abandon('The harness cancelled this request.')
      yield* close()
      yield {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: { message: 'Request aborted', code: 'ABORTED' },
        },
      }
      return
    }
    if (turn.events.peek()?.kind !== 'text') {
      const held = turn.recoverNoticeHold()
      if (held.length > 0) {
        turn.produced = true
        yield* append('text', held)
      }
    }
    const event = turn.events.shift() as TurnEvent
    switch (event.kind) {
      case 'thought':
        yield* append('reasoning', event.text)
        break
      case 'text':
        turn.produced = true
        yield* append('text', event.text)
        break
      case 'park': {
        turn.produced = true
        yield* close()
        const batch: ParkedCall[] = [event.call]
        // Parallel calls of one model response arrive within a short window.
        while (await turn.events.wait(signal, host.parkSettleMs)) {
          const next = turn.events.peek()
          if (next?.kind !== 'park') break
          turn.events.shift()
          batch.push(next.call)
        }
        for (const call of batch) {
          const blockIndex = index++
          turn.pendingCalls.set(call.id, call)
          yield {
            type: 'block-start',
            index: blockIndex,
            blockType: 'tool-call',
          }
          yield {
            type: 'tool-call-delta',
            index: blockIndex,
            id: call.id,
            name: call.name,
            argumentsDelta: call.argumentsJson,
          }
          yield {
            type: 'block-end',
            index: blockIndex,
            block: {
              type: 'tool-call',
              id: call.id,
              name: call.name,
              arguments: call.argumentsJson,
            },
          }
        }
        turn.toolSteps++
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      case 'done': {
        const stop = event.result.stopReason
        if (
          stop === 'max_tokens' &&
          turn.continuations < host.maxContinuations
        ) {
          turn.continuations++
          turn.promptSettled = host.continuePrompt().then(
            (result) => turn.events.push({ kind: 'done', result }),
            (error: unknown) =>
              turn.events.push({
                kind: 'error',
                error:
                  error instanceof Error ? error : new Error(String(error)),
              }),
          )
          break
        }
        turn.finished = true
        yield* close()
        const calls = turn.toolSteps + turn.continuations + 1
        turn.usage = event.result.usage
        const usage = toTokenUsage(event.result.usage, calls)
        if (usage !== undefined) yield { type: 'usage', usage }
        if (stop === 'end_turn' && !turn.produced) {
          throw new LlmError(
            'Antigravity ended the turn without visible output',
            'EMPTY_RESPONSE',
          )
        }
        switch (stop) {
          case 'end_turn':
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          case 'max_tokens':
            yield { type: 'finish', reason: { kind: 'max-tokens' } }
            return
          case 'cancelled':
            yield {
              type: 'finish',
              reason: {
                kind: 'aborted',
                failure: {
                  message: 'Antigravity cancelled the turn',
                  code: 'ABORTED',
                },
              },
            }
            return
          case 'refusal':
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: {
                  message: 'Antigravity refused the request',
                  code: 'REFUSAL',
                },
              },
            }
            return
          default:
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: {
                  message: `Antigravity stopped: ${stop}`,
                  code: 'PROVIDER_ERROR',
                },
              },
            }
            return
        }
      }
      case 'error':
        turn.finished = true
        yield* close()
        throw event.error
    }
  }
}

/**
 * Notice returned to the agent when a Pi tool outlives the MCP call deadline.
 * @param call - the still-running call.
 * @returns MCP result instructing the agent to keep waiting.
 */
export function relayNotice(call: ParkedCall): BridgeToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `The harness is still running tool call ${call.id} (${call.name}). Call ${AGENT_TOOL_PREFIX}${AWAIT_TOOL_NAME} with {"call_id":"${call.id}"} now to receive its result. Do not repeat the original call and do not answer the user before the result arrives.`,
      },
    ],
  }
}

/** Structured MCP metadata the agent reported for one tool call. */
export interface ReportedToolCall {
  kind?: string
  serverName?: string
  toolName?: string
  /** Set when later updates contradicted an already established field. */
  conflict?: boolean
}

/** Read a non-empty string field. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Extract the structured `(serverName, toolName)` an agent claimed in one
 * permission request: top-level `mcpServerName`/`mcpToolName` or `_meta`.
 * `title` and `rawInput` are deliberately not consulted.
 */
export function structuredToolMeta(
  toolCall: AcpPermissionRequest['toolCall'],
): {
  serverName?: string
  toolName?: string
} {
  const meta: AcpToolCallMeta | undefined = toolCall?._meta
  const serverName =
    nonEmpty(toolCall?.mcpServerName) ??
    nonEmpty(meta?.mcpServerName) ??
    nonEmpty(meta?.serverName) ??
    nonEmpty(meta?.server)
  const toolName =
    nonEmpty(toolCall?.mcpToolName) ??
    nonEmpty(meta?.mcpToolName) ??
    nonEmpty(meta?.toolName) ??
    nonEmpty(meta?.tool)
  return {
    ...(serverName !== undefined ? { serverName } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
  }
}

/**
 * Record the structured metadata of one agent-reported tool-call update.
 * The first report establishes the identity; later updates merge only the
 * fields actually present, so a status-only `tool_call_update` never wipes an
 * established `server`/`tool`/`kind`. A later field that contradicts the
 * established identity keeps the original value and marks the record
 * anomalous — the permission gate refuses every further request for that call.
 * @returns 'created' | 'merged' | 'conflict', or undefined for ignored updates.
 */
export function recordReportedToolCall(
  conv: { reportedToolCalls: Map<string, ReportedToolCall> },
  update: AcpSessionUpdate,
): 'created' | 'merged' | 'conflict' | undefined {
  if (
    update.sessionUpdate !== 'tool_call' &&
    update.sessionUpdate !== 'tool_call_update'
  )
    return
  if (typeof update.toolCallId !== 'string' || update.toolCallId.length === 0)
    return
  const { serverName, toolName } = structuredToolMeta(update)
  const kind = typeof update.kind === 'string' ? update.kind : undefined
  const existing = conv.reportedToolCalls.get(update.toolCallId)
  const merged: ReportedToolCall = existing === undefined ? {} : { ...existing }
  let conflict = false
  if (kind !== undefined) {
    if (merged.kind !== undefined && merged.kind !== kind) conflict = true
    else merged.kind = kind
  }
  if (serverName !== undefined) {
    if (merged.serverName !== undefined && merged.serverName !== serverName)
      conflict = true
    else merged.serverName = serverName
  }
  if (toolName !== undefined) {
    if (merged.toolName !== undefined && merged.toolName !== toolName)
      conflict = true
    else merged.toolName = toolName
  }
  if (conflict) merged.conflict = true
  conv.reportedToolCalls.set(update.toolCallId, merged)
  if (conflict) return 'conflict'
  return existing === undefined ? 'created' : 'merged'
}

/** Whether `rawInput` carries no arguments at all (MCP server loading probes). */
export function isEmptyInput(rawInput: unknown): boolean {
  if (rawInput === undefined || rawInput === null) return true
  if (typeof rawInput === 'string') return rawInput.trim().length === 0
  if (Array.isArray(rawInput)) return rawInput.length === 0
  if (typeof rawInput === 'object') return Object.keys(rawInput).length === 0
  return false
}

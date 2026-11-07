// Internal bridge protocol adapted from the MIT-licensed upstream implementation (see NOTICE).
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'image'; data: string; mimeType: string }
type Base = { id?: string; content: readonly ContentBlock[] }
export type RequestMessage = Base &
  (
    | { role: 'user' | 'system' }
    | { role: 'assistant'; source: { kind: string; provider: string } }
    | { role: 'tool'; toolCallId: string; isError?: boolean }
  )
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}
export interface GenerateOptions {
  model: string
  messages: readonly RequestMessage[]
  system?: string
  tools?: readonly ToolSchema[]
  signal?: AbortSignal
  sessionId?: string
  reasoningEffort?: string
}
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  totalTokens: number
}
export type StreamChunk =
  | {
      type: 'block-start'
      index: number
      blockType: 'text' | 'reasoning' | 'tool-call'
    }
  | { type: 'text-delta' | 'reasoning-delta'; index: number; text: string }
  | {
      type: 'tool-call-delta'
      index: number
      id: string
      name: string
      argumentsDelta: string
    }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | {
      type: 'finish'
      reason: {
        kind: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'
        failure?: { message: string; code: string }
      }
    }
export class LlmError extends Error {
  readonly code: string
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

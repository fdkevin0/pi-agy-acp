import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recordReportedToolCall,
  structuredToolMeta,
} from '../src/conversation.ts'

// agy 1.5.8 reports an MCP tool call without mcpServerName / mcpToolName.
const flatCall = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call_1',
  name: 'mcp_pi_read',
  kind: 'other',
  title: 'Run mcp_pi_read',
  rawInput: { path: 'note.txt' },
}

test('a flat mcp_pi_<tool> name identifies a Pi bridge tool', () => {
  assert.deepEqual(structuredToolMeta(flatCall), {
    serverName: 'pi',
    toolName: 'read',
  })
})

test('explicit structured fields win over the flat name', () => {
  assert.deepEqual(
    structuredToolMeta({
      ...flatCall,
      mcpServerName: 'other',
      mcpToolName: 'x',
    }),
    { serverName: 'other', toolName: 'x' },
  )
})

test('title and rawInput never identify a tool', () => {
  assert.deepEqual(
    structuredToolMeta({
      toolCallId: 'call_2',
      title: 'Run mcp_pi_read',
      rawInput: { name: 'mcp_pi_read' },
    }),
    {},
  )
})

test('other servers and an empty tool name are not accepted', () => {
  assert.deepEqual(structuredToolMeta({ name: 'mcp_other_read' }), {})
  assert.deepEqual(structuredToolMeta({ name: 'mcp_pi_' }), {})
})

test('a flat-name report is recorded with the Pi server identity', () => {
  const conv = { reportedToolCalls: new Map() }
  assert.equal(recordReportedToolCall(conv, flatCall), 'created')
  assert.equal(
    recordReportedToolCall(conv, {
      ...flatCall,
      sessionUpdate: 'tool_call_update',
      status: 'pending',
    }),
    'merged',
  )
  assert.deepEqual(conv.reportedToolCalls.get('call_1'), {
    kind: 'other',
    serverName: 'pi',
    toolName: 'read',
  })
})

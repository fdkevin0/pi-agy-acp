import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { McpBridge } from '../src/mcp-bridge.ts'

const router = {
  authorize: (tenant, token) => tenant === 'tenant' && token === 'secret',
  listTools: () => [],
  callTool: async () => ({ content: [] }),
}
const post = (body, headers = '') =>
  `POST /mcp/tenant HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer secret\r\nConnection: close\r\n${headers}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
const ping = post('{"id":1,"method":"ping"}')

function raw(port, request, trickle) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request))
    const drip = trickle === undefined ? undefined : setInterval(() => socket.write(trickle), 20)
    let response = ''
    socket.setEncoding('utf8')
    socket.setTimeout(5_000, () => socket.destroy(new Error(`raw request timed out: ${request.slice(0, 180)}`)))
    socket.on('data', (chunk) => { response += chunk })
    socket.on('error', reject)
    socket.on('close', () => { clearInterval(drip); resolve(response) })
  })
}

async function bridge(t, overrides = {}, options = {}) {
  const b = new McpBridge({ ...router, ...overrides }, { keepAliveMs: 20, ...options })
  await b.start()
  t.after(() => b.close())
  return { b, port: Number(new URL(b.url).port) }
}

test('malformed unauthenticated URL survives in an isolated process; authenticated ping still works', { timeout: 8_000 }, async (t) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { McpBridge } from './src/mcp-bridge.ts';
    const b = new McpBridge({authorize: (tenant, token) => tenant === 'tenant' && token === 'secret'}, {keepAliveMs: 20});
    await b.start(); console.log(new URL(b.url).port);
    process.stdin.on('data', async () => { await b.close(); process.exit(0) });
  `], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  let stderr = ''
  child.stderr.on('data', (data) => { stderr += data })
  const exited = once(child, 'exit')
  const [data] = await once(child.stdout, 'data')
  const port = Number(String(data).trim())
  assert.match(await raw(port, 'GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'), /^HTTP\/1.1 400/)
  assert.match(await raw(port, ping), /"id":1,"result":\{\}/)
  child.stdin.write('close')
  assert.deepEqual(await exited, [0, null], stderr)
})

test('handler failures before and after headers are contained; persistent server errors are logged', async (t) => {
  let fail = true
  const logs = []
  const { b, port } = await bridge(t, {
    authorize: (...args) => { if (fail) throw Object.create(null); return router.authorize(...args) },
    listTools: () => { throw new Error('listing failed') },
    callTool: async () => { const value = {}; value.circular = value; return value },
  }, { log: (message) => logs.push(message) })
  assert.match(await raw(port, ping), /^HTTP\/1.1 500/)
  fail = false
  assert.match(await raw(port, post('{"id":2,"method":"tools/list"}')), /^HTTP\/1.1 500/)
  const sse = await raw(port, post('{"id":3,"method":"tools/call"}'))
  assert.match(sse, /text\/event-stream/)
  assert.doesNotMatch(sse, /event: message/)
  b.server.emit('error', new Error('listener failure'))
  b.server.emit('error', new Error('another listener failure'))
  assert.equal(logs.filter((line) => line.includes('server error')).length, 2)
  assert.match(await raw(port, ping), /"result":\{\}/)
})

test('a throwing diagnostic sink cannot escape the boundary', async (t) => {
  const { b, port } = await bridge(t, { listTools: () => { throw new Error('failure') } }, {
    log: () => { throw new Error('sink failed') },
  })
  b.server.emit('error', new Error('server failed'))
  assert.match(await raw(port, post('{"id":1,"method":"tools/list"}')), /^HTTP\/1.1 500/)
})

test('body limit accepts the exact byte boundary and rejects declared and chunked excess with 413', async (t) => {
  const { port } = await bridge(t)
  const limit = 1_048_576
  const body = '{"id":1,"method":"ping"}'
  assert.match(await raw(port, post(body + ' '.repeat(limit - body.length))), /"result":\{\}/)
  assert.match(await raw(port, post('').replace('Content-Length: 0', `Content-Length: ${limit + 1}`)), /^HTTP\/1.1 413/)
  const chunk = ' '.repeat(limit + 1)
  assert.match(await raw(port, 'POST /mcp/tenant HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer secret\r\nTransfer-Encoding: chunked\r\n\r\n' + chunk.length.toString(16) + '\r\n' + chunk + '\r\n'), /^HTTP\/1.1 413/)
  assert.match(await raw(port, ping), /"result":\{\}/)
})

test('malformed JSON retains its parse error response', async (t) => {
  const { port } = await bridge(t)
  assert.match(await raw(port, post('{')), /HTTP\/1.1 400[\s\S]*"code":-32700/)
})

test('header and body reception expire, while completed long SSE requests keep running', { timeout: 8_000 }, async (t) => {
  const { b, port } = await bridge(t, { callTool: async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    return { content: [{ type: 'text', text: 'finished' }] }
  } })
  assert.equal(b.server.headersTimeout, 10_000)
  assert.equal(b.server.requestTimeout, 30_000)
  assert.equal(b.server.connectionsCheckingInterval, 1_000)
  // Shorten the same Node parser deadlines, keeping production's polling interval.
  b.server.headersTimeout = 50
  b.server.requestTimeout = 100
  const responses = await Promise.all([
    raw(port, 'POST /mcp/tenant HTTP/1.1\r\nHost:', 'x'),
    raw(port, post('').replace('Content-Length: 0', 'Content-Length: 10000') + '{', ' '),
    new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/mcp/tenant', method: 'POST',
        headers: { authorization: 'Bearer secret' }, agent: false }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => { req.destroy(); resolve(body) })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end('{"id":1,"method":"tools/call","params":{"_meta":{"progressToken":1}}}')
    }),
  ])
  assert.match(responses[0], /^HTTP\/1.1 408/)
  assert.match(responses[1], /^HTTP\/1.1 408/)
  assert.match(responses[2], /: keepalive/)
  assert.match(responses[2], /notifications\/progress/)
  assert.match(responses[2], /finished/)
})

test('close destroys incomplete headers, incomplete bodies, idle sockets and active SSE', { timeout: 3_000 }, async (t) => {
  let signal
  const { b, port } = await bridge(t, { callTool: async (request) => {
    signal = request.signal
    return new Promise(() => {}) // Shutdown must not depend on cooperative tools.
  } })
  const sockets = []
  for (const data of ['', 'POST /mcp/tenant HTTP/1.1\r\nHost:', post('').replace('Content-Length: 0', 'Content-Length: 100'), post('{"id":1,"method":"tools/call"}')]) {
    const s = connect(port, '127.0.0.1')
    sockets.push(s)
    t.after(() => s.destroy())
    await once(s, 'connect')
    if (data) s.write(data)
    if (data.includes('tools/call')) await once(s, 'data')
  }
  const closed = sockets.map((s) => once(s, 'close'))
  const started = performance.now()
  await b.close()
  await Promise.all(closed)
  assert.ok(performance.now() - started < 1_000)
  assert.equal(signal.aborted, true)
})

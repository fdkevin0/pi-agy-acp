import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { deferred } from '../src/util.ts'
import { McpBridge } from '../src/mcp-bridge.ts'

const router = {
  authorize: (tenant, token) => tenant === 'tenant' && token === 'secret',
  listTools: () => [],
  callTool: async () => ({ content: [] }),
}
const post = (body, headers = '') =>
  `POST /mcp/tenant HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer secret\r\nConnection: close\r\n${headers}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
const ping = post('{"id":1,"method":"ping"}')

function raw(port, request) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request))
    let response = ''
    socket.setEncoding('utf8')
    socket.setTimeout(5_000, () => socket.destroy(new Error(`raw request timed out: ${request.slice(0, 180)}`)))
    socket.on('data', (chunk) => { response += chunk })
    socket.on('error', reject)
    socket.on('close', () => resolve(response))
  })
}

function rawTimeout(port, request, trickle) {
  return new Promise((resolve) => {
    let drip
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(request)
      drip = setInterval(() => socket.write(trickle), 20)
    })
    let response = ''
    socket.setEncoding('utf8')
    socket.setTimeout(5_000, () => socket.destroy())
    socket.on('data', (chunk) => { clearInterval(drip); response += chunk })
    // Node's socketOnError writes 408 then destroys timed-out uploads with ECONNRESET.
    socket.on('error', () => {})
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
  const authorize = t.mock.fn(router.authorize)
  authorize.mock.mockImplementationOnce(() => { throw Object.create(null) })
  const logs = []
  const { b, port } = await bridge(t, {
    authorize,
    listTools: () => { throw new Error('listing failed') },
    callTool: async () => { const value = {}; value.circular = value; return value },
  }, { log: (message) => logs.push(message) })
  assert.match(await raw(port, ping), /^HTTP\/1.1 500/)
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
  const tool = deferred()
  const entered = deferred()
  const activity = deferred()
  const { b, port } = await bridge(t, { callTool: () => {
    entered.resolve()
    return tool.promise
  } })
  // Accelerate the real parser deadlines; completed SSE requests must survive both.
  b.server.headersTimeout = 50
  b.server.requestTimeout = 100
  let body = ''
  const completed = new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/mcp/tenant', method: 'POST',
      headers: { authorization: 'Bearer secret' }, agent: false }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk; activity.resolve() })
      res.on('end', () => { req.destroy(); resolve(body) })
      res.on('error', reject)
    })
    t.after(() => req.destroy())
    req.on('error', reject)
    req.end('{"id":1,"method":"tools/call","params":{"_meta":{"progressToken":1}}}')
  })
  await entered.promise
  const [headers, upload] = await Promise.all([
    rawTimeout(port, 'POST /mcp/tenant HTTP/1.1\r\nHost:', 'x'),
    rawTimeout(port, post('').replace('Content-Length: 0', 'Content-Length: 10000') + '{', ' '),
    activity.promise,
  ])
  assert.equal(headers, 'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n')
  assert.equal(upload, 'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n')
  assert.match(body, /: keepalive/)
  assert.match(body, /notifications\/progress/)
  assert.equal(tool.settled, false)
  tool.resolve({ content: [{ type: 'text', text: 'finished' }] })
  assert.match(await completed, /finished/)
})

test('close destroys an incomplete body', { timeout: 3_000 }, async (t) => {
  const { b, port } = await bridge(t)
  const accepted = once(b.server, 'connection')
  const socket = connect(port, '127.0.0.1')
  t.after(() => socket.destroy())
  await once(socket, 'connect')
  const [serverSocket] = await accepted
  const received = once(serverSocket, 'data')
  socket.write(post('').replace('Content-Length: 0', 'Content-Length: 100'))
  await received
  const closed = once(socket, 'close')
  await b.close()
  await closed
})

test('close destroys active SSE and aborts an uncooperative tool', { timeout: 3_000 }, async (t) => {
  const entered = deferred()
  const { b, port } = await bridge(t, { callTool: ({ signal }) => {
    entered.resolve(signal)
    return new Promise(() => {})
  } })
  const socket = connect(port, '127.0.0.1')
  t.after(() => socket.destroy())
  await once(socket, 'connect')
  socket.write(post('{"id":1,"method":"tools/call"}'))
  await once(socket, 'data')
  const signal = await entered.promise
  const closed = once(socket, 'close')
  const aborted = once(signal, 'abort')
  await b.close()
  await Promise.all([closed, aborted])
  assert.equal(signal.aborted, true)
})

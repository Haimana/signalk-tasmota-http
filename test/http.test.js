'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const { _internal: I } = require('../index.js')
const { mockTasmota } = require('./helpers')

const dev = (port) => ({ host: '127.0.0.1', port, powerIndex: 1, password: 'secret' })

test('timeout error names host, command and elapsed ms (no password)', async () => {
  const m = await mockTasmota(() => ({ hang: true }))
  try {
    await assert.rejects(I.httpGetJson(I.buildCmUrl(dev(m.port), 'Status 0'), { timeoutMs: 200 }), (e) => {
      assert.match(e.message, /timeout after 200 ms/)
      assert.match(e.message, new RegExp(`127\\.0\\.0\\.1:${m.port} "Status 0", \\d+ ms`))
      assert.doesNotMatch(e.message, /secret/)
      assert.strictEqual(e.code, 'ETIMEDOUT')
      assert.ok(e.elapsedMs >= 190 && e.elapsedMs < 1000)
      return true
    })
  } finally { await m.close() }
})

test('overall deadline also covers a slowly trickling body', async () => {
  const srv = net.createServer((c) => {
    c.once('data', () => {
      c.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n')
      const iv = setInterval(() => c.write(' '), 50)
      c.on('close', () => clearInterval(iv))
      c.on('error', () => clearInterval(iv))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const t0 = Date.now()
    await assert.rejects(I.httpGetJson(I.buildCmUrl(dev(srv.address().port), 'Power'), { timeoutMs: 300 }), /timeout after 300 ms/)
    assert.ok(Date.now() - t0 < 1000)
  } finally { srv.close() }
})

test('response too large rejects once and closes the connection', async () => {
  const m = await mockTasmota(() => ({ body: 'x'.repeat(300000) }))
  try {
    await assert.rejects(I.httpGetJson(I.buildCmUrl(dev(m.port), 'Status 0'), { timeoutMs: 2000 }), /response too large/)
  } finally { await m.close() }
})

test('invalid JSON and HTTP errors are reported', async () => {
  const m = await mockTasmota((c) => (c === 'bad' ? { body: '<html>' } : { status: 401, body: 'nope' }))
  try {
    await assert.rejects(I.httpGetJson(I.buildCmUrl(dev(m.port), 'bad'), {}), /invalid JSON/)
    await assert.rejects(I.httpGetJson(I.buildCmUrl(dev(m.port), 'x'), {}), /HTTP 401/)
  } finally { await m.close() }
})

test('AbortSignal aborts an open request', async () => {
  const m = await mockTasmota(() => ({ hang: true }))
  try {
    const ac = new AbortController()
    const p = I.httpGetJson(I.buildCmUrl(dev(m.port), 'Power'), { timeoutMs: 5000, signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    await assert.rejects(p, /aborted/)
  } finally { await m.close() }
})

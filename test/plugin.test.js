'use strict'
const test = require('node:test')
const assert = require('node:assert')
const createPlugin = require('../index.js')
const { STATUS0, mockTasmota, mockApp, sleep, waitFor, device } = require('./helpers')

const statePaths = (app) =>
  app.messages.flatMap((m) => m.delta.updates.flatMap((u) => u.values.map((v) => v.path)))

test('no overlapping polls and PUTs are serialised per device', async () => {
  const m = await mockTasmota((c) => (c.startsWith('Power') ? { delay: 150, json: { POWER: 'OFF' } } : { delay: 200, json: STATUS0() }))
  const app = mockApp()
  const plugin = createPlugin(app)
  // polls take 0.2 s and PUTs arrive mid-poll: the old code sent them concurrently
  plugin.start({ pollInterval: 0.5, requestTimeout: 1, devices: [device(m.port)] })
  try {
    await waitFor(() => m.stats.requests.length >= 1)
    // fire PUTs while a poll is in flight
    const put = app.puts['electrical.switches.charger.state']
    const results = []
    for (let i = 0; i < 3; i++) put('vessels.self', 'x', false, (r) => results.push(r))
    await sleep(1500)
    await waitFor(() => results.length === 3)
    assert.strictEqual(m.stats.maxActive, 1, 'never more than one request at a time to the device')
    assert.ok(results.every((r) => r.statusCode === 200))
    assert.ok(m.stats.requests.filter((r) => r.cmnd === 'Status 0').length >= 2)
    assert.ok(m.stats.requests.every((r) => r.cmnd === 'Status 0' || r.cmnd === 'Power OFF'), 'one request per poll')
  } finally { plugin.stop(); await m.close() }
})

test('no fake initial false; meta sent once per path and again after restart', async () => {
  const m = await mockTasmota(() => ({ delay: 30, json: STATUS0(true) }))
  const app = mockApp()
  const plugin = createPlugin(app)
  plugin.start({ pollInterval: 0.2, devices: [device(m.port)] })
  try {
    await sleep(10)
    assert.strictEqual(app.messages.length, 0, 'nothing published before the first real reply')
    await waitFor(() => app.messages.length >= 3)
    const first = app.messages[0].delta.updates[0]
    assert.strictEqual(first.values.find((v) => v.path === 'electrical.switches.charger.state').value, true)
    assert.ok(first.meta.some((x) => x.path === 'electrical.switches.charger.state'))
    assert.ok(first.meta.some((x) => x.path === 'electrical.ac.charger.phase.single.realPower' && x.value.units === 'W'))
    assert.ok(first.values.some((v) => v.path === 'electrical.ac.charger.energy' && Math.abs(v.value - 48.777 * 3.6e6) < 1))
    for (const msg of app.messages.slice(1)) assert.strictEqual(msg.delta.updates[0].meta, undefined)
    plugin.stop()
    const n = app.messages.length
    plugin.start({ pollInterval: 0.2, devices: [device(m.port)] })
    await waitFor(() => app.messages.length > n)
    assert.ok(app.messages[n].delta.updates[0].meta.length > 0, 'meta resent after restart')
  } finally { plugin.stop(); await m.close() }
})

test('timeout sets error with details; recovery clears it via setPluginStatus; logged once each', async () => {
  let mode = 'hang'
  const m = await mockTasmota(() => (mode === 'hang' ? { hang: true } : { json: STATUS0() }))
  const app = mockApp()
  const plugin = createPlugin(app)
  plugin.start({ pollInterval: 0.5, requestTimeout: 0.15, devices: [device(m.port)] })
  try {
    await waitFor(() => app.statuses.some((s) => s.kind === 'error'))
    const err = app.statuses.find((s) => s.kind === 'error').s
    assert.match(err, /charger: offline since .*timeout after 150 ms \(127\.0\.0\.1:\d+ "Status 0", \d+ ms\)/)
    await sleep(800) // several more failures
    assert.strictEqual(app.errors.filter((e) => /offline/.test(e)).length, 1, 'offline logged once')
    mode = 'ok'
    await waitFor(() => app.statuses.at(-1).kind === 'status' && /charger: OK/.test(app.statuses.at(-1).s), 5000)
    assert.strictEqual(app.errors.filter((e) => /back online/.test(e)).length, 1, 'recovery logged once')
    const nStatus = app.statuses.length
    await sleep(700)
    assert.strictEqual(app.statuses.length, nStatus, 'status not re-sent when unchanged')
  } finally { plugin.stop(); await m.close() }
})

test('stop(): in-flight poll is aborted and nothing is published afterwards', async () => {
  const m = await mockTasmota(() => ({ delay: 400, json: STATUS0() }))
  const app = mockApp()
  const plugin = createPlugin(app)
  plugin.start({ pollInterval: 0.2, devices: [device(m.port)] })
  await waitFor(() => m.stats.active === 1)
  plugin.stop()
  await sleep(700)
  assert.strictEqual(app.messages.length, 0)
  assert.strictEqual(app.statuses.filter((s) => s.kind === 'error').length, 0, 'abort is not reported as device error')
  assert.strictEqual(m.stats.requests.length, 1, 'no further polls after stop')
  await waitFor(() => m.stats.closedEarly === 1)
  // PUT after stop answers 503 without touching the device
  const r = app.puts['electrical.switches.charger.state']('vessels.self', 'x', true, () => {})
  assert.strictEqual(r.statusCode, 503)
  assert.strictEqual(m.stats.requests.length, 1)
  await m.close()
})

test('PUT in flight during stop does not publish', async () => {
  const m = await mockTasmota((c) => (c.startsWith('Power') ? { delay: 300, json: { POWER: 'ON' } } : { json: STATUS0(false) }))
  const app = mockApp()
  const plugin = createPlugin(app)
  plugin.start({ pollInterval: 5, devices: [device(m.port)] })
  await waitFor(() => app.messages.length === 1)
  let result
  app.puts['electrical.switches.charger.state']('vessels.self', 'x', true, (r) => { result = r })
  await waitFor(() => m.stats.active === 1)
  plugin.stop()
  await waitFor(() => result)
  assert.strictEqual(result.statusCode === 200, false)
  await sleep(400)
  assert.strictEqual(app.messages.length, 1)
  await m.close()
})

test('back-off: failing device is polled less and less often; healthy device unaffected', async () => {
  const bad = await mockTasmota(() => ({ status: 500, body: 'err' }))
  const good = await mockTasmota(() => ({ json: STATUS0() }))
  const app = mockApp()
  const plugin = createPlugin(app)
  plugin.start({ pollInterval: 0.2, devices: [device(bad.port), device(good.port, { id: 'fridge' })] })
  try {
    await sleep(3200)
    const nBad = bad.stats.requests.length
    const nGood = good.stats.requests.length
    // without back-off ~16 polls each; with doubling (0.2,0.4,0.8,1.6 s...) about 5
    assert.ok(nGood >= 12, `good device polled ${nGood}x`)
    assert.ok(nBad <= 6 && nBad >= 3, `bad device polled ${nBad}x`)
    const gaps = bad.stats.requests.slice(1).map((r, i) => r.t - bad.stats.requests[i].t)
    for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] > gaps[i - 1] * 1.5, `gaps grow: ${gaps}`)
    const last = app.statuses.at(-1)
    assert.strictEqual(last.kind, 'error')
    assert.match(last.s, /charger: offline.*HTTP 500/)
    assert.match(last.s, /fridge: OK/)
    assert.ok(statePaths(app).includes('electrical.switches.fridge.state'))
  } finally { plugin.stop(); await bad.close(); await good.close() }
})

test('invalid device config is reported, valid ones still polled', async () => {
  const m = await mockTasmota(() => ({ json: STATUS0() }))
  const app = mockApp()
  const plugin = createPlugin(app)
  plugin.start({ devices: [{ id: 'bad.id', host: 'x' }, device(m.port, { host: `http://127.0.0.1:${m.port}/` })] })
  try {
    await waitFor(() => app.messages.length >= 1)
    assert.match(app.statuses.at(-1).s, /invalid id "bad.id"/)
    assert.strictEqual(app.statuses.at(-1).kind, 'error')
  } finally { plugin.stop(); await m.close() }
})

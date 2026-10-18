'use strict'
const http = require('http')

// Realistic Tasmota "Status 0" reply (trimmed: StatusFWR/LOG/MEM/NET/MQT omitted)
const STATUS0 = (on = true) => ({
  Status: { Module: 0, DeviceName: 'Charger', FriendlyName: ['Charger'], Topic: 'tasmota_charger', Power: on ? '1' : '0', PowerOnState: 3 },
  StatusPRM: { Baudrate: 4800, Uptime: '0T01:02:03' },
  StatusSNS: {
    Time: '2026-10-18T09:00:00',
    ENERGY: { TotalStartTime: '2025-01-01T00:00:00', Total: 48.777, Yesterday: 0.254, Today: 0.643, Power: 39, ApparentPower: 45, ReactivePower: 23, Factor: 0.87, Voltage: 223, Current: 0.203 },
  },
  StatusSTS: { Time: '2026-10-18T09:00:00', Uptime: '0T01:02:03', POWER: on ? 'ON' : 'OFF', Wifi: { RSSI: 70 } },
})

/**
 * Mock Tasmota. behaviour(cmnd, req) -> { delay, hang, status, json, body }
 */
function mockTasmota(behaviour) {
  const stats = { requests: [], active: 0, maxActive: 0, closedEarly: 0 }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const cmnd = u.searchParams.get('cmnd')
    stats.requests.push({ cmnd, t: Date.now() })
    stats.active++
    stats.maxActive = Math.max(stats.maxActive, stats.active)
    let done = false
    const end = () => { if (!done) { done = true; stats.active-- } }
    res.on('close', () => { if (!res.writableFinished) stats.closedEarly++; end() })
    const b = behaviour(cmnd, req) || {}
    if (b.hang) return
    setTimeout(() => {
      res.writeHead(b.status || 200, { 'Content-Type': 'application/json' })
      res.end(b.body != null ? b.body : JSON.stringify(b.json || {}))
    }, b.delay || 0)
  })
  server.keepAliveTimeout = 1
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) })
      resolve({ port: server.address().port, stats, server, close })
    })
  )
}

function mockApp() {
  const app = {
    messages: [], statuses: [], errors: [], logs: [], debugs: [], puts: {},
    handleMessage: (id, delta) => app.messages.push({ t: Date.now(), delta }),
    setPluginStatus: (s) => app.statuses.push({ kind: 'status', s, t: Date.now() }),
    setPluginError: (s) => app.statuses.push({ kind: 'error', s, t: Date.now() }),
    error: (s) => app.errors.push(s),
    debug: (s) => app.debugs.push(s),
    registerPutHandler: (ctx, path, fn) => { app.puts[path] = fn },
  }
  return app
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs = 3000, step = 10) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true
    await sleep(step)
  }
  throw new Error('waitFor timed out')
}

function device(port, extra = {}) {
  return { enabled: true, id: 'charger', name: 'Charger switch', host: '127.0.0.1', port, powerIndex: 1, pollEnergy: true, publishEnergyAsAc: true, ...extra }
}

module.exports = { STATUS0, mockTasmota, mockApp, sleep, waitFor, device }

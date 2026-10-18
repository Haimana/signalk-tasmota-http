'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { _internal: I } = require('../index.js')
const { STATUS0 } = require('./helpers')

test('parsePower handles Power reply, Status 11, Status 0 and Status.Power fallback', () => {
  assert.strictEqual(I.parsePower({ POWER: 'ON' }, 1), true)
  assert.strictEqual(I.parsePower({ POWER1: 'OFF' }, 1), false)
  assert.strictEqual(I.parsePower({ POWER2: 'ON' }, 2), true)
  assert.strictEqual(I.parsePower({ StatusSTS: { POWER: 'OFF' } }, 1), false)
  assert.strictEqual(I.parsePower(STATUS0(true), 1), true)
  assert.strictEqual(I.parsePower(STATUS0(false), 1), false)
  assert.strictEqual(I.parsePower({ Status: { Power: 1 } }, 1), true) // old int
  assert.strictEqual(I.parsePower({ Status: { Power: 2 } }, 2), true) // bitmask
  assert.strictEqual(I.parsePower({ Status: { Power: 2 } }, 1), false)
  assert.strictEqual(I.parsePower({ Status: { Power: '10' } }, 2), true) // binary string, rightmost = relay1
  assert.strictEqual(I.parsePower({ Status: { Power: '10' } }, 1), false)
  assert.strictEqual(I.parsePower({ Foo: 1 }, 1), null)
})

test('pickEnergy reads Status 0 / Status 8 and honours powerIndex', () => {
  const e = I.pickEnergy(STATUS0(), 1)
  assert.strictEqual(e.voltage, 223)
  assert.strictEqual(e.energyKwh, 48.777)
  const multi = { StatusSNS: { ENERGY: { Voltage: 230, Current: [0.1, 0.5], Power: [10, 50], Total: 3 } } }
  assert.deepStrictEqual([I.pickEnergy(multi, 1).current, I.pickEnergy(multi, 1).power], [0.1, 10])
  assert.deepStrictEqual([I.pickEnergy(multi, 2).current, I.pickEnergy(multi, 2).power], [0.5, 50])
  assert.strictEqual(I.pickEnergy(multi, 3).current, null)
  assert.strictEqual(I.pickEnergy(multi, 2).voltage, 230)
  assert.strictEqual(I.pickEnergy({ StatusSTS: {} }, 1), null)
})

test('normalizeHostPort strips scheme/path, handles ports and IPv6', () => {
  assert.deepStrictEqual(I.normalizeHostPort('172.22.22.50', 80), { host: '172.22.22.50', port: 80, https: false })
  assert.deepStrictEqual(I.normalizeHostPort(' http://172.22.22.50/ ', 80), { host: '172.22.22.50', port: 80, https: false })
  assert.deepStrictEqual(I.normalizeHostPort('http://plug.local:8080/cm?x', undefined), { host: 'plug.local', port: 8080, https: false })
  assert.deepStrictEqual(I.normalizeHostPort('https://plug', undefined), { host: 'plug', port: 443, https: true })
  assert.deepStrictEqual(I.normalizeHostPort('fe80::1', 80), { host: '[fe80::1]', port: 80, https: false })
  assert.deepStrictEqual(I.normalizeHostPort('[fe80::1]:81', 80), { host: '[fe80::1]', port: 81, https: false })
  assert.ok(I.normalizeHostPort('', 80).error)
  assert.ok(I.normalizeHostPort('a b', 80).error)
  assert.ok(I.normalizeHostPort('1.2.3.4', 70000).error)
  assert.ok(I.normalizeHostPort('1.2.3.4', 'abc').error)
})

test('validateDevice keeps existing config working and rejects bad ids', () => {
  const ok = I.validateDevice({ id: 'charger', host: '172.22.22.50', port: 80, pollEnergy: true, publishEnergyAsAc: true })
  assert.ok(ok.dev)
  assert.strictEqual(ok.dev.powerIndex, 1)
  assert.strictEqual(ok.dev.pollEnergy, true)
  assert.ok(I.validateDevice({ id: 'my.plug', host: 'x' }).error)
  assert.ok(I.validateDevice({ id: 'a', host: '' }).error)
})

test('pollCmd uses one request per poll', () => {
  assert.strictEqual(I.pollCmd({ pollEnergy: true }), 'Status 0')
  assert.strictEqual(I.pollCmd({ pollEnergy: false }), 'Status 11')
})

test('timings: default 4 s timeout, clamped below interval', () => {
  assert.deepStrictEqual(I.timings({ pollInterval: 5 }), { intervalMs: 5000, timeoutMs: 4000 })
  assert.deepStrictEqual(I.timings({}), { intervalMs: 5000, timeoutMs: 4000 })
  assert.deepStrictEqual(I.timings({ pollInterval: 2, requestTimeout: 10 }), { intervalMs: 2000, timeoutMs: 1750 })
  assert.deepStrictEqual(I.timings({ pollInterval: 10, requestTimeout: 6 }), { intervalMs: 10000, timeoutMs: 6000 })
})

test('backoffDelay doubles and caps at 60 s', () => {
  assert.strictEqual(I.backoffDelay(5000, 1), 5000)
  assert.strictEqual(I.backoffDelay(5000, 2), 10000)
  assert.strictEqual(I.backoffDelay(5000, 3), 20000)
  assert.strictEqual(I.backoffDelay(5000, 10), 60000)
})

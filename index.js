/*
 * Copyright 2026 SeB (sebba@end.ro) - S/V Haimana
 *
 * https://github.com/Haimana/signalk-tasmota-http
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict'

const http = require('http')
const https = require('https')
const { URL } = require('url')

const KWH_TO_J = 3.6e6
const DEFAULT_POLL_INTERVAL_S = 5
const DEFAULT_REQUEST_TIMEOUT_S = 4
const MIN_INTERVAL_MS = 200 // internal floor; the schema still enforces >= 1 s in the UI
const MIN_TIMEOUT_MS = 100
const TIMEOUT_HEADROOM_MS = 250 // timeout is clamped to (interval - headroom)
const MAX_BACKOFF_MS = 60000
const MAX_BODY_BYTES = 200000
const ID_RE = /^[A-Za-z0-9_-]+$/

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

/**
 * Normalise a user-entered host (and optional port) into
 * { host, port, error }. Strips "http(s)://", paths and trailing slashes,
 * extracts an inline ":port", brackets bare IPv6 literals.
 */
function normalizeHostPort(rawHost, rawPort, useHttps) {
  let host = String(rawHost == null ? '' : rawHost).trim()
  let inlinePort = null
  let schemeHttps = null

  const scheme = /^([a-z]+):\/\//i.exec(host)
  if (scheme) {
    schemeHttps = scheme[1].toLowerCase() === 'https'
    host = host.slice(scheme[0].length)
  }
  // drop any path / query / fragment
  host = host.replace(/[/?#].*$/, '')
  // drop user:pass@ if someone pasted a full URL
  if (host.includes('@')) host = host.slice(host.lastIndexOf('@') + 1)

  if (host.startsWith('[')) {
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(host)
    if (!m) return { error: `invalid host "${rawHost}"` }
    host = `[${m[1]}]`
    if (m[2]) inlinePort = Number(m[2])
  } else {
    const colons = (host.match(/:/g) || []).length
    if (colons === 1) {
      const m = /^([^:]+):(\d+)$/.exec(host)
      if (!m) return { error: `invalid host "${rawHost}"` }
      host = m[1]
      inlinePort = Number(m[2])
    } else if (colons > 1) {
      host = `[${host}]` // bare IPv6 literal
    }
  }

  if (!host || host === '[]' || /\s/.test(host)) {
    return { error: `invalid host "${rawHost}"` }
  }

  const https_ = useHttps === true || (useHttps == null && schemeHttps === true)
  let port = rawPort == null || rawPort === '' ? null : Number(rawPort)
  if (port != null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
    return { error: `invalid port "${rawPort}"` }
  }
  // An inline port wins only if the configured port is absent or the default
  if (inlinePort != null && (port == null || port === 80 || port === 443)) {
    port = inlinePort
  }
  if (port == null) port = https_ ? 443 : 80
  if (!(port >= 1 && port <= 65535)) return { error: `invalid port "${port}"` }
  return { host, port, https: https_ }
}

/** Validate one device config entry -> { dev, error }. */
function validateDevice(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'device entry is not an object' }
  const id = String(raw.id == null ? '' : raw.id).trim()
  if (!id) return { error: 'device without id' }
  if (!ID_RE.test(id)) {
    return { error: `invalid id "${id}" (use letters, digits, _ or -)` }
  }
  const hp = normalizeHostPort(raw.host, raw.port, raw.useHttps ? true : null)
  if (hp.error) return { error: `${id}: ${hp.error}` }
  let powerIndex = Number(raw.powerIndex)
  if (!Number.isInteger(powerIndex) || powerIndex < 1) powerIndex = 1
  if (powerIndex > 8) powerIndex = 8
  return {
    dev: {
      id,
      name: raw.name || id,
      host: hp.host,
      port: hp.port,
      useHttps: !!hp.https,
      user: raw.user || '',
      password: raw.password || '',
      powerIndex,
      pollEnergy: raw.pollEnergy !== false,
      publishEnergyAsAc: !!raw.publishEnergyAsAc,
    },
  }
}

function powerCmd(dev, arg) {
  const n = Number(dev.powerIndex) || 1
  const cmd = n <= 1 ? 'Power' : `Power${n}`
  return arg == null || arg === '' ? cmd : `${cmd} ${arg}`
}

/**
 * Command used for one poll cycle. One request per poll:
 *  - energy on : "Status 0"  -> StatusSTS (POWERn) + StatusSNS (ENERGY)
 *  - energy off: "Status 11" -> StatusSTS (POWERn) only (much smaller)
 */
function pollCmd(dev) {
  return dev.pollEnergy ? 'Status 0' : 'Status 11'
}

function buildCmUrl(dev, cmnd) {
  const proto = dev.useHttps ? 'https' : 'http'
  const u = new URL(`${proto}://${dev.host}:${dev.port}/cm`)
  if (dev.user) u.searchParams.set('user', dev.user)
  if (dev.password) u.searchParams.set('password', dev.password)
  u.searchParams.set('cmnd', cmnd)
  return u
}

function onOff(v) {
  if (typeof v === 'number') return v !== 0
  const s = String(v).trim().toUpperCase()
  if (s === 'ON' || s === '1' || s === 'TRUE') return true
  if (s === 'OFF' || s === '0' || s === 'FALSE') return false
  return null
}

/**
 * Extract relay state for powerIndex from any of:
 *  - Power / PowerN command reply   {"POWER":"ON"} / {"POWER2":"OFF"}
 *  - Status 11                      {"StatusSTS":{"POWER":"ON",...}}
 *  - Status 0                       {"Status":{"Power":..},"StatusSTS":{...},...}
 * Returns true/false or null when not found.
 */
function parsePower(json, powerIndex) {
  if (!json || typeof json !== 'object') return null
  const n = Number(powerIndex) || 1
  const keys =
    n <= 1 ? ['POWER', 'POWER1', 'Power', 'Power1'] : [`POWER${n}`, `Power${n}`]
  for (const src of [json, json.StatusSTS]) {
    if (!src || typeof src !== 'object') continue
    for (const k of keys) {
      if (src[k] != null) {
        const v = onOff(src[k])
        if (v != null) return v
      }
    }
  }
  // Last resort: Status 0 "Status.Power". Older Tasmota: integer bitmask
  // (bit0 = relay1); newer: binary string, rightmost char = relay1.
  if (json.Status && json.Status.Power != null) {
    const p = json.Status.Power
    if (typeof p === 'number' && Number.isInteger(p)) return ((p >> (n - 1)) & 1) === 1
    const s = String(p).trim()
    if (/^[01]+$/.test(s)) {
      if (s.length === 1) return n <= 1 ? s === '1' : null
      const idx = s.length - n
      return idx >= 0 ? s[idx] === '1' : null
    }
  }
  return null
}

/**
 * Extract ENERGY from Status 0 / Status 8 / Status 10 / sensor telemetry.
 * Multi-channel devices expose arrays; the element for powerIndex is used.
 */
function pickEnergy(json, powerIndex) {
  if (!json || typeof json !== 'object') return null
  const sns = json.StatusSNS || json
  const e = sns && sns.ENERGY
  if (!e || typeof e !== 'object') return null
  const idx = (Number(powerIndex) || 1) - 1
  const num = (v) => {
    if (v == null) return null
    if (Array.isArray(v)) {
      if (idx >= v.length) return null
      v = v[idx]
    }
    const x = Number(v)
    return Number.isFinite(x) ? x : null
  }
  return {
    voltage: num(e.Voltage),
    current: num(e.Current),
    power: num(e.Power),
    apparentPower: num(e.ApparentPower),
    reactivePower: num(e.ReactivePower),
    powerFactor: num(e.Factor),
    energyKwh: num(e.Total),
    energyTodayKwh: num(e.Today),
    energyYesterdayKwh: num(e.Yesterday),
  }
}

function normalizePutValue(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (['on', 'true', '1', 'yes'].includes(s)) return true
    if (['off', 'false', '0', 'no'].includes(s)) return false
  }
  if (value && typeof value === 'object' && 'value' in value) {
    return normalizePutValue(value.value)
  }
  return null
}

/** Effective timings from options. */
function timings(options) {
  const intervalS = Number(options.pollInterval)
  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    (Number.isFinite(intervalS) && intervalS > 0 ? intervalS : DEFAULT_POLL_INTERVAL_S) * 1000
  )
  const tS = Number(options.requestTimeout)
  let timeoutMs =
    (Number.isFinite(tS) && tS > 0 ? tS : DEFAULT_REQUEST_TIMEOUT_S) * 1000
  timeoutMs = Math.min(timeoutMs, intervalMs - TIMEOUT_HEADROOM_MS)
  timeoutMs = Math.max(MIN_TIMEOUT_MS, timeoutMs)
  return { intervalMs, timeoutMs }
}

/** Delay before the next attempt after `failures` consecutive failures. */
function backoffDelay(intervalMs, failures) {
  if (failures <= 1) return intervalMs
  const cap = Math.max(MAX_BACKOFF_MS, intervalMs)
  return Math.min(cap, intervalMs * Math.pow(2, failures - 1))
}

/**
 * GET a Tasmota /cm URL and parse JSON.
 * - overall deadline (connect + headers + body) of timeoutMs
 * - abortable via AbortSignal
 * - errors carry host, command and elapsed ms
 */
function httpGetJson(url, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_S * 1000, signal, agent } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const cmnd = url.searchParams.get('cmnd') || ''
    const where = `${url.host} "${cmnd}"`
    let settled = false
    let req = null
    let timer = null

    const finish = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (err) {
        const e = new Error(`${err.message} (${where}, ${Date.now() - started} ms)`)
        e.code = err.code
        e.host = url.host
        e.command = cmnd
        e.elapsedMs = Date.now() - started
        reject(e)
      } else resolve(value)
    }
    const fail = (message, code) => {
      const err = new Error(message)
      err.code = code
      finish(err)
      if (req) req.destroy()
    }
    const onAbort = () => fail('aborted', 'ABORT_ERR')

    if (signal && signal.aborted) return onAbort()
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    const lib = url.protocol === 'https:' ? https : http
    timer = setTimeout(() => fail(`timeout after ${timeoutMs} ms`, 'ETIMEDOUT'), timeoutMs)

    try {
      req = lib.get(url, { agent, headers: { Connection: 'close' } }, (res) => {
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          if (settled) return
          size += c.length
          if (size > MAX_BODY_BYTES) {
            fail('response too large', 'E2BIG')
            return
          }
          chunks.push(c)
        })
        res.on('error', (err) => finish(err))
        res.on('aborted', () => fail('response aborted', 'ECONNRESET'))
        res.on('end', () => {
          if (settled) return
          const body = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode && res.statusCode >= 400) {
            finish(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 120)}`))
            return
          }
          try {
            finish(null, JSON.parse(body))
          } catch (e) {
            finish(new Error(`invalid JSON from Tasmota: ${body.slice(0, 80)}`))
          }
        })
      })
      req.on('error', (err) => finish(err))
    } catch (err) {
      finish(err)
    }
  })
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

module.exports = function (app) {
  const plugin = {
    id: 'signalk-tasmota-http',
    name: 'Tasmota HTTP switches',
    description:
      'Poll and control Tasmota plugs/relays via HTTP, including energy sensors. No MQTT broker required.',
  }

  // Per-run state. `generation` increments on every start/stop so callbacks
  // belonging to an older run can detect that and do nothing.
  let generation = 0
  let running = false
  let pollTimer = null
  let options = { pollInterval: DEFAULT_POLL_INTERVAL_S, devices: [] }
  let devices = [] // validated device configs
  let configErrors = []
  let agents = null
  const deviceState = new Map() // id -> runtime state
  const sentMeta = new Set() // paths whose meta has been published this run
  const controllers = new Set() // in-flight AbortControllers
  const putRegistered = new Set() // ids with a PUT handler (server keeps them)
  const putDevices = new Map() // id -> current validated dev (PUT handler looks up)
  let lastStatusText = null

  plugin.schema = {
    type: 'object',
    title: 'Tasmota HTTP',
    properties: {
      pollInterval: {
        type: 'number',
        title: 'Poll interval (seconds)',
        description:
          'Pause between the end of one poll cycle and the start of the next',
        default: DEFAULT_POLL_INTERVAL_S,
        minimum: 1,
      },
      requestTimeout: {
        type: 'number',
        title: 'Request timeout (seconds)',
        description:
          'Overall deadline for one HTTP request to a device (connect + response). Clamped to slightly below the poll interval.',
        default: DEFAULT_REQUEST_TIMEOUT_S,
        minimum: 0.5,
      },
      devices: {
        type: 'array',
        title: 'Devices',
        default: [],
        items: {
          type: 'object',
          required: ['id', 'host'],
          properties: {
            enabled: { type: 'boolean', title: 'Enabled', default: true },
            id: {
              type: 'string',
              title: 'Signal K id',
              description:
                'Id for paths: electrical.switches.<id>.state and energy paths (e.g. charger). Letters, digits, _ and - only.',
              default: 'plug1',
              pattern: '^[A-Za-z0-9_-]+$',
            },
            name: {
              type: 'string',
              title: 'Display name',
              default: 'Tasmota plug',
            },
            host: {
              type: 'string',
              title: 'Host / IP',
              description:
                'e.g. 172.22.22.50 or tasmota-xxxx.local (a fixed IP is more reliable than .local)',
            },
            port: {
              type: 'number',
              title: 'HTTP port',
              default: 80,
              minimum: 1,
              maximum: 65535,
            },
            useHttps: {
              type: 'boolean',
              title: 'Use HTTPS',
              default: false,
            },
            user: {
              type: 'string',
              title: 'Tasmota web user (optional)',
              default: '',
            },
            password: {
              type: 'string',
              title: 'Tasmota web password (optional)',
              default: '',
            },
            powerIndex: {
              type: 'number',
              title: 'Power channel',
              description: '1 = POWER / POWER1, 2 = POWER2, …',
              default: 1,
              minimum: 1,
              maximum: 8,
            },
            pollEnergy: {
              type: 'boolean',
              title: 'Poll energy / voltage / current',
              description:
                'Uses Tasmota Status 0 (state + ENERGY in one request). Leave on for metering plugs; off for plain relays (uses the smaller Status 11).',
              default: true,
            },
            publishEnergyAsAc: {
              type: 'boolean',
              title: 'Publish energy on electrical.ac paths',
              description:
                'On: electrical.ac.<id>.phase.single.* (Signal K AC). Off: electrical.switches.<id>.* (next to state). Switch on/off always stays on electrical.switches.<id>.state.',
              default: false,
            },
          },
        },
      },
    },
  }

  plugin.uiSchema = {
    devices: {
      items: {
        password: { 'ui:widget': 'password' },
      },
    },
  }

  function statePath(id) {
    return `electrical.switches.${id}.state`
  }

  function energyPathSpecs(dev, energy) {
    const id = dev.id
    const label = dev.name || id
    const asAc = !!dev.publishEnergyAsAc

    // Units follow the Signal K specification (schemas/groups/electrical.json):
    // apparentPower and reactivePower are declared with units "W" there
    // (physically VA / var); "VA"/"var" are not Signal K units.
    const rows = [
      { switchesKey: 'voltage', acKey: 'lineNeutralVoltage', value: energy.voltage, units: 'V', description: `Tasmota voltage: ${label}` },
      { switchesKey: 'current', acKey: 'current', value: energy.current, units: 'A', description: `Tasmota current: ${label}` },
      { switchesKey: 'power', acKey: 'realPower', value: energy.power, units: 'W', description: `Tasmota active power: ${label}` },
      { switchesKey: 'apparentPower', acKey: 'apparentPower', value: energy.apparentPower, units: 'W', description: `Tasmota apparent power (VA): ${label}` },
      { switchesKey: 'reactivePower', acKey: 'reactivePower', value: energy.reactivePower, units: 'W', description: `Tasmota reactive power (var): ${label}` },
      { switchesKey: 'powerFactor', acKey: 'powerFactor', value: energy.powerFactor, units: 'ratio', description: `Tasmota power factor: ${label}` },
      {
        switchesKey: 'energy', acKey: 'energy',
        value: energy.energyKwh == null ? null : energy.energyKwh * KWH_TO_J,
        units: 'J', description: `Tasmota total energy: ${label}`,
        acUnderBus: true, // not in phase.single schema; hang on bus id
      },
      {
        switchesKey: 'energyToday', acKey: 'energyToday',
        value: energy.energyTodayKwh == null ? null : energy.energyTodayKwh * KWH_TO_J,
        units: 'J', description: `Tasmota energy today: ${label}`, acUnderBus: true,
      },
      {
        switchesKey: 'energyYesterday', acKey: 'energyYesterday',
        value: energy.energyYesterdayKwh == null ? null : energy.energyYesterdayKwh * KWH_TO_J,
        units: 'J', description: `Tasmota energy yesterday: ${label}`, acUnderBus: true,
      },
    ]

    return rows
      .filter((r) => r.value != null)
      .map((r) => {
        let path
        if (asAc) {
          path = r.acUnderBus
            ? `electrical.ac.${id}.${r.acKey}`
            : `electrical.ac.${id}.phase.single.${r.acKey}`
        } else {
          path = `electrical.switches.${id}.${r.switchesKey}`
        }
        return {
          path,
          value: r.value,
          meta: {
            description: r.description,
            displayName: `${label} ${asAc ? r.acKey : r.switchesKey}`,
            units: r.units,
          },
        }
      })
  }

  /** Publish values; meta only for paths not yet described in this run. */
  function publish(gen, specs) {
    if (gen !== generation || !running || !specs.length) return
    const meta = []
    for (const s of specs) {
      if (s.meta && !sentMeta.has(s.path)) {
        meta.push({ path: s.path, value: s.meta })
        sentMeta.add(s.path)
      }
    }
    const update = { values: specs.map((s) => ({ path: s.path, value: s.value })) }
    if (meta.length) update.meta = meta
    app.handleMessage(plugin.id, { updates: [update] })
  }

  function stateSpec(dev, on) {
    return {
      path: statePath(dev.id),
      value: !!on,
      meta: {
        // No units: 'bool' — KIP would classify the path as number
        description: dev.name ? `Tasmota: ${dev.name}` : 'Tasmota switch',
        displayName: dev.name || dev.id,
        type: 'boolean',
        supportsPut: true,
      },
    }
  }

  function getState(id) {
    let st = deviceState.get(id)
    if (!st) {
      st = {
        queue: Promise.resolve(),
        failures: 0,
        online: null, // null = unknown, true, false
        offlineSince: null,
        lastError: null,
        nextPollAt: 0,
        lastOn: undefined,
      }
      deviceState.set(id, st)
    }
    return st
  }

  /** Run fn exclusively for this device (polls and PUTs never overlap). */
  function enqueue(dev, fn) {
    const st = getState(dev.id)
    const run = st.queue.then(fn, fn)
    st.queue = run.catch(() => {})
    return run
  }

  function request(gen, dev, cmnd) {
    if (gen !== generation || !running) {
      return Promise.reject(new Error('plugin stopped'))
    }
    const ac = new AbortController()
    controllers.add(ac)
    const url = buildCmUrl(dev, cmnd)
    const agent = dev.useHttps ? agents.https : agents.http
    return httpGetJson(url, {
      timeoutMs: timings(options).timeoutMs,
      signal: ac.signal,
      agent,
    }).finally(() => controllers.delete(ac))
  }

  function markSuccess(gen, dev) {
    if (gen !== generation) return
    const st = getState(dev.id)
    if (st.online === false) {
      const down = st.offlineSince ? Math.round((Date.now() - st.offlineSince) / 1000) : 0
      if (app.error) app.error(`tasmota ${dev.id} @ ${dev.host}: back online after ${down}s`)
    }
    st.failures = 0
    st.online = true
    st.offlineSince = null
    st.lastError = null
    st.nextPollAt = 0
    updateStatus()
  }

  function markFailure(gen, dev, err) {
    if (gen !== generation || !running) return
    const st = getState(dev.id)
    st.failures += 1
    st.lastError = err.message
    const { intervalMs } = timings(options)
    st.nextPollAt = Date.now() + backoffDelay(intervalMs, st.failures)
    if (st.online !== false) {
      st.online = false
      st.offlineSince = Date.now()
      // logged once per online->offline transition, not on every poll
      if (app.error) app.error(`tasmota ${dev.id} @ ${dev.host}: offline: ${err.message}`)
    }
    app.debug(`tasmota poll ${dev.id} (failure #${st.failures}): ${err.message}`)
    updateStatus()
  }

  function updateStatus() {
    if (!running) return
    const { intervalMs } = timings(options)
    const parts = []
    let bad = 0
    for (const dev of devices) {
      const st = getState(dev.id)
      if (st.online === false) {
        bad++
        const since = new Date(st.offlineSince).toISOString().slice(11, 19)
        parts.push(`${dev.id}: offline since ${since}Z – ${st.lastError}`)
      } else if (st.online === true) {
        parts.push(`${dev.id}: OK`)
      } else {
        parts.push(`${dev.id}: waiting`)
      }
    }
    for (const e of configErrors) {
      bad++
      parts.push(`config: ${e}`)
    }
    let text
    if (!devices.length && !configErrors.length) text = 'No devices configured'
    else {
      const withEnergy = devices.filter((d) => d.pollEnergy).length
      text =
        `${devices.length} device(s) every ${intervalMs / 1000}s (${withEnergy} with energy) — ` +
        parts.join('; ')
    }
    const key = (bad ? 'E:' : 'S:') + text
    if (key === lastStatusText) return
    lastStatusText = key
    if (bad && app.setPluginError) app.setPluginError(text)
    else app.setPluginStatus(text)
  }

  async function pollDevice(gen, dev) {
    const json = await request(gen, dev, pollCmd(dev))
    let on = parsePower(json, dev.powerIndex)
    if (on == null) {
      // Very old firmware without StatusSTS in Status 0: ask Power explicitly
      const pj = await request(gen, dev, powerCmd(dev, ''))
      on = parsePower(pj, dev.powerIndex)
      if (on == null) throw new Error(`no POWER field in response from ${dev.host}`)
    }
    if (gen !== generation || !running) return
    const st = getState(dev.id)
    if (st.lastOn !== on) app.debug(`tasmota ${dev.id} @ ${dev.host} -> ${on ? 'ON' : 'OFF'}`)
    st.lastOn = on
    const specs = [stateSpec(dev, on)]
    if (dev.pollEnergy) {
      const energy = pickEnergy(json, dev.powerIndex)
      if (energy) specs.push(...energyPathSpecs(dev, energy))
      else app.debug(`tasmota ${dev.id}: no ENERGY in ${pollCmd(dev)}`)
    }
    publish(gen, specs)
  }

  async function pollCycle(gen) {
    const now = Date.now()
    const { intervalMs } = timings(options)
    await Promise.all(
      devices.map(async (dev) => {
        const st = getState(dev.id)
        if (st.nextPollAt - now > intervalMs / 2) return // backing off
        try {
          await enqueue(dev, () => pollDevice(gen, dev))
          markSuccess(gen, dev)
        } catch (err) {
          markFailure(gen, dev, err)
        }
      })
    )
  }

  function scheduleNext(gen, delay) {
    if (gen !== generation || !running) return
    pollTimer = setTimeout(async () => {
      pollTimer = null
      if (gen !== generation || !running) return
      try {
        await pollCycle(gen)
      } catch (err) {
        app.debug(`tasmota poll cycle error: ${err.message}`)
      }
      // next cycle starts only after this one has completely finished
      scheduleNext(gen, timings(options).intervalMs)
    }, delay)
  }

  async function handlePut(id, value, callback) {
    const gen = generation
    const dev = putDevices.get(id)
    const done = (result) => {
      if (typeof callback === 'function') callback(result)
    }
    if (!running || !dev) {
      done({ state: 'COMPLETED', statusCode: 503, message: 'plugin not running' })
      return
    }
    const on = normalizePutValue(value)
    try {
      const got = await enqueue(dev, async () => {
        const json = await request(gen, dev, powerCmd(dev, on ? 'ON' : 'OFF'))
        const g = parsePower(json, dev.powerIndex)
        if (g == null) throw new Error(`set failed: ${JSON.stringify(json).slice(0, 120)}`)
        return g
      })
      if (gen !== generation || !running) {
        done({ state: 'COMPLETED', statusCode: 503, message: 'plugin stopped' })
        return
      }
      getState(dev.id).lastOn = got
      publish(gen, [stateSpec(dev, got)])
      markSuccess(gen, dev)
      done({ state: 'COMPLETED', statusCode: 200 })
    } catch (err) {
      done({ state: 'COMPLETED', statusCode: 502, message: err.message })
    }
  }

  function registerPuts() {
    for (const dev of devices) {
      putDevices.set(dev.id, dev)
      // The server has no unregister API; handlers survive restarts, so only
      // register once per id and look the current config up at call time.
      if (putRegistered.has(dev.id)) continue
      putRegistered.add(dev.id)
      const id = dev.id
      app.registerPutHandler(
        'vessels.self',
        statePath(id),
        (context, p, value, callback) => {
          if (normalizePutValue(value) == null) {
            return { state: 'COMPLETED', statusCode: 400, message: 'Expected boolean / on|off' }
          }
          if (!running || !putDevices.has(id)) {
            return { state: 'COMPLETED', statusCode: 503, message: 'plugin not running' }
          }
          handlePut(id, value, callback)
          return { state: 'PENDING' }
        },
        plugin.id
      )
    }
  }

  plugin.start = function (opts) {
    if (running) plugin.stop()
    generation += 1
    const gen = generation
    running = true
    options = Object.assign(
      { pollInterval: DEFAULT_POLL_INTERVAL_S, requestTimeout: DEFAULT_REQUEST_TIMEOUT_S, devices: [] },
      opts || {}
    )
    agents = {
      http: new http.Agent({ keepAlive: false, maxSockets: 4 }),
      https: new https.Agent({ keepAlive: false, maxSockets: 4 }),
    }
    devices = []
    configErrors = []
    const seen = new Set()
    for (const raw of options.devices || []) {
      if (!raw || raw.enabled === false) continue
      const { dev, error } = validateDevice(raw)
      if (error) {
        configErrors.push(error)
        app.error && app.error(`tasmota config: ${error}`)
        continue
      }
      if (seen.has(dev.id)) {
        configErrors.push(`duplicate id "${dev.id}"`)
        continue
      }
      seen.add(dev.id)
      devices.push(dev)
    }
    sentMeta.clear()
    deviceState.clear()
    putDevices.clear()
    lastStatusText = null

    registerPuts()
    updateStatus()
    scheduleNext(gen, 0)
  }

  plugin.stop = function () {
    running = false
    generation += 1
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    for (const ac of controllers) ac.abort()
    controllers.clear()
    if (agents) {
      agents.http.destroy()
      agents.https.destroy()
      agents = null
    }
    putDevices.clear()
    deviceState.clear()
    sentMeta.clear()
  }

  return plugin
}

module.exports._internal = {
  normalizeHostPort,
  validateDevice,
  parsePower,
  pickEnergy,
  pollCmd,
  powerCmd,
  buildCmUrl,
  httpGetJson,
  timings,
  backoffDelay,
  normalizePutValue,
}

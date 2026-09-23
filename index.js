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

module.exports = function (app) {
  const plugin = {
    id: 'signalk-tasmota-http',
    name: 'Tasmota HTTP switches',
    description:
      'Poll and control Tasmota plugs/relays via HTTP, including energy sensors. No MQTT broker required.',
  }

  let pollTimer = null
  let options = { pollInterval: 5, devices: [] }
  const lastState = new Map() // id -> boolean|undefined

  plugin.schema = {
    type: 'object',
    title: 'Tasmota HTTP',
    properties: {
      pollInterval: {
        type: 'number',
        title: 'Poll interval (seconds)',
        description: 'How often to query each device over HTTP',
        default: 5,
        minimum: 1,
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
                'Id for paths: electrical.switches.<id>.state and energy paths (e.g. charger)',
              default: 'plug1',
            },
            name: {
              type: 'string',
              title: 'Display name',
              default: 'Tasmota plug',
            },
            host: {
              type: 'string',
              title: 'Host / IP',
              description: 'e.g. 172.22.22.50 or tasmota-xxxx.local',
            },
            port: {
              type: 'number',
              title: 'HTTP port',
              default: 80,
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
                'Uses Tasmota Status 8 (ENERGY). Leave on for metering plugs; off for plain relays.',
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

    // Map Tasmota ENERGY → either switches.* or electrical.ac.*.phase.single.*
    const rows = [
      {
        switchesKey: 'voltage',
        acKey: 'lineNeutralVoltage',
        value: energy.voltage,
        units: 'V',
        description: `Tasmota voltage: ${label}`,
      },
      {
        switchesKey: 'current',
        acKey: 'current',
        value: energy.current,
        units: 'A',
        description: `Tasmota current: ${label}`,
      },
      {
        switchesKey: 'power',
        acKey: 'realPower',
        value: energy.power,
        units: 'W',
        description: `Tasmota active power: ${label}`,
      },
      {
        switchesKey: 'apparentPower',
        acKey: 'apparentPower',
        value: energy.apparentPower,
        units: 'W',
        description: `Tasmota apparent power: ${label}`,
      },
      {
        switchesKey: 'reactivePower',
        acKey: 'reactivePower',
        value: energy.reactivePower,
        units: 'W',
        description: `Tasmota reactive power: ${label}`,
      },
      {
        switchesKey: 'powerFactor',
        acKey: 'powerFactor',
        value: energy.powerFactor,
        units: 'ratio',
        description: `Tasmota power factor: ${label}`,
      },
      {
        switchesKey: 'energy',
        acKey: 'energy',
        value: energy.energyKwh == null ? null : energy.energyKwh * KWH_TO_J,
        units: 'J',
        description: `Tasmota total energy: ${label}`,
        acUnderBus: true, // not in phase.single schema; hang on bus id
      },
      {
        switchesKey: 'energyToday',
        acKey: 'energyToday',
        value:
          energy.energyTodayKwh == null
            ? null
            : energy.energyTodayKwh * KWH_TO_J,
        units: 'J',
        description: `Tasmota energy today: ${label}`,
        acUnderBus: true,
      },
      {
        switchesKey: 'energyYesterday',
        acKey: 'energyYesterday',
        value:
          energy.energyYesterdayKwh == null
            ? null
            : energy.energyYesterdayKwh * KWH_TO_J,
        units: 'J',
        description: `Tasmota energy yesterday: ${label}`,
        acUnderBus: true,
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
          units: r.units,
          description: r.description,
          displayName: `${label} ${asAc ? r.acKey : r.switchesKey}`,
        }
      })
  }

  function powerCmd(dev, arg) {
    const n = Number(dev.powerIndex) || 1
    const cmd = n <= 1 ? 'Power' : `Power${n}`
    return arg == null || arg === '' ? cmd : `${cmd} ${arg}`
  }

  function buildCmUrl(dev, cmnd) {
    const proto = dev.useHttps ? 'https' : 'http'
    const port = dev.port || (dev.useHttps ? 443 : 80)
    const u = new URL(`${proto}://${dev.host}:${port}/cm`)
    if (dev.user) u.searchParams.set('user', dev.user)
    if (dev.password) u.searchParams.set('password', dev.password)
    u.searchParams.set('cmnd', cmnd)
    return u
  }

  function httpGetJson(url, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http
      const req = lib.get(url, { timeout: timeoutMs }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          body += c
          if (body.length > 200000) {
            req.destroy()
            reject(new Error('response too large'))
          }
        })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 120)}`))
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch (e) {
            reject(new Error(`Invalid JSON from Tasmota: ${body.slice(0, 80)}`))
          }
        })
      })
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('timeout'))
      })
      req.on('error', reject)
    })
  }

  function parsePower(json, powerIndex) {
    const n = Number(powerIndex) || 1
    const keys =
      n <= 1
        ? ['POWER', 'POWER1', 'Power', 'Power1']
        : [`POWER${n}`, `Power${n}`]
    for (const k of keys) {
      if (json[k] != null) return String(json[k]).toUpperCase() === 'ON'
    }
    if (json.StatusSTS) {
      for (const k of keys) {
        if (json.StatusSTS[k] != null) {
          return String(json.StatusSTS[k]).toUpperCase() === 'ON'
        }
      }
    }
    // Status 0: Status.Power is 0/1
    if (json.Status && json.Status.Power != null && n <= 1) {
      return Number(json.Status.Power) !== 0
    }
    return null
  }

  function pickEnergy(json) {
    const sns = json.StatusSNS || json
    const e = sns.ENERGY
    if (!e || typeof e !== 'object') return null
    // Multi-channel Tasmota may expose arrays; take channel 0 / scalar
    const num = (v) => {
      if (v == null) return null
      if (Array.isArray(v)) v = v[0]
      const n = Number(v)
      return Number.isFinite(n) ? n : null
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

  function publishState(id, on, name) {
    const path = statePath(id)
    app.handleMessage(plugin.id, {
      updates: [
        {
          meta: [
            {
              path,
              value: {
                // No units: 'bool' — KIP would classify the path as number
                description: name ? `Tasmota: ${name}` : 'Tasmota switch',
                displayName: name || id,
                type: 'boolean',
                supportsPut: true,
              },
            },
          ],
          values: [{ path, value: !!on }],
        },
      ],
    })
    lastState.set(id, !!on)
  }

  function publishEnergy(dev, energy) {
    const specs = energyPathSpecs(dev, energy)
    if (!specs.length) return
    const meta = specs.map((s) => ({
      path: s.path,
      value: {
        description: s.description,
        displayName: s.displayName,
        units: s.units,
      },
    }))
    const values = specs.map((s) => ({ path: s.path, value: s.value }))
    app.handleMessage(plugin.id, { updates: [{ meta, values }] })
  }

  async function queryDevice(dev) {
    const url = buildCmUrl(dev, powerCmd(dev, ''))
    const json = await httpGetJson(url)
    const on = parsePower(json, dev.powerIndex)
    if (on == null) {
      throw new Error(`No POWER field in response: ${JSON.stringify(json)}`)
    }
    return on
  }

  async function queryEnergy(dev) {
    const url = buildCmUrl(dev, 'Status 8')
    const json = await httpGetJson(url)
    return pickEnergy(json)
  }

  async function setDevice(dev, on) {
    const url = buildCmUrl(dev, powerCmd(dev, on ? 'ON' : 'OFF'))
    const json = await httpGetJson(url)
    const got = parsePower(json, dev.powerIndex)
    if (got == null) {
      throw new Error(`Set failed: ${JSON.stringify(json)}`)
    }
    return got
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

  function enabledDevices() {
    return (options.devices || []).filter(
      (d) => d && d.enabled !== false && d.id && d.host
    )
  }

  async function pollAll() {
    for (const dev of enabledDevices()) {
      try {
        const on = await queryDevice(dev)
        if (lastState.get(dev.id) !== on) {
          app.debug(`tasmota ${dev.id} @ ${dev.host} -> ${on ? 'ON' : 'OFF'}`)
        }
        publishState(dev.id, on, dev.name)

        if (dev.pollEnergy !== false) {
          try {
            const energy = await queryEnergy(dev)
            if (energy) publishEnergy(dev, energy)
            else app.debug(`tasmota ${dev.id}: no ENERGY in Status 8`)
          } catch (err) {
            app.debug(`tasmota energy ${dev.id}: ${err.message}`)
          }
        }
      } catch (err) {
        app.setPluginError?.(`tasmota ${dev.id}: ${err.message}`)
        app.debug(`tasmota poll ${dev.id}: ${err.message}`)
      }
    }
  }

  function registerPuts() {
    for (const dev of enabledDevices()) {
      const path = statePath(dev.id)
      app.registerPutHandler(
        'vessels.self',
        path,
        (context, p, value, callback) => {
          const on = normalizePutValue(value)
          if (on == null) {
            return {
              state: 'COMPLETED',
              statusCode: 400,
              message: 'Expected boolean / on|off',
            }
          }
          setDevice(dev, on)
            .then((got) => {
              publishState(dev.id, got, dev.name)
              const result = { state: 'COMPLETED', statusCode: 200 }
              if (typeof callback === 'function') callback(result)
            })
            .catch((err) => {
              const result = {
                state: 'COMPLETED',
                statusCode: 502,
                message: err.message,
              }
              if (typeof callback === 'function') callback(result)
            })
          return { state: 'PENDING' }
        },
        plugin.id
      )
      publishState(
        dev.id,
        lastState.has(dev.id) ? lastState.get(dev.id) : false,
        dev.name
      )
    }
  }

  plugin.start = function (opts) {
    options = Object.assign({ pollInterval: 5, devices: [] }, opts || {})
    const interval = Math.max(1, Number(options.pollInterval) || 5) * 1000

    registerPuts()
    pollAll()
    pollTimer = setInterval(pollAll, interval)

    const n = enabledDevices().length
    const withEnergy = enabledDevices().filter((d) => d.pollEnergy !== false)
      .length
    app.setPluginStatus(
      n === 0
        ? 'No devices configured'
        : `Polling ${n} Tasmota device(s) every ${options.pollInterval}s (${withEnergy} with energy)`
    )
  }

  plugin.stop = function () {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    lastState.clear()
  }

  return plugin
}

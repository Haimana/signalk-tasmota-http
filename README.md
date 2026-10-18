# signalk-tasmota-http

Signal K server plugin that polls and switches **Tasmota** plugs/relays over the device's HTTP `/cm` API, including energy metering. No MQTT broker or Node-RED needed.

## Install

Signal K Admin UI → **App Store** → search `signalk-tasmota-http` → Install, restart the server, then enable **Tasmota HTTP switches** under **Server → Plugin Config**.

Requires Node.js ≥ 18 and HTTP access from the server to each device.

## Configuration

| Option | Default | Notes |
|--------|---------|-------|
| Poll interval | 5 s | Pause between the end of one poll cycle and the start of the next |
| Request timeout | 4 s | Overall deadline per HTTP request; clamped below the poll interval |
| Signal K id | `plug1` | Used in paths; letters, digits, `_`, `-` (e.g. `charger`) |
| Display name | | Shown in UIs |
| Host / IP | | e.g. `192.168.1.50`; a fixed IP is more reliable than `.local` |
| HTTP port / Use HTTPS | 80 / off | |
| Web user / password | | Only if the Tasmota web UI is password protected |
| Power channel | 1 | `1` = POWER/POWER1, `2` = POWER2 … |
| Poll energy | on | One `Status 0` request per poll; off = `Status 11` (state only) |
| Publish energy on `electrical.ac` | off | See paths below |

## Signal K paths

Switch state (always): `electrical.switches.<id>.state` (boolean).

Energy, default: `electrical.switches.<id>.{voltage, current, power, apparentPower, reactivePower, powerFactor, energy, energyToday, energyYesterday}`

Energy with the `electrical.ac` option: `electrical.ac.<id>.phase.single.{lineNeutralVoltage, current, realPower, apparentPower, reactivePower, powerFactor}` plus `electrical.ac.<id>.{energy, energyToday, energyYesterday}`.

Units are SI as in the Signal K spec: V, A, W, ratio, and energy in J (kWh × 3.6e6).

## Switching (PUT)

`electrical.switches.<id>.state` accepts PUT with `true`/`false`, `1`/`0` or `"on"`/`"off"`, e.g. from KIP, WilhelmSK or:

```bash
curl -X PUT -H 'Content-Type: application/json' -d '{"value": true}' \
  http://<server>:3000/signalk/v1/api/vessels/self/electrical/switches/charger/state
```

Polls and switch commands to the same device never overlap.

## Troubleshooting

- The plugin status shows each device, e.g. `charger: OK` or `charger: offline since 06:25:03Z – timeout after 4000 ms (192.168.1.50:80 "Status 0", 4001 ms)` (UTC). It clears by itself when the device answers again.
- Offline devices are retried with back-off (up to 60 s). Going offline and coming back are logged once each in the server log.
- Frequent timeouts: check Wi-Fi signal (`RSSI` in Tasmota), use a fixed IP, raise the request timeout or poll interval.
- Wrong voltage/current/power: calibrate on the device (`VoltageSet`, `CurrentSet`, `PowerSet`).

## Development

`npm test` runs the `node:test` suite against a mock Tasmota server (no dependencies).

## License

Apache-2.0 © SeB / S/V Haimana. The app icon uses the TASMOTA symbol from [arendst/Tasmota](https://github.com/arendst/Tasmota/tree/development/tools/logo) (GPL-3.0); TASMOTA is a project of Theo Arends, and this plugin is not affiliated with it.

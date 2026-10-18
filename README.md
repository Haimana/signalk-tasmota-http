# signalk-tasmota-http

Signal K Node Server plugin to **poll and control Tasmota** smart plugs / relays using the device **HTTP `/cm` API**.

- No Mosquitto / MQTT  
- No Node-RED  
- Optional energy metering (Status 8)  
- Per-device choice: publish energy under `electrical.switches.*` or official `electrical.ac.*.phase.single.*`

## Install

From the Signal K App Store, or:

```bash
cd ~/.signalk
npm install signalk-tasmota-http
```

Then enable **Tasmota HTTP switches** under Server → Plugin Config.

## Config

| Field | Notes |
|-------|--------|
| poll interval | seconds between the end of one poll cycle and the start of the next (default 5) |
| request timeout | overall deadline per HTTP request, seconds (default 4, clamped below the poll interval) |
| id | e.g. `charger` (letters, digits, `_`, `-`) |
| host | device IP (a fixed IP is more reliable than `.local`); a pasted URL like `http://1.2.3.4/` is accepted |
| power channel | `1` for single relay |
| poll energy | one `Status 0` request per poll (state + ENERGY); off = `Status 11` (state only) |
| publish energy on electrical.ac paths | per-plug checkbox |

## How polling works

- One request per device per poll; requests to the same device (polls and switch
  commands) never overlap.
- The next poll cycle starts only after the previous one has finished.
- A device that fails is retried with back-off (1×, 2×, 4× … the interval, max 60 s);
  going offline and coming back are logged once each.
- The plugin status shows a per-device summary, e.g. `charger: OK` or
  `charger: offline since 06:25:03Z – timeout after 4000 ms (172.22.22.50:80 "Status 0", 4001 ms)`
  (time in UTC). The error clears automatically when the device answers again.

## Paths

### Always (on/off)

`electrical.switches.<id>.state` — boolean, PUT (`true`/`false`, `on`/`off`)

### Energy — AC checkbox off (default)

`electrical.switches.<id>.{voltage,current,power,apparentPower,reactivePower,powerFactor,energy,energyToday,energyYesterday}`

### Energy — AC checkbox on

`electrical.ac.<id>.phase.single.{lineNeutralVoltage,current,realPower,apparentPower,reactivePower,powerFactor}`  
plus `electrical.ac.<id>.{energy,energyToday,energyYesterday}` (Joules)

## Tasmota

Device must be reachable on HTTP from the Pi. For correct voltage/current/power, calibrate on the device (`VoltageSet`, `CurrentSet`, `PowerSet`) — Signal K publishes the values Tasmota reports.

## Development

```bash
npm test   # node:test + mock Tasmota server, no dependencies (Node >= 18)
```

## License

Apache-2.0 — SeB / S/V Haimana

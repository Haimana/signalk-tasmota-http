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
| id | e.g. `charger` |
| host | device IP |
| power channel | `1` for single relay |
| poll energy | Status 8 ENERGY |
| publish energy on electrical.ac paths | per-plug checkbox |

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

## License

Apache-2.0 — SeB / S/V Haimana

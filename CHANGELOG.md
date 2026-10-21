# Changelog

## 1.1.1 — 2026-10-21

- Include test suite in npm package so the Plugin Registry can run it.
- Normalize `repository.url` in package.json.

## 1.1.0 — 2026-10-18

Robustness release, focused on the `timeout` errors seen on some installs.

### Fixed
- **Polls no longer overlap.** The poll loop now uses a self-scheduling `setTimeout`:
  the next cycle starts `pollInterval` seconds after the previous one has fully finished.
  Previously `setInterval` started a new cycle every interval even if the last one was
  still waiting for a slow device, stacking parallel requests onto the single-threaded
  Tasmota web server and causing a cascade of timeouts.
- **Per-device serialisation.** Polls and PUTs (switch on/off) to the same device are
  queued, so there is never more than one request in flight per device.
- **Plugin error is cleared on recovery.** A single timeout used to leave
  `tasmota <id>: timeout` in the admin UI forever. The status is now a per-device summary
  (`charger: OK` / `charger: offline since … – <reason>`), shown via `setPluginStatus`
  when everything is healthy and `setPluginError` while any device is failing.
- **Clean stop / restart.** `stop()` bumps a generation counter, aborts open HTTP
  requests and destroys the HTTP agents; results from an older run (polls or PUTs) are
  never published.
- **No fake initial state.** The switch state is no longer published as `false` at
  start-up before the device has actually been queried.
- `httpGetJson`: "response too large" now settles once and stops reading;
  `res.on('error')`/`aborted` handled; promise is settled exactly once.
- `pickEnergy` honours `powerIndex` for multi-channel energy arrays (was always channel 1).
- PUT handlers are registered only once per id (the server has no unregister), so a
  plugin restart no longer stacks handlers.

### Changed
- **One request per poll**: `Status 0` (relay state from `StatusSTS` + `StatusSNS.ENERGY`)
  when energy polling is on, `Status 11` when it is off. Previously two requests
  (`Power` + `Status 8`). Falls back to `Power` if a very old firmware lacks `StatusSTS`.
- **Request timeout** is configurable (`requestTimeout`, default 4 s as before) and is now
  an *overall* deadline (connect + headers + body), not just a socket idle timeout. It is
  clamped to 250 ms below the poll interval. Errors read e.g.
  `timeout after 4000 ms (172.22.22.50:80 "Status 0", 4002 ms)` (passwords are never included).
- **Back-off** for failing devices: 1×, 2×, 4×, … the poll interval, capped at 60 s.
  Offline and back-online transitions are logged once each (server log), not every poll.
- Meta is sent once per path per plugin run (and again after a restart), not on every poll.
- Dedicated HTTP agent with `keepAlive: false` and `Connection: close` (Node ≥ 19 enables
  keep-alive on the global agent; ESP web servers handle stale reused sockets poorly).
- Config validation: id must match `^[A-Za-z0-9_-]+$`; host may be pasted as a URL
  (`http://1.2.3.4:8080/` → host `1.2.3.4`, port `8080`); bare IPv6 is bracketed; port
  must be 1–65535; duplicate ids rejected. Invalid entries are reported in the plugin
  status, valid devices keep working.
- Apparent/reactive power keep `units: "W"` as declared by the Signal K specification
  (`schemas/groups/electrical.json`); descriptions now say "(VA)" / "(var)".

### Added
- App Store metadata: `signalk.displayName` and `signalk.appIcon` (`assets/icon.png`, TASMOTA symbol, GPL-3.0).
- README rewritten: configuration table, paths, PUT example, troubleshooting.
- Tests (`npm test`, `node:test`, mock Tasmota HTTP server, no dependencies).

Configuration is backward compatible: existing settings keep working unchanged.

## 1.0.0
- Initial release.

# Controller API

The ESP32 firmware (`firmware/src/main.cpp`) and the mock controller
(`tools/mock-device.cjs`) both implement this contract. The browser talks to
it through `web/js/device.js`. The tests in `tools/test/mock-device.test.cjs`
check it.

- Transport: HTTP/1.1 on TCP port 80, JSON bodies (`Content-Type: application/json`)
- Address: `http://nather.local` (mDNS), the DHCP address, or `http://192.168.4.1` on the setup hotspot
- Reads are open. Writes need `Authorization: Bearer <API_TOKEN>` when a token is set in `firmware/include/secrets.h`.
- CORS is open (`Access-Control-Allow-Origin: *`), so a dashboard served from another host on the LAN can use the API.

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/state` | – | Full state (below) |
| `PUT` | `/api/rooms/{id}` | `{"brightness": 0-100}` or `{"on": true\|false}` | The updated room |
| `PUT` | `/api/entry-rooms` | `{"rooms": ["hallway", "living"]}` | `{"rooms": [...]}` |
| `PUT` | `/api/mode` | `{"mode": "auto"}` or `{"mode": "manual"}` | `{"mode": "..."}` |
| `GET` | `/api/events` | – | Server-Sent Events stream |
| `POST` | `/api/sim/motion` | `{}` | Mock only: one 3-second motion pulse |
| `POST` | `/api/sim/light` | `{"light": 0-100}` | Mock only: set the ambient light |

Room ids: `living`, `bedroom`, `kitchen`, `bathroom`, `hallway`, `garage`.

### Room rules

- `brightness` wins if both fields are sent. `0` means off, `1–100` means on.
- `{"on": true}` restores the room's last non-zero brightness (50 % the first time).
- Any write marks the room as manual (`auto: false`), so auto-off leaves it alone.
- The UI always sends an absolute `brightness`. Repeating a request is harmless, and only the latest value matters.

### Auto and Manual mode

Same idea as the original graduation-project app.

- `auto` (default): motion switches on the entry rooms when it is dark, and auto-off switches them off after 5 minutes without movement.
- `manual`: motion is still reported in `sensors`, but nothing switches by itself. Switching to manual also clears `auto` on every room, so a light that motion turned on stays on until someone switches it off.
- The mode survives a reboot (saved in NVS, like the entry rooms).

### Errors

Every error is JSON: `{"error": "message"}`.

| Status | When |
|---|---|
| `400` | Body is not JSON, or a field has the wrong type or an unknown room id |
| `401` | A token is set and the request did not send it |
| `404` | Unknown room or path |
| `413` | Body over 512 bytes |

## State

```json
{
  "mode": "auto",
  "device": {
    "name": "nather",
    "hostname": "nather.local",
    "fw": "1.0.0",
    "mode": "sta",
    "ip": "192.168.1.50",
    "mac": "24:6F:28:AA:BB:CC",
    "ssid": "HomeWiFi",
    "rssi": -58,
    "channel": 6,
    "uptime": 3621,
    "heap": 214332,
    "clients": 2,
    "auth": false,
    "simulated": false
  },
  "rooms": {
    "living":  { "on": true,  "brightness": 70, "hw": "pwm",   "pin": 25, "auto": true },
    "bedroom": { "on": false, "brightness": 0,  "hw": "relay", "pin": 26, "auto": false }
  },
  "entryRooms": ["living"],
  "sensors": {
    "motion": false,
    "lastMotionAgo": 42,
    "light": 18,
    "dark": true
  }
}
```

- `device.mode`: `sta` on the home Wi-Fi, `ap` on the fallback hotspot (where `rssi` is `null`).
- `hw`: `pwm` (dimmable LED), `relay` (on/off), or `none` (tracked but not wired). `pin` is the GPIO, or `-1`. The mock leaves `pin` out.
- `sensors.lastMotionAgo`: seconds since the last motion, `null` before the first one.
- `sensors.light`: ambient light in %, `null` when no LDR is fitted. `dark` is `true` below the threshold, and always `true` without a sensor.

## Live updates (Server-Sent Events)

`GET /api/events` keeps one TCP connection open. The controller sends the full state:

- right after you connect,
- after any change, with bursts merged into one push within 100 ms,
- every 10 seconds as a heartbeat, which keeps uptime and RSSI fresh and shows the link is alive.

```
retry: 2000
event: state
id: 51234
data: {"device":{...},"rooms":{...},"entryRooms":[...],"sensors":{...}}

```

The browser's `EventSource` reconnects by itself (`retry: 2000`, in milliseconds).
Writes still go through `PUT`, and SSE only carries data from the controller to the browser.

## Try it with curl

```bash
curl http://nather.local/api/state
curl -X PUT -H "Content-Type: application/json" -d '{"brightness":40}' http://nather.local/api/rooms/living
curl -X PUT -H "Content-Type: application/json" -d '{"rooms":["hallway"]}' http://nather.local/api/entry-rooms
curl -N http://nather.local/api/events
```

With a token: add `-H "Authorization: Bearer <token>"` to the writes.
Against the mock, use `http://localhost:8080` instead.

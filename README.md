# Lumen — ESP32 smart lighting

[![CI](https://github.com/ayoubosa/nather-smart-light/actions/workflows/ci.yml/badge.svg)](https://github.com/ayoubosa/nather-smart-light/actions/workflows/ci.yml)

Wi-Fi lighting controller for a home: an ESP32 drives a dimmable LED and two
relays, a PIR sensor switches lights on when someone walks in after dark, and
a web app controls every room live from any phone or laptop on the network.

On the real board the pages are served by the ESP32 at `http://lumen.local`.
Without a board, `npm start` runs the same site against a mock controller,
and any copy of the site with no controller behind it falls back to a
simulated controller in the browser.

## What it does

- **Room control:** on/off and 0–100 % brightness per room, with gamma-corrected PWM dimming and relay switching.
- **Entry lighting:** the PIR detects motion, and the rooms you picked switch on only when the light sensor says it is dark. They switch off again after 5 minutes of no movement.
- **Live sync:** change a light on your phone and every other open page updates within about 100 ms, using Server-Sent Events.
- **Network-ready:** DHCP hostname, mDNS name, a fallback Wi-Fi hotspot, an optional API token, and a documented REST API.
- **Works without hardware:** a mock controller and an in-browser demo implement the same API and rules.

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI["Pages<br/>web/*.html"] --> LINK["Device link<br/>web/js/device.js"]
  end
  LINK -- "PUT /api/rooms/{id}" --> FW
  FW -- "SSE /api/events" --> LINK
  subgraph ESP32["ESP32 (firmware/)"]
    FW["HTTP server<br/>REST + SSE + static files"] --> RULES["Lighting rules"]
    RULES --> PWM["GPIO 25 PWM<br/>LED dimmer"]
    RULES --> RLY["GPIO 26/33<br/>relays"]
    PIR["GPIO 27 PIR"] --> RULES
    LDR["GPIO 34 LDR"] --> RULES
  end
  LINK -. "no controller found" .-> DEMO["Demo engine<br/>web/js/engine.js"]
```

The device link finds a controller (same origin, then a saved address) and
falls back to demo mode. Every write is an idempotent absolute value. The
controller pushes the full state to every client after each change.

## Run it

### Without hardware

```bash
npm start          # mock controller + website on http://localhost:8080
npm test           # rules engine + HTTP contract tests (Node 20+)
cd firmware && pio test -e native   # firmware lighting and Wi-Fi logic tests, no board needed
```

Tick a room under *Motion lighting* and press **Simulate Motion**. Open a
second tab to watch both stay in sync.

### On an ESP32

Needs [PlatformIO](https://platformio.org/install/cli) and an ESP32 DevKit (WROOM-32).

```bash
cd firmware
cp include/secrets.example.h include/secrets.h   # Wi-Fi name, password, optional API token
pio run -t upload && pio run -t uploadfs          # firmware, then the website
pio device monitor                                # prints the IP and http://lumen.local
```

Wiring, pin choices and light-sensor calibration: [docs/WIRING.md](docs/WIRING.md).

## Documentation

| | |
|---|---|
| [docs/API.md](docs/API.md) | REST endpoints, state schema, SSE format, curl examples |
| [docs/NETWORK.md](docs/NETWORK.md) | Topology, boot sequence (DHCP, ARP, mDNS, HTTP), Wireshark filters, security, IoT VLAN with a Cisco IOS ACL example |
| [docs/WIRING.md](docs/WIRING.md) | Pin map, schematic notes, flashing |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why each design choice was made |

## Repository layout

```text
web/            website (served by the ESP32, GitHub Pages and the mock)
  js/engine.js    lighting rules, shared by demo mode and the mock
  js/device.js    controller discovery, REST + SSE client, connection panel
  js/script.js    page behaviour
firmware/       PlatformIO project for the ESP32
  src/wifi_policy.cpp  when to join, retry, open and close the hotspot (unit-tested)
  src/lights.cpp       the lighting rules (unit-tested, same as engine.js)
tools/          mock controller and tests
docs/           API, network, wiring and design notes
```

## Background

The electronics come from Natheir and Muammar Khazala's electronics
engineering graduation project: a PIR-triggered smart light on an ESP32,
built on a model house and tested in several rooms at the university with a
dimmable LED, the PIR motion sensor and an LDR light sensor.

All the software in this repository is written by Ayoub: the firmware and its
API, the web app, the mock controller, the tests, and the network design and
documentation.

## Roadmap

- MQTT bridge for Home Assistant
- OTA firmware updates
- Packet Tracer lab of the IoT VLAN design in `docs/NETWORK.md`
- TLS via a reverse proxy on a Raspberry Pi

---

Made by Ayoub for Natheir and Muammar Khazala.

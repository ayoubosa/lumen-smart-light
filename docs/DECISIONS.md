# Design decisions

Every non-obvious choice in this project, with the reason for it. If you
change one, update the reason here too.

## Architecture

**The ESP32 serves the website itself (LittleFS), not GitHub Pages.**
A page served over HTTPS (GitHub Pages) is not allowed to call a plain-HTTP
device. Browsers block it as mixed content. Serving the UI from the
controller gives same-origin requests: no CORS, no mixed content, and it
works with no internet at all. The GitHub Pages copy runs in demo mode.

**REST for writes, Server-Sent Events for live updates, no WebSocket.**
The only push needed goes from the controller to the browser. SSE is plain
HTTP: you can test it with `curl -N`, read it easily in Wireshark, and the
browser's `EventSource` reconnects by itself. Both ESPAsyncWebServer and
Node support it without extra libraries, so the mock needs no dependencies.

**Writes send absolute brightness, not toggles.**
`{"brightness": 70}` gives the same result however many times it arrives.
A toggle repeated by a retry flips the light back. Absolute values also let
the UI drop intermediate dial positions: while one request is in flight,
only the latest value is sent next (`queueRoomSend` in `web/js/device.js`).

**One rules engine in JS, mirrored once in C++.**
`web/js/engine.js` runs the browser demo and the mock controller, and the
unit tests cover it. The firmware re-implements the same rules (`applyPatch`,
`onMotion`, `checkAutoOff`), with comments pointing back to the JS
version. Two implementations of about 60 lines is a smaller risk than putting
a JS runtime on the board.

**The home-page bulb is the living-room light.**
The original site had a separate "home bulb" that controlled no real room.
Making it the PWM-dimmed living room means every control on the site maps to
a real output.

## Network

**DHCP + mDNS (`nather.local`), no static IP in firmware.**
The router stays the single place where addresses are managed, and the same
firmware runs on any network. A DHCP reservation gives a stable IP when one is
needed (an ACL, a VLAN without mDNS).

**Fallback hotspot, retried every 5 minutes.**
After a power cut the router often boots after the ESP32. Without a fallback
the board would be unreachable. With automatic reconnection always on, the
ESP32 keeps scanning other channels, which disconnects phones from its
hotspot. So the firmware turns auto-reconnect off in hotspot mode and retries
the home network on a slow timer, then closes the hotspot as soon as the home
network is back.

**Wi-Fi modem sleep disabled.**
Modem sleep adds 100–300 ms to replies. The board is mains-powered.

**State pushes are merged into one per 100 ms, with a heartbeat every 10 s.**
Dragging the dial produces many changes per second. 100 ms is below what a
person notices and stops the board from sending one event per pixel. The
heartbeat refreshes uptime and RSSI and lets a client notice a dead link.

**Optional bearer token, plain HTTP.**
TLS on the ESP32 would need a certificate that browsers trust for a LAN
name, and ESPAsyncWebServer has no maintained TLS server mode. The honest
fix is network isolation (an IoT VLAN, see `NETWORK.md`) or a TLS reverse
proxy. The token stops casual misuse on a shared network. Reads stay open so
any screen in the house can show status.

**512-byte request body limit.**
The largest valid body (all six entry rooms) is under 100 bytes. The limit
keeps a misbehaving client from exhausting the board's heap.

## Hardware behaviour

**PWM at 5 kHz, 8-bit, gamma 2.2.**
5 kHz is well above visible flicker and camera banding, and within what common
MOSFET LED drivers switch cleanly. 8 bits (256 steps) is plenty after gamma
correction for a 0–100 dial. Gamma 2.2 makes 50 % on the dial look like
half brightness, because eyes perceive light roughly logarithmically.

**Relays are on/off. Brightness above 0 means on.**
The UI keeps one model for every room. The hardware tag on each room card
shows what it really does.

**Entry lighting: brightness 70 %, auto-off after 300 s, dark below 30 %.**
70 % is bright enough to walk in without being harsh at night. Five minutes
covers taking off shoes and coats without leaving lights on all evening. Only
rooms that motion switched on are turned off: a room someone set by hand is
never switched off by the timer. 30 % is a starting point for an LDR with a
10 kΩ divider and must be calibrated per install (`WIRING.md`).

**No light sensor counts as always dark.**
Without an LDR, the system behaves like the original project: motion always
switches the selected rooms on.

**PIR ignored for the first 30 s after boot.**
The HC-SR501 fires false triggers while it settles after power-on.

**After a power cut, lights come back off. Only the entry-room choice is saved.**
Lights switching on by themselves at 3 a.m. after a power blip is worse than
pressing a switch again. The entry-room selection is a setting, so it is kept
in NVS, and written only when it changes to spare the flash.

## Tooling

**PlatformIO, with libraries pinned to a major version.**
`platformio.ini` states the platform and libraries in one reviewable place.
CI uses the same file. Caret ranges (`^3.7.0`) take bug fixes but no
breaking changes. The firmware compiles against both Arduino-ESP32 2.x and
3.x (the LEDC API differs and is handled with `ESP_ARDUINO_VERSION_MAJOR`).

**ESP32Async/ESPAsyncWebServer + AsyncTCP.**
These are the maintained forks of the original me-no-dev libraries. They
include SSE support (`AsyncEventSource`).

**No build step for the website.**
Plain HTML, CSS and JS can be served by the ESP32, GitHub Pages and the mock
unchanged, and anyone can read the source.

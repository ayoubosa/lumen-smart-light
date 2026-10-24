# Wiring

The reference pin map lives in `firmware/include/config.h`. If your board is
wired differently, change it there. The UI picks the new map up from
`/api/state` (`hw` and `pin` per room).

> **Mains safety.** The relay module can switch 230 V / 120 V AC. Mains wiring
> must be done de-energised, in an enclosure, by someone qualified to do it.
> For bench testing, switch a 12 V LED strip instead.

## Reference board

| Part | Part pin | ESP32 pin | Notes |
|---|---|---|---|
| HC-SR501 PIR | VCC | 5V (VIN) | Needs 4.5–20 V |
| | OUT | **GPIO 27** | 3.3 V logic, so no level shifter. Firmware enables the internal pull-down |
| | GND | GND | Set the jumper to **H** (retrigger) so OUT stays high while someone keeps moving |
| LED via logic-level MOSFET (e.g. IRLZ44N) | Gate | **GPIO 25** (PWM 5 kHz) | 220 Ω series resistor, 100 kΩ gate-to-GND pull-down |
| | Drain | LED strip − | LED strip + to the 12 V supply |
| | Source | GND | Common ground with the ESP32 |
| 2-channel relay module | VCC | 5V (VIN) | |
| | IN1 | **GPIO 26** | Bedroom. Active LOW |
| | IN2 | **GPIO 33** | Kitchen. Active LOW |
| | GND | GND | |
| LDR light sensor (optional) | one leg | 3V3 | Divider: 3V3 → LDR → node → 10 kΩ → GND |
| | node | **GPIO 34** (ADC1) | More light gives a higher reading. Set `LDR_PIN -1` if it is not fitted |

```text
            3V3
             │
            [LDR]
             ├────────── GPIO 34
           [10 kΩ]
             │
            GND
```

## Why these pins

- **GPIO 34 for the LDR:** it is an ADC1 channel. ADC2 pins return garbage while Wi-Fi is running, and GPIO 34 is input-only, which is all a sensor needs.
- **GPIO 25, 26, 27, 33:** general-purpose and not strapping pins. GPIO 0, 2, 5, 12 and 15 decide the boot mode, and a load on them can stop the board from booting.
- **Relays default to off at boot:** the firmware writes HIGH before turning the pin into an output, so an active-LOW relay does not click on during reset.

## Calibrating the light sensor

1. Flash the firmware and open `http://nather.local`. The *Motion lighting* section shows the light sensor reading in %.
2. Note the reading in normal daylight and with the room lights off at dusk.
3. Set `DARK_THRESHOLD` in `config.h` between the two, and reflash.

## Flashing

```bash
cd firmware
cp include/secrets.example.h include/secrets.h   # then edit Wi-Fi name, password, token
pio run -t upload        # firmware
pio run -t uploadfs      # website from ../web into LittleFS
pio device monitor       # serial log at 115200 baud: IP, mDNS name, motion, API calls
```

Serial log on a healthy boot:

```text
Nather controller 1.0.0
[wifi] joining "HomeWiFi"......
[wifi] connected  ip 192.168.1.50  mask 255.255.255.0  gateway 192.168.1.1  rssi -58 dBm  channel 6
[mdns] http://nather.local
[pir] warming up for 30 s
```

#pragma once
// Keeps the board on the home Wi-Fi and opens the "Lumen-Setup" hotspot when
// it cannot be. The decisions live in wifi_policy.h; this file does the radio work.

#include <cstdint>

void wifiBegin();
void wifiPoll(uint32_t now);
bool wifiHotspotOn();   // safe to call from the web server task

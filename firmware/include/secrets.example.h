#pragma once
// Copy this file to secrets.h (git ignores it) and fill it in.

#define WIFI_SSID "your-wifi-name"
#define WIFI_PASSWORD "your-wifi-password"

// Password for the fallback "Lumen-Setup" hotspot. WPA2 needs 8+ characters.
#define AP_PASSWORD "change-me-please"

// Optional. When set, every PUT/POST must send
//   Authorization: Bearer <API_TOKEN>
// Leave empty ("") for an open API on a trusted network.
#define API_TOKEN ""

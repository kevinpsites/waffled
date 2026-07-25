// The onboarding screen: shown when no device secret is stored yet. Two
// fields (server address, pairing code) via LVGL's built-in keyboard widget,
// a "Pair" button that calls POST /api/waffled-bites/pair (wb_http.h), and
// an inline error message on failure (expired/invalid code, already-paired
// — see waffledBites.ts's 401/409 responses). On success, calls `onPaired`
// with the server URL and device secret — this screen doesn't know about
// wb_store or screen navigation; the caller (main.cpp) owns persisting them
// and switching to the home screen.
#pragma once

#include <lvgl.h>
#include <string>
#include <functional>

using WbPairedCallback = std::function<void(const std::string &serverUrl, const std::string &deviceSecret)>;
using WbChangeWifiCallback = std::function<void()>;

// `defaultServerUrl` pre-fills the server-address field (WB_API_BASE_URL on
// native; a fixed default on esp32-s3 until real provisioning exists).
// `onChangeWifi` is called when the kid/parent taps "Change Wi-Fi network" —
// this screen has no saved-network state of its own; the caller (main.cpp)
// owns switching back to the WiFi picker.
void wb_build_onboarding_screen(lv_obj_t *parent, const char *defaultServerUrl, WbPairedCallback onPaired, WbChangeWifiCallback onChangeWifi);

// WiFi scan/connect abstraction — one interface, two backends (same pattern
// as wb_http.h/wb_store.h): Arduino's WiFi.h (async scan + STA connect) on
// esp32-p4, a canned network list + a simulated connect on native so
// ui/wifi_screen.h's full scan -> pick -> password -> connecting flow is
// exercisable in the desktop simulator without real hardware. App code
// (main.cpp, wifi_screen.cpp) never touches WiFi.h directly.
#pragma once

#include <string>
#include <vector>

struct WbWifiNetwork
{
  std::string ssid;
  int rssi;    // dBm; more negative = weaker. wifi_screen.cpp buckets this
               // into a plain-text "Strong/Good/Weak" label — no custom
               // icon font yet (same constraint as settings_screen.cpp's
               // moon/stopwatch/bed tiles).
  bool secure; // false = open network, no password field shown
};

enum class WbWifiScanStatus
{
  Idle,     // wb_wifi_begin_scan() not called yet
  Scanning,
  Done,
};

enum class WbWifiConnStatus
{
  Idle, // wb_wifi_connect() not called yet
  Connecting,
  Connected,
  Failed,
};

void wb_wifi_begin_scan();
WbWifiScanStatus wb_wifi_scan_status();
// Valid once wb_wifi_scan_status() == Done; empty otherwise.
std::vector<WbWifiNetwork> wb_wifi_scan_results();

void wb_wifi_connect(const std::string &ssid, const std::string &pass);
WbWifiConnStatus wb_wifi_connect_status();

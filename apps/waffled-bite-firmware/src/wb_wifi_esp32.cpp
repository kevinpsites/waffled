// ESP32-P4/Arduino backend for wb_wifi.h — WiFi.h's async scan
// (WiFi.scanNetworks(true)) and STA connect, polled rather than blocking so
// the LVGL/touch pipeline (lv_timer_handler) never freezes during either.
// Verified reliably on real hardware once built via the espidf+arduino
// hybrid framework AND with esp_hosted's restart-on-transport-failure
// disabled — see platformio.ini's esp32-p4 env comment and
// sdkconfig.defaults' CONFIG_ESP_HOSTED_TRANSPORT_RESTART_ON_FAILURE.
#include "wb_wifi.h"
#include "wb_tick_hal.h"
#include <WiFi.h>
#include <algorithm>

#define WB_WIFI_CONNECT_TIMEOUT_MS 15000

void wb_wifi_begin_scan()
{
  // A prior WiFi.begin() against an out-of-range saved AP (e.g. the device
  // booted somewhere other than home) leaves the STA driver stuck reporting
  // WL_NO_SSID_AVAIL — confirmed live on real hardware: WiFi.disconnect()
  // alone doesn't clear it (WiFi.status() kept reporting WL_NO_SSID_AVAIL
  // and scanNetworks() kept returning WIFI_SCAN_FAILED across dozens of
  // attempts, even after a full power cycle of the device). Power-cycling
  // the STA mode itself in software resets the driver's internal state
  // machine, not just its connection state. Safe to call unconditionally
  // here since this is only ever invoked while the WiFi picker is on
  // screen, i.e. never while actually connected to anything.
  WiFi.mode(WIFI_OFF);
  delay(200);
  WiFi.mode(WIFI_STA);
  delay(200);
  WiFi.scanNetworks(true /* async */);
}

WbWifiScanStatus wb_wifi_scan_status()
{
  int16_t n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING)
    return WbWifiScanStatus::Scanning;
  if (n == WIFI_SCAN_FAILED)
    return WbWifiScanStatus::Failed; // wifi_screen.cpp retries on this, not the same as "done, zero results"
  if (n < 0)
    return WbWifiScanStatus::Idle; // scan never started
  return WbWifiScanStatus::Done;
}

std::vector<WbWifiNetwork> wb_wifi_scan_results()
{
  std::vector<WbWifiNetwork> out;
  int16_t n = WiFi.scanComplete();
  if (n <= 0)
    return out;
  out.reserve(n);
  for (int16_t i = 0; i < n; i++)
  {
    WbWifiNetwork net{std::string(WiFi.SSID(i).c_str()), WiFi.RSSI(i), WiFi.encryptionType(i) != WIFI_AUTH_OPEN};
    // Mesh/multi-AP setups (and dual-band routers) broadcast the same SSID
    // from several BSSIDs — scanNetworks() returns one row per BSSID, not
    // per network name, so the same network can otherwise show up several
    // times in the picker. Keep just the strongest-signal copy per SSID.
    auto existing = std::find_if(out.begin(), out.end(), [&](const WbWifiNetwork &e)
                                  { return e.ssid == net.ssid; });
    if (existing != out.end())
    {
      if (net.rssi > existing->rssi)
        *existing = net;
    }
    else
    {
      out.push_back(net);
    }
  }
  WiFi.scanDelete(); // free the scan result buffer now that it's copied out
  return out;
}

static WbWifiConnStatus g_connStatus = WbWifiConnStatus::Idle;
static uint32_t g_connectStartMs = 0;

void wb_wifi_connect(const std::string &ssid, const std::string &pass)
{
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), pass.empty() ? nullptr : pass.c_str());
  g_connStatus = WbWifiConnStatus::Connecting;
  g_connectStartMs = wb_tick_ms();
}

WbWifiConnStatus wb_wifi_connect_status()
{
  if (g_connStatus != WbWifiConnStatus::Connecting)
    return g_connStatus;
  if (WiFi.status() == WL_CONNECTED)
  {
    g_connStatus = WbWifiConnStatus::Connected;
    return g_connStatus;
  }
  if (wb_tick_ms() - g_connectStartMs > WB_WIFI_CONNECT_TIMEOUT_MS)
  {
    WiFi.disconnect(); // stop the driver's own retry against an AP we've given up on, so a later scan doesn't find it still "busy"
    g_connStatus = WbWifiConnStatus::Failed;
    return g_connStatus;
  }
  return WbWifiConnStatus::Connecting;
}

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

#define WB_WIFI_CONNECT_TIMEOUT_MS 15000

void wb_wifi_begin_scan()
{
  WiFi.mode(WIFI_STA);
  WiFi.scanNetworks(true /* async */);
}

WbWifiScanStatus wb_wifi_scan_status()
{
  int16_t n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING)
    return WbWifiScanStatus::Scanning;
  if (n == WIFI_SCAN_FAILED)
    return WbWifiScanStatus::Done; // treat as "done, zero results" — wifi_screen.cpp's empty-state covers this
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
    out.push_back({std::string(WiFi.SSID(i).c_str()), WiFi.RSSI(i), WiFi.encryptionType(i) != WIFI_AUTH_OPEN});
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
    g_connStatus = WbWifiConnStatus::Failed;
    return g_connStatus;
  }
  return WbWifiConnStatus::Connecting;
}

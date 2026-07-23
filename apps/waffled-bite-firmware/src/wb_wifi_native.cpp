// Native/desktop backend for wb_wifi.h — a canned network list + a simulated
// connect that succeeds after a short, real-feeling delay, so wifi_screen.cpp's
// full scan -> pick -> password -> connecting -> done flow is exercisable in
// the SDL simulator without real hardware. Dev convenience only, same
// "not modeling real behavior" rationale as wb_store_native.cpp.
#include "wb_wifi.h"
#include "wb_tick_hal.h"

#define WB_WIFI_SCAN_DELAY_MS 900
#define WB_WIFI_CONNECT_DELAY_MS 1200

static bool g_scanStarted = false;
static uint32_t g_scanStartMs = 0;

static const std::vector<WbWifiNetwork> WB_FAKE_NETWORKS = {
    {"Waffled House", -42, true},
    {"Kid Bedroom 2.4GHz", -58, true},
    {"Neighbor's WiFi", -74, true},
    {"Guest Network", -66, false},
};

void wb_wifi_begin_scan()
{
  g_scanStarted = true;
  g_scanStartMs = wb_tick_ms();
}

WbWifiScanStatus wb_wifi_scan_status()
{
  if (!g_scanStarted)
    return WbWifiScanStatus::Idle;
  return (wb_tick_ms() - g_scanStartMs >= WB_WIFI_SCAN_DELAY_MS) ? WbWifiScanStatus::Done : WbWifiScanStatus::Scanning;
}

std::vector<WbWifiNetwork> wb_wifi_scan_results()
{
  return (wb_wifi_scan_status() == WbWifiScanStatus::Done) ? WB_FAKE_NETWORKS : std::vector<WbWifiNetwork>{};
}

static WbWifiConnStatus g_connStatus = WbWifiConnStatus::Idle;
static uint32_t g_connectStartMs = 0;
static std::string g_lastPass;

void wb_wifi_connect(const std::string &ssid, const std::string &pass)
{
  (void)ssid;
  g_connStatus = WbWifiConnStatus::Connecting;
  g_connectStartMs = wb_tick_ms();
  g_lastPass = pass;
}

WbWifiConnStatus wb_wifi_connect_status()
{
  if (g_connStatus != WbWifiConnStatus::Connecting)
    return g_connStatus;
  if (wb_tick_ms() - g_connectStartMs >= WB_WIFI_CONNECT_DELAY_MS)
    // "wrongpass" is a dev-only hook so the failure/retry path is exercisable
    // in the simulator too, not just the happy path — no real network has
    // this as a literal password.
    g_connStatus = (g_lastPass == "wrongpass") ? WbWifiConnStatus::Failed : WbWifiConnStatus::Connected;
  return g_connStatus;
}

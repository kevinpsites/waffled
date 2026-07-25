// The boot-time WiFi picker: scans on build, shows a tappable list of
// networks, a password entry (shared on-screen keyboard) for secured ones,
// and a "Connecting..." state with inline error + retry on failure. Calls
// `onConnected` once WiFi actually comes up — this screen doesn't know about
// wb_store or what screen comes next (onboarding vs. straight into the app);
// the caller (main.cpp) owns persisting the credentials and deciding that
// (wb_boot_next) — same split of responsibility as onboarding_screen.h.
#pragma once

#include <lvgl.h>
#include <string>
#include <functional>

using WbWifiConnectedCallback = std::function<void(const std::string &ssid, const std::string &pass)>;

void wb_build_wifi_screen(lv_obj_t *parent, WbWifiConnectedCallback onConnected);

// Pure decision logic for what main.cpp's setup() shows once it knows
// whether WiFi is up — factored out so it's unit-testable without LVGL or
// any hardware (see test/test_boot_flow). No I/O, no globals, no side
// effects.
#pragma once

enum class WbBootNext
{
  ShowWifiPicker, // no saved WiFi creds, or the saved ones just failed to connect
  ShowOnboarding, // WiFi is up but no device secret stored yet
  EnterApp,       // WiFi is up and a device secret is already stored
};

WbBootNext wb_boot_next(bool hasSavedWifiCreds, bool wifiConnected, bool hasDeviceSecret);

#include "wb_boot_flow.h"

WbBootNext wb_boot_next(bool hasSavedWifiCreds, bool wifiConnected, bool hasDeviceSecret)
{
  if (!hasSavedWifiCreds || !wifiConnected)
    return WbBootNext::ShowWifiPicker;
  return hasDeviceSecret ? WbBootNext::EnterApp : WbBootNext::ShowOnboarding;
}

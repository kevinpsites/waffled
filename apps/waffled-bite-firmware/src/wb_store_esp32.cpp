// esp32-p4/Arduino backend for wb_store.h — real persistence via NVS (Arduino's
// Preferences library, part of the arduino-esp32 core, no extra lib_deps entry
// needed — same tier as WiFi.h). Namespace "wb" holds the two pairing keys
// (serverUrl, deviceSecret).
//
// Opens/closes Preferences on every call rather than keeping a persistent
// handle open — these calls only happen at pairing time and once at boot, so
// there's no hot-path cost to the extra open/close, and it keeps each
// function self-contained. Exercised on real hardware by the WiFi-provisioning
// bring-up: credentials entered on-device survive a power cycle, confirmed
// across dozens of reboot tests (see the README's bring-up notes).
#include "wb_store.h"
#include <Preferences.h>

static const char *WB_STORE_NAMESPACE = "wb";

std::string wb_store_get(const char *key)
{
  Preferences prefs;
  prefs.begin(WB_STORE_NAMESPACE, true /* read-only */);
  std::string value = prefs.getString(key, "").c_str();
  prefs.end();
  return value;
}

void wb_store_set(const char *key, const std::string &value)
{
  Preferences prefs;
  prefs.begin(WB_STORE_NAMESPACE, false /* read-write */);
  prefs.putString(key, value.c_str());
  prefs.end();
}

void wb_store_clear(const char *key)
{
  Preferences prefs;
  prefs.begin(WB_STORE_NAMESPACE, false /* read-write */);
  prefs.remove(key);
  prefs.end();
}

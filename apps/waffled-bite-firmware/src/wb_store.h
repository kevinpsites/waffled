// Persistent key/value storage for pairing state (serverUrl, deviceSecret) —
// one interface, two backends: Arduino Preferences (NVS) on esp32-s3, a
// plaintext file next to the binary on native (dev convenience only, so
// relaunching the simulator doesn't force re-pairing every run — not
// modeling real security, see wb_store_native.cpp).
#pragma once

#include <string>

// Returns "" if the key isn't set.
std::string wb_store_get(const char *key);
void wb_store_set(const char *key, const std::string &value);
void wb_store_clear(const char *key);

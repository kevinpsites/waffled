// HTTP client abstraction — one interface, two backends split by target
// (same pattern as lgfx_device.h / wb_tick_hal.h): libcurl on native,
// Arduino's HTTPClient + WiFiClientSecure on esp32-s3. App code (main.cpp,
// the onboarding screen) only ever calls wb_http_get/wb_http_post.
#pragma once

#include <string>

struct WbHttpResponse
{
  bool ok;          // true if the request completed at all (regardless of HTTP status)
  int status;        // HTTP status code; 0 if the request never completed (network error)
  std::string body;
};

// `bearer` may be nullptr for the public pairing endpoints (pair, device/token).
WbHttpResponse wb_http_get(const char *url, const char *bearer);
WbHttpResponse wb_http_post(const char *url, const char *jsonBody, const char *bearer);

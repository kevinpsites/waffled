// HTTP client abstraction — one interface, two backends split by target
// (same pattern as lgfx_device.h / wb_tick_hal.h): libcurl on native,
// Arduino's HTTPClient on esp32-p4. App code (main.cpp, the onboarding
// screen) calls wb_http_get/wb_http_post/wb_http_patch.
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
// PATCH /api/waffled-bites/device/settings is the only PATCH route the
// device itself calls (the rest of the parent-side settings API is
// admin-only — see waffledBites.ts) — added alongside it rather than up
// front with get/post.
WbHttpResponse wb_http_patch(const char *url, const char *jsonBody, const char *bearer);

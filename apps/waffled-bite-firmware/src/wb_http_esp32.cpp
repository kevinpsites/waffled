// esp32-p4/Arduino backend for wb_http.h — Arduino's HTTPClient.
// UNVERIFIED — no board in hand yet (same caveat as lgfx_device.h and
// platformio.ini's esp32-p4 section). Uses HTTPClient::begin(const String&)
// (the single-argument overload), which auto-detects http:// vs https://
// and manages its own internal WiFiClient/WiFiClientSecure — this avoids
// hand-constructing a WiFiClientSecure ourselves and hitting API
// differences across arduino-esp32 core versions. Caller (main.cpp) is
// responsible for WiFi.begin()/waiting for WL_CONNECTED before these are
// ever called — this file assumes a live network, it doesn't manage one.
#include "wb_http.h"
#include <Arduino.h>
#include <HTTPClient.h>

// TODO(hardware bring-up): no TLS cert validation is configured for
// https:// server addresses — HTTPClient::begin(String) doesn't expose a
// setInsecure()-style knob on this overload (that lives on WiFiClientSecure,
// which we're deliberately not constructing by hand here — see file header).
// A self-hosted household's server is very likely on a private LAN over
// plain http:// for this device anyway, so this hasn't been forced yet;
// revisit if/when a real deployment needs https from the device.

static WbHttpResponse perform(const char *url, const char *jsonBody /* nullptr for GET */, const char *bearer, bool isPatch = false)
{
  WbHttpResponse resp{false, 0, ""};

  HTTPClient http;
  if (!http.begin(String(url)))
    return resp;

  if (jsonBody)
    http.addHeader("Content-Type", "application/json");
  if (bearer)
    http.addHeader("Authorization", String("Bearer ") + bearer);

  int code = !jsonBody ? http.GET() : (isPatch ? http.PATCH(String(jsonBody)) : http.POST(String(jsonBody)));

  // Arduino's HTTPClient returns negative HTTPC_ERROR_* values on a
  // transport-level failure (DNS/connect/timeout) before any HTTP status
  // exists — only treat a positive code as "the request completed".
  resp.status = code;
  resp.ok = code > 0;
  if (code > 0)
    resp.body = http.getString().c_str();

  http.end();
  return resp;
}

WbHttpResponse wb_http_get(const char *url, const char *bearer)
{
  return perform(url, nullptr, bearer);
}

WbHttpResponse wb_http_post(const char *url, const char *jsonBody, const char *bearer)
{
  return perform(url, jsonBody, bearer);
}

WbHttpResponse wb_http_patch(const char *url, const char *jsonBody, const char *bearer)
{
  return perform(url, jsonBody, bearer, true);
}

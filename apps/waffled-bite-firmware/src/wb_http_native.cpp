// Native/desktop backend for wb_http.h — libcurl. A real desktop process
// with real sockets, so this needs none of the WiFi/TLS caveats the
// esp32-s3 backend (wb_http_esp32.cpp) carries.
#include "wb_http.h"
#include <curl/curl.h>

static size_t writeCb(char *ptr, size_t size, size_t nmemb, void *userdata)
{
  auto *body = static_cast<std::string *>(userdata);
  size_t n = size * nmemb;
  body->append(ptr, n);
  return n;
}

// One-time global init — this file is only ever called from LVGL's poll
// timer on the main thread, so a static local guard is enough (no
// std::call_once needed for a single-threaded caller).
static void ensureCurlInit()
{
  static bool initialized = false;
  if (!initialized)
  {
    curl_global_init(CURL_GLOBAL_DEFAULT);
    initialized = true;
  }
}

static WbHttpResponse perform(const char *url, const char *jsonBody /* nullptr for GET */, const char *bearer)
{
  ensureCurlInit();
  WbHttpResponse resp{false, 0, ""};

  CURL *curl = curl_easy_init();
  if (!curl)
    return resp;

  struct curl_slist *headers = nullptr;
  if (jsonBody)
    headers = curl_slist_append(headers, "Content-Type: application/json");
  if (bearer)
  {
    std::string authHeader = "Authorization: Bearer " + std::string(bearer);
    headers = curl_slist_append(headers, authHeader.c_str());
  }
  if (headers)
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);

  curl_easy_setopt(curl, CURLOPT_URL, url);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCb);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 10L); // don't let a dead server hang the LVGL loop
  if (jsonBody)
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, jsonBody);

  CURLcode res = curl_easy_perform(curl);
  if (res == CURLE_OK)
  {
    long status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
    resp.status = static_cast<int>(status);
    resp.ok = true;
  }

  if (headers)
    curl_slist_free_all(headers);
  curl_easy_cleanup(curl);
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

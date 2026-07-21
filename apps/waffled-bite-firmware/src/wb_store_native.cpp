// Native/desktop backend for wb_store.h — persists the two pairing keys
// (serverUrl, deviceSecret) as a flat JSON object in a file next to wherever
// the simulator binary is launched from. This is a dev convenience ONLY, so
// relaunching `pio run -e native -t exec` doesn't force re-pairing on every
// single run — it is NOT meant to model real device security (no encryption,
// no OS keychain, plaintext on disk). The esp32-s3 target uses real NVS
// storage via Preferences instead (wb_store_esp32.cpp).
#include "wb_store.h"
#include <ArduinoJson.h>
#include <fstream>
#include <sstream>

static const char *WB_STORE_PATH = ".wb_pairing.json";

// Reads the whole store file into `doc`. Leaves `doc` as an empty object if
// the file doesn't exist or fails to parse — callers treat that the same as
// "no keys set" rather than erroring.
static void loadDoc(JsonDocument &doc)
{
  std::ifstream in(WB_STORE_PATH);
  if (!in.is_open())
    return;
  std::stringstream buf;
  buf << in.rdbuf();
  deserializeJson(doc, buf.str()); // parse failure leaves doc empty/unchanged enough for our purposes
}

static void saveDoc(JsonDocument &doc)
{
  std::ofstream out(WB_STORE_PATH, std::ios::trunc);
  if (!out.is_open())
    return;
  std::string serialized;
  serializeJson(doc, serialized);
  out << serialized;
}

std::string wb_store_get(const char *key)
{
  JsonDocument doc;
  loadDoc(doc);
  JsonVariantConst v = doc[key];
  if (v.is<const char *>())
    return v.as<const char *>();
  return "";
}

void wb_store_set(const char *key, const std::string &value)
{
  JsonDocument doc;
  loadDoc(doc);
  doc[key] = value;
  saveDoc(doc);
}

void wb_store_clear(const char *key)
{
  JsonDocument doc;
  loadDoc(doc);
  doc.remove(key);
  saveDoc(doc);
}

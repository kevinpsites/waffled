# Only consulted by the esp32-p4 env (framework = espidf, arduino) — the
# native/native_test envs use `platform = native`, which never invokes
# CMake. Mirrors that env's build_src_filter exclusions in platformio.ini:
# PlatformIO's src_filter has no effect once ESP-IDF is in the framework
# list, so file selection has to happen here instead.
idf_component_register(
  SRC_DIRS "." "ui"
  INCLUDE_DIRS "."
  EXCLUDE_SRCS "sdl_main.cpp" "wb_http_native.cpp" "wb_store_native.cpp" "wb_wifi_native.cpp"
)

// Unit tests for wb_boot_flow.h's pure decision logic — the one piece of the
// new WiFi-provisioning flow with no LVGL/hardware dependency, so it's the
// one piece we can actually TDD in the classic sense (see the firmware
// README/PR notes for why the rest of this feature is simulator-verified
// instead of unit-tested). Run with `pio test -e native_test`.
#include <unity.h>
#include "wb_boot_flow.h"

void setUp(void) {}
void tearDown(void) {}

void test_no_saved_wifi_shows_picker_regardless_of_pairing(void)
{
  TEST_ASSERT_TRUE(wb_boot_next(false, false, false) == WbBootNext::ShowWifiPicker);
  TEST_ASSERT_TRUE(wb_boot_next(false, false, true) == WbBootNext::ShowWifiPicker);
}

void test_saved_wifi_but_connect_failed_shows_picker(void)
{
  TEST_ASSERT_TRUE(wb_boot_next(true, false, true) == WbBootNext::ShowWifiPicker);
  TEST_ASSERT_TRUE(wb_boot_next(true, false, false) == WbBootNext::ShowWifiPicker);
}

void test_wifi_up_no_device_secret_shows_onboarding(void)
{
  TEST_ASSERT_TRUE(wb_boot_next(true, true, false) == WbBootNext::ShowOnboarding);
}

void test_wifi_up_and_already_paired_enters_app(void)
{
  TEST_ASSERT_TRUE(wb_boot_next(true, true, true) == WbBootNext::EnterApp);
}

int main(int argc, char **argv)
{
  UNITY_BEGIN();
  RUN_TEST(test_no_saved_wifi_shows_picker_regardless_of_pairing);
  RUN_TEST(test_saved_wifi_but_connect_failed_shows_picker);
  RUN_TEST(test_wifi_up_no_device_secret_shows_onboarding);
  RUN_TEST(test_wifi_up_and_already_paired_enters_app);
  return UNITY_END();
}

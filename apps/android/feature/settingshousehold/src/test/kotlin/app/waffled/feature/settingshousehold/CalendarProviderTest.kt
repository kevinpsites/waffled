package app.waffled.feature.settingshousehold

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Port of `CalendarProviderTests.swift`. Google and Outlook are configured independently
 * on the server, so all four combinations are real.
 */
class CalendarProviderTest {

    @Test
    fun offersNothingWhenTheServerHasNoCredentials() {
        assertTrue(CalendarProvider.offered(googleConfigured = false, microsoftConfigured = false).isEmpty())
    }

    @Test
    fun offersOnlyWhatTheServerIsSetUpFor() {
        assertEquals(
            listOf(CalendarProvider.Google),
            CalendarProvider.offered(googleConfigured = true, microsoftConfigured = false),
        )
        assertEquals(
            listOf(CalendarProvider.Microsoft),
            CalendarProvider.offered(googleConfigured = false, microsoftConfigured = true),
        )
    }

    @Test
    fun offersBothInAStableOrder() {
        assertEquals(
            listOf(CalendarProvider.Google, CalendarProvider.Microsoft),
            CalendarProvider.offered(googleConfigured = true, microsoftConfigured = true),
        )
    }

    @Test
    fun namesEachProviderTheWayPeopleDo() {
        assertEquals("Outlook", CalendarProvider.Microsoft.label)
        assertEquals("Google", CalendarProvider.Google.label)
        assertEquals("/api/calendar/microsoft/connect", CalendarProvider.Microsoft.connectPath)
        assertEquals("/api/calendar/google/connect", CalendarProvider.Google.connectPath)
        assertEquals("Connect Outlook Calendar", CalendarProvider.Microsoft.connectTitle)
    }

    @Test
    fun labelsAnAccountByItsProvider() {
        assertEquals("Google account", CalendarProvider.accountLabel("google"))
        assertEquals("Outlook account", CalendarProvider.accountLabel("microsoft"))
    }

    // Servers older than multi-provider don't send `provider`; everything they hold is Google.
    @Test
    fun treatsAMissingProviderAsGoogle() {
        assertEquals("Google account", CalendarProvider.accountLabel(null))
    }

    @Test
    fun degradesGracefullyOnAnUnknownProvider() {
        assertEquals("Calendar account", CalendarProvider.accountLabel("fastmail"))
    }
}

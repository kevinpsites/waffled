package app.waffled.feature.settingshousehold

import app.waffled.core.network.WaffledJson
import kotlinx.serialization.Serializable
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Port of `CalendarStatusDecodingTests.swift`. The payloads are captured verbatim from a
 * running stack; an older server omits `microsoftConfigured`, `provider` and `feeds`.
 */
class CalendarStatusDecodingTest {

    private val status = """
    {"configured":true,"microsoftConfigured":false,"connected":true,
     "accounts":[{"id":"aaaaaaaa-0000-0000-0000-000000000001","email":"test@demo",
       "googleSub":"test-sub-personal","provider":"google","scope":null,
       "connectedAt":"2026-07-08T23:00:58.856Z","lastSyncError":"Invalid initialization vector",
       "lastSyncErrorAt":"2026-08-11T23:21:25.633Z"}],
     "calendars":[{"id":"bbbbbbbb-0000-0000-0000-000000000001",
       "accountId":"aaaaaaaa-0000-0000-0000-000000000001","googleCalendarId":"primary",
       "summary":"Jerry","timezone":"America/New_York","accessRole":"owner","colorHex":"#e5533c",
       "isPrimary":true,"selected":true,"isWriteTarget":true,"visibility":"family",
       "personId":null,"personName":null,"personColor":null,"lastSyncedAt":null}],
     "feeds":[{"id":"6ec3af0a-c643-4e2f-8d8e-7a01388f0af0",
       "url":"https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics",
       "name":"US Holidays","personId":null,"personName":null,"personColor":null,
       "visibility":"family","lastSyncedAt":"2026-08-11T23:11:26.261Z","lastError":null,
       "createdAt":"2026-08-11T21:12:42.803Z"}]}
    """.trimIndent()

    private val legacyStatus = """{"configured":true,"connected":false,"accounts":[],"calendars":[]}"""

    private fun decode(json: String) =
        WaffledJson.decodeFromString(SettingsHouseholdApi.CalendarStatus.serializer(), json)

    @Test
    fun decodesProviderAndMicrosoftConfigured() {
        val s = decode(status)
        assertFalse(s.microsoftConfigured)
        assertEquals("google", s.accounts.first().provider)
        assertTrue(s.calendars.first().isWritable)
    }

    @Test
    fun decodesIcsFeeds() {
        val feed = decode(status).feeds.first()
        assertEquals("US Holidays", feed.name)
        assertEquals("family", feed.visibility)
        assertNull(feed.lastError)
        assertEquals("2026-08-11T23:11:26.261Z", feed.lastSyncedAt)
        assertNull(feed.personId)
    }

    @Test
    fun toleratesAServerWithoutTheNewFields() {
        val s = decode(legacyStatus)
        assertFalse(s.microsoftConfigured)
        assertTrue(s.feeds.isEmpty())
    }

    @Serializable
    private data class FeedsResp(val feeds: List<SettingsHouseholdApi.Feed>)

    @Test
    fun decodesTheStandaloneFeedsEnvelope() {
        val body = """
        {"feeds":[{"id":"6ec3af0a-c643-4e2f-8d8e-7a01388f0af0","url":"https://example.com/a.ics",
          "name":null,"personId":"cccccccc-0000-0000-0000-000000000001","personName":"Elaine",
          "personColor":"#7c5cff","visibility":"personal","lastSyncedAt":null,
          "lastError":"404 Not Found","createdAt":"2026-08-11T21:12:42.803Z"}]}
        """.trimIndent()
        val feed = WaffledJson.decodeFromString(FeedsResp.serializer(), body).feeds.first()
        assertNull(feed.name)
        assertEquals("Elaine", feed.personName)
        assertEquals("personal", feed.visibility)
        assertEquals("404 Not Found", feed.lastError)
    }
}

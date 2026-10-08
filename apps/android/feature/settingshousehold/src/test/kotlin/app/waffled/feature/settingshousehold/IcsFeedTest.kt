package app.waffled.feature.settingshousehold

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Ports of `IcsFeedDisplayTests.swift` and `IcsFeedFormTests.swift`. */
class IcsFeedTest {

    private fun feed(
        name: String?,
        url: String,
        lastError: String? = null,
        lastSyncedAt: String? = null,
    ) = SettingsHouseholdApi.Feed(
        id = "f1", url = url, name = name, visibility = "family",
        lastSyncedAt = lastSyncedAt, lastError = lastError, createdAt = "2026-08-11T21:12:42.803Z",
    )

    // ---- display ----

    @Test
    fun prefersTheHouseholdsOwnName() {
        assertEquals("US Holidays", feed("US Holidays", "https://example.com/a.ics").displayName)
    }

    @Test
    fun fallsBackToTheHostWhenUnnamed() {
        val f = feed(null, "https://calendar.google.com/calendar/ical/en.usa%23holiday/public/basic.ics")
        assertEquals("calendar.google.com", f.displayName)
    }

    @Test
    fun treatsABlankNameAsUnnamed() {
        assertEquals("sports.example.org", feed("   ", "https://sports.example.org/team.ics").displayName)
    }

    @Test
    fun alwaysHasSomethingToShow() {
        assertEquals("Calendar feed", feed(null, "not a url").displayName)
    }

    @Test
    fun reportsTheLastErrorAheadOfTheSyncTime() {
        val f = feed("Team", "https://x.example/t.ics", lastError = "feed returned HTTP 404",
            lastSyncedAt = "2026-08-11T23:11:26.261Z")
        assertTrue(f.hasError)
    }

    @Test
    fun aHealthyFeedReportsNoError() {
        assertFalse(feed("Team", "https://x.example/t.ics", lastSyncedAt = "2026-08-11T23:11:26.261Z").hasError)
    }

    // ---- form rule: a private feed must belong to someone ----

    @Test
    fun offersPrivateOnlyOnceTheFeedBelongsToSomeone() {
        assertFalse(IcsFeedForm.offersPrivate(personId = null))
        assertTrue(IcsFeedForm.offersPrivate(personId = "p1"))
    }

    @Test
    fun dropsPrivateWhenThePersonIsCleared() {
        assertFalse(IcsFeedForm.isPrivate(wanted = true, personId = null))
    }

    @Test
    fun keepsPrivateWhileAPersonIsChosen() {
        assertTrue(IcsFeedForm.isPrivate(wanted = true, personId = "p1"))
        assertFalse(IcsFeedForm.isPrivate(wanted = false, personId = "p1"))
    }

    // An edit must CLEAR name and person explicitly; WaffledJson would drop a plain null.
    @Test
    fun anEditBodyCarriesExplicitNullsAndATrimmedUrl() {
        val body = IcsFeedForm.updateBody(url = "  https://a.example/x.ics ", name = "  ", personId = null, personal = true)
        assertEquals(JsonPrimitive("https://a.example/x.ics"), body["url"])
        assertEquals(JsonNull, body["name"])
        assertEquals(JsonNull, body["personId"])
        assertEquals(JsonPrimitive("family"), body["visibility"])
    }

    @Test
    fun anEditBodyKeepsAChosenOwnerPrivate() {
        val body = IcsFeedForm.updateBody(url = "https://a.example/x.ics", name = "Team", personId = "p1", personal = true)
        assertEquals(JsonPrimitive("Team"), body["name"])
        assertEquals(JsonPrimitive("p1"), body["personId"])
        assertEquals(JsonPrimitive("personal"), body["visibility"])
    }
}

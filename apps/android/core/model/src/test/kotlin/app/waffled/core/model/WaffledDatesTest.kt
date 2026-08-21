package app.waffled.core.model

import java.time.ZoneId
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull

/**
 * Shared date handling. The server sends timestamps in more than one shape, and every
 * feature has to parse, bucket and format them — so this lives once rather than being
 * re-derived per module.
 *
 * Twin of `Sync/DateFmt.swift` and the `EventTime` parsing in `Sync/Events.swift`,
 * whose behaviour is locked by `SyncLogicTests.swift`.
 *
 * ⚠️ Formatters are cached, not allocated per row: building one per list item — or doing
 * `startOfDay` inside a comparator — is a documented cause of scroll jank on iOS.
 */
class WaffledDatesTest {

    private val nyc = ZoneId.of("America/New_York")

    @Test
    fun parsesFullIso8601WithOffset() {
        val t = WaffledDates.parseInstant("2026-08-21T14:30:00Z")
        assertEquals(1787408_000L / 1000 * 1000, 1787408000L / 1000 * 1000) // sanity anchor
        assertEquals("2026-08-21T14:30:00Z", t?.toString())
    }

    @Test
    fun parsesOffsetsOtherThanZulu() {
        assertEquals(
            WaffledDates.parseInstant("2026-08-21T14:30:00Z"),
            WaffledDates.parseInstant("2026-08-21T10:30:00-04:00"),
        )
    }

    @Test
    fun parsesFractionalSeconds() {
        // Postgres hands back microseconds; the parser must not choke on them.
        assertEquals(
            WaffledDates.parseInstant("2026-08-21T14:30:00Z"),
            WaffledDates.parseInstant("2026-08-21T14:30:00.000000Z"),
        )
    }

    @Test
    fun parsesADateOnlyValueAsMidnightInTheGivenZone() {
        val t = WaffledDates.parseInstant("2026-08-21", nyc)
        // Midnight in New York on that date is 04:00Z (EDT).
        assertEquals("2026-08-21T04:00:00Z", t?.toString())
    }

    @Test
    fun junkParsesToNullRatherThanThrowing() {
        assertNull(WaffledDates.parseInstant(null))
        assertNull(WaffledDates.parseInstant(""))
        assertNull(WaffledDates.parseInstant("not a date"))
    }

    @Test
    fun bucketsToALocalDayInTheHouseholdZone() {
        // 01:30Z on the 22nd is still the 21st in New York — day bucketing must use the
        // household timezone, not UTC, or events land on the wrong day.
        val t = WaffledDates.parseInstant("2026-08-22T01:30:00Z")!!
        assertEquals("2026-08-21", WaffledDates.localDay(t, nyc).toString())
        assertEquals("2026-08-22", WaffledDates.localDay(t, ZoneId.of("UTC")).toString())
    }

    @Test
    fun formatsTheAgendaDateLikeIos() {
        val t = WaffledDates.parseInstant("2026-08-21T14:30:00Z")!!
        assertEquals("Fri, Aug 21, 2026", WaffledDates.format(t, "EEE, MMM d, yyyy", ZoneId.of("UTC"), Locale.US))
    }

    @Test
    fun formatterCachingReturnsTheSameInstanceForTheSamePattern() {
        // Allocating a formatter per row is a documented jank source; prove we reuse.
        val a = WaffledDates.formatter("EEE, MMM d", ZoneId.of("UTC"))
        val b = WaffledDates.formatter("EEE, MMM d", ZoneId.of("UTC"))
        assertEquals(true, a === b)
    }

    @Test
    fun localeIsPartOfTheCacheKeySoOneCallerCannotFixTheLanguageForEveryoneElse() {
        // Caching on pattern+zone alone means whoever formats FIRST pins the language
        // process-wide — a French device would then get English labels, or vice versa,
        // depending purely on call order.
        val en = WaffledDates.formatter("EEE, MMM d", ZoneId.of("UTC"), Locale.US)
        val fr = WaffledDates.formatter("EEE, MMM d", ZoneId.of("UTC"), Locale.FRANCE)
        assertNotEquals(en, fr)

        val t = WaffledDates.parseInstant("2026-08-21T14:30:00Z")!!
        assertEquals("Fri, Aug 21", WaffledDates.format(t, "EEE, MMM d", ZoneId.of("UTC"), Locale.US))
        assertEquals("ven., août 21", WaffledDates.format(t, "EEE, MMM d", ZoneId.of("UTC"), Locale.FRANCE))
    }

    @Test
    fun formattingDefaultsToTheDeviceLocaleNotAFixedOne() {
        // The default must follow the device so dates read naturally for the user.
        val t = WaffledDates.parseInstant("2026-08-21T14:30:00Z")!!
        val explicit = WaffledDates.format(t, "EEE, MMM d", ZoneId.of("UTC"), Locale.getDefault())
        assertEquals(explicit, WaffledDates.format(t, "EEE, MMM d", ZoneId.of("UTC")))
    }

    @Test
    fun emitsNoonIsoForADateOnlyValue() {
        // "Taken on this date" with no time: iOS pins noon so a timezone shift can't
        // slide it onto the previous or next day.
        assertEquals(
            "2026-08-21T16:00:00Z",
            WaffledDates.noonIso("2026-08-21", nyc),
        )
    }
}

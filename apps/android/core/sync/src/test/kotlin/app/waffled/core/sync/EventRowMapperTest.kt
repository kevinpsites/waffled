package app.waffled.core.sync

import com.powersync.db.SqlCursor
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Mapping a synced row into [SyncedEvent].
 *
 * Mapped **by column name**, not index. `SELECT *` column order is whatever SQLite
 * decides, and a positional mapper would silently shift every field the day a column is
 * added — putting a location into a title rather than failing.
 */
class EventRowMapperTest {

    /** Minimal in-memory cursor over one row. */
    private class FakeCursor(private val row: Map<String, Any?>) : SqlCursor {
        private val names = row.keys.toList()
        override val columnNames: Map<String, Int>
            get() = names.withIndex().associate { (i, n) -> n to i }
        override val columnCount: Int get() = names.size
        override fun columnName(index: Int): String = names[index]
        override fun getString(index: Int): String? = row[names[index]] as? String
        override fun getLong(index: Int): Long? = row[names[index]] as? Long
        override fun getDouble(index: Int): Double? = row[names[index]] as? Double
        override fun getBoolean(index: Int): Boolean? = row[names[index]] as? Boolean
        override fun getBytes(index: Int): ByteArray? = row[names[index]] as? ByteArray
    }

    @Test
    fun mapsTheFieldsScreensActuallyRead() {
        val e = EventRowMapper.map(
            FakeCursor(
                mapOf(
                    "id" to "e1",
                    "household_id" to "h1",
                    "title" to "Dinner",
                    "starts_at" to "2026-08-21T18:00:00Z",
                    "ends_at" to "2026-08-21T19:00:00Z",
                    "location" to "Kitchen",
                    "visibility" to "personal",
                    "owner_person_id" to "p1",
                    "origin" to "ics",
                    "goal_id" to "g1",
                ),
            ),
        )

        assertEquals("e1", e.id)
        assertEquals("Dinner", e.title)
        assertEquals("2026-08-21T18:00:00Z", e.startsAt)
        assertEquals("Kitchen", e.location)
        assertEquals("personal", e.visibility)
        assertEquals("p1", e.ownerPersonId)
        assertEquals("g1", e.goalId)
        // An event from a subscribed feed is read-only.
        assertTrue(e.isReadOnly)
    }

    @Test
    fun sqliteIntegersBecomeBooleans() {
        // SQLite has no boolean — all_day and is_countdown are 0/1.
        val e = EventRowMapper.map(
            FakeCursor(
                mapOf(
                    "id" to "e1", "household_id" to "h1", "title" to "t",
                    "all_day" to 1L, "is_countdown" to 0L,
                ),
            ),
        )
        assertTrue(e.allDay)
        assertFalse(e.isCountdown)
    }

    @Test
    fun missingColumnsAreNullRatherThanCrashing() {
        // A row from an older schema, or a projection that didn't select everything.
        val e = EventRowMapper.map(
            FakeCursor(mapOf("id" to "e1", "household_id" to "h1", "title" to "t")),
        )
        assertNull(e.startsAt)
        assertNull(e.rrule)
        assertFalse(e.allDay)
        assertFalse(e.isReadOnly)
    }

    @Test
    fun columnOrderDoesNotMatter() {
        // The whole reason to map by name: `SELECT *` order is not ours to control.
        val a = EventRowMapper.map(
            FakeCursor(linkedMapOf("id" to "e1", "household_id" to "h1", "title" to "Dinner", "location" to "Kitchen")),
        )
        val b = EventRowMapper.map(
            FakeCursor(linkedMapOf("location" to "Kitchen", "title" to "Dinner", "household_id" to "h1", "id" to "e1")),
        )
        assertEquals(a, b)
    }

    @Test
    fun anOccurrenceCarriesTheSeriesItBelongsTo() {
        // `event_occurrences` rows have no `rrule` — the master they belong to does, and
        // the master is excluded from the events query. So without `event_id` reaching
        // the model, EVERY recurring event on Android is indistinguishable from a plain
        // one AND has no id the API will accept: GET /api/events/:id 404s on an
        // occurrence id and wants the series. That made all recurring editing impossible.
        val occurrence = EventRowMapper.map(
            FakeCursor(
                mapOf(
                    "id" to "occ1",
                    "household_id" to "h1",
                    "title" to "Swimming",
                    "event_id" to "series1",
                    "original_start" to "2026-08-21T18:00:00Z",
                    "override_id" to "ovr1",
                    "starts_on" to "2026-08-21",
                ),
            ),
        )

        assertEquals("series1", occurrence.seriesId)
        assertEquals("2026-08-21T18:00:00Z", occurrence.originalStart)
        assertEquals("ovr1", occurrence.overrideId)
        assertTrue(occurrence.isOccurrence)
        // The id the API will actually accept for an edit.
        assertEquals("series1", occurrence.editableId)
    }

    @Test
    fun aPlainEventIsItsOwnEditTarget() {
        val plain = EventRowMapper.map(
            FakeCursor(mapOf("id" to "e1", "household_id" to "h1", "title" to "Dinner")),
        )
        assertNull(plain.seriesId)
        assertFalse(plain.isOccurrence)
        assertEquals("e1", plain.editableId)
    }

    @Test
    fun aRecurringMasterIsRecognisedByItsRrule() {
        val master = EventRowMapper.map(
            FakeCursor(mapOf("id" to "e1", "household_id" to "h1", "title" to "t", "rrule" to "FREQ=WEEKLY")),
        )
        assertEquals("FREQ=WEEKLY", master.rrule)
    }

    // ---- Postgres-text timestamps (SyncLogicTests.parsesPostgres*) ---------------

    private fun startsAt(raw: String): String? =
        EventRowMapper.map(FakeCursor(mapOf("id" to "e", "household_id" to "h", "title" to "t", "starts_at" to raw))).startsAt

    @Test
    fun serverReplicatedPostgresTextBecomesIso() {
        // Replicated rows arrive as `YYYY-MM-DD HH:MM:SS+00`, which java.time cannot read;
        // left as-is every synced event would be dropped from the day index.
        assertEquals("2026-06-16T17:49:00+00:00", startsAt("2026-06-16 17:49:00+00"))
        assertEquals("2026-06-16T17:49:00.123+00:00", startsAt("2026-06-16 17:49:00.123+00"))
        assertEquals("2026-06-16T17:49:00.123456+00:00", startsAt("2026-06-16 17:49:00.123456+00"))
        assertEquals("2026-06-16T11:49:00-06:00", startsAt("2026-06-16 11:49:00-06"))
        assertEquals("2026-06-16T11:49:00+05:30", startsAt("2026-06-16 11:49:00+05:30"))
    }

    @Test
    fun theTwoFormatsAgreeOnTheInstant() {
        val pg = app.waffled.core.model.WaffledDates.parseInstant(startsAt("2026-06-16 17:49:00+00"))
        val iso = app.waffled.core.model.WaffledDates.parseInstant(startsAt("2026-06-16T17:49:00Z"))
        assertEquals(iso, pg)
        assertEquals(
            app.waffled.core.model.WaffledDates.parseInstant("2026-06-16T17:49:00Z"),
            app.waffled.core.model.WaffledDates.parseInstant(startsAt("2026-06-16 11:49:00-06")),
        )
    }

    @Test
    fun isoAndDateOnlyValuesPassThroughUntouched() {
        assertEquals("2026-06-16T17:49:00Z", startsAt("2026-06-16T17:49:00Z"))
        assertEquals("2026-06-16", startsAt("2026-06-16"))
    }

    @Test
    fun everyTimestampColumnIsNormalised() {
        val e = EventRowMapper.map(
            FakeCursor(
                mapOf(
                    "id" to "o", "household_id" to "h", "title" to "t", "event_id" to "s",
                    "ends_at" to "2026-08-03 06:00:00+00",
                    "original_start" to "2026-07-27 06:00:00+00",
                    "updated_at" to "2026-07-01 00:00:00.5+00",
                ),
            ),
        )
        assertEquals("2026-08-03T06:00:00+00:00", e.endsAt)
        assertEquals("2026-07-27T06:00:00+00:00", e.originalStart)
        assertEquals("2026-07-01T00:00:00.5+00:00", e.updatedAt)
    }
}

package app.waffled.core.sync

import com.powersync.db.SqlCursor

/**
 * Turn a synced SQLite row into a [SyncedEvent].
 *
 * Mapped **by column name**, never by index. `SELECT *` returns whatever order SQLite
 * chooses, so a positional mapper would silently shift every field the day a column is
 * added — a location landing in a title rather than an outright failure. A missing column
 * reads as null for the same reason: degrade, don't crash.
 */
object EventRowMapper {

    fun map(cursor: SqlCursor): SyncedEvent {
        val columns = cursor.columnNames

        fun str(name: String): String? =
            columns[name]?.let { cursor.getString(it) }?.takeIf { it.isNotEmpty() }

        // SQLite has no boolean; these arrive as 0/1.
        fun bool(name: String): Boolean =
            columns[name]?.let { cursor.getLong(it) }?.let { it != 0L } ?: false

        return SyncedEvent(
            id = str("id").orEmpty(),
            householdId = str("household_id").orEmpty(),
            title = str("title").orEmpty(),
            startsAt = str("starts_at"),
            endsAt = str("ends_at"),
            allDay = bool("all_day"),
            isCountdown = bool("is_countdown"),
            location = str("location"),
            description = str("description"),
            personId = str("person_id"),
            calendarId = str("calendar_id"),
            goalId = str("goal_id"),
            goalStepId = str("goal_step_id"),
            origin = str("origin"),
            originRefId = str("origin_ref_id"),
            rrule = str("rrule"),
            visibility = str("visibility"),
            ownerPersonId = str("owner_person_id"),
            timezone = str("timezone"),
            status = str("status"),
            updatedAt = str("updated_at"),
            // Present only on `event_occurrences` rows — see SyncedEvent.seriesId.
            seriesId = str("event_id"),
            originalStart = str("original_start"),
            overrideId = str("override_id"),
        )
    }

    /**
     * What the calendar reads.
     *
     * A row with a non-null `rrule` is a recurring MASTER — its materialised occurrences
     * render instead, so including it would double-render every repeat. The server worker
     * keeps `event_occurrences` in step; there is no client-side RRULE expansion.
     */
    const val EVENTS_SQL: String = "SELECT * FROM events WHERE rrule IS NULL"

    /** Materialised occurrences of the recurring masters excluded above. */
    const val OCCURRENCES_SQL: String = "SELECT * FROM event_occurrences"
}

/**
 * Turn a synced `persons` row into a [app.waffled.core.model.Person].
 *
 * Mapped by column name for the same reason as events. Note that `capabilities` and
 * `is_admin` are NOT synced columns — they come from the REST session — so a person read
 * from sync has an empty capability set and gates to false. Merge with the REST roster
 * before using [app.waffled.core.model.Person.can].
 */
object PersonRowMapper {

    const val PERSONS_SQL: String = "SELECT * FROM persons ORDER BY sort_order"

    fun map(cursor: SqlCursor): app.waffled.core.model.Person {
        val columns = cursor.columnNames
        fun str(name: String): String? =
            columns[name]?.let { cursor.getString(it) }?.takeIf { it.isNotEmpty() }

        return app.waffled.core.model.Person(
            id = str("id").orEmpty(),
            householdId = str("household_id"),
            name = str("name").orEmpty(),
            colorHex = str("color_hex"),
            avatarEmoji = str("avatar_emoji"),
            memberType = str("member_type"),
            sortOrder = columns["sort_order"]?.let { cursor.getLong(it) }?.toInt(),
        )
    }
}

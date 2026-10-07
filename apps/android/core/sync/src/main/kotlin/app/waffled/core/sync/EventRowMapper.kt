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

        fun time(name: String): String? = str(name)?.let(::isoTimestamp)

        // SQLite has no boolean; these arrive as 0/1.
        fun bool(name: String): Boolean =
            columns[name]?.let { cursor.getLong(it) }?.let { it != 0L } ?: false

        return SyncedEvent(
            id = str("id").orEmpty(),
            householdId = str("household_id").orEmpty(),
            title = str("title").orEmpty(),
            startsAt = time("starts_at"),
            endsAt = time("ends_at"),
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
            updatedAt = time("updated_at"),
            // Present only on `event_occurrences` rows — see SyncedEvent.seriesId.
            seriesId = str("event_id"),
            originalStart = time("original_start"),
            overrideId = str("override_id"),
            rhythmId = str("rhythm_id"),
            // A group_concat aggregate; NULL when nobody is joined.
            participantIds = str("participant_ids")
                ?.split(',')?.map(String::trim)?.filter(String::isNotEmpty)?.distinct()
                .orEmpty(),
        )
    }

    private val postgresText = Regex("""^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(:?\d{2})?$""")

    /**
     * Server-replicated rows hold Postgres text (`2026-06-16 17:49:00+00`), which
     * `WaffledDates.parseInstant` cannot read; locally-written rows are already ISO.
     * Normalised once here so every reader of the mirror sees one shape.
     */
    fun isoTimestamp(raw: String): String {
        val m = postgresText.matchEntire(raw.trim()) ?: return raw
        val (date, clock, hours, minutes) = m.destructured
        val mm = minutes.removePrefix(":").ifEmpty { "00" }
        return "${date}T$clock$hours:$mm"
    }

    /**
     * What the calendar reads.
     *
     * A row with a non-null `rrule` is a recurring MASTER — its materialised occurrences
     * render instead, so including it would double-render every repeat. The server worker
     * keeps `event_occurrences` in step; there is no client-side RRULE expansion.
     *
     * `participant_ids` mirrors iOS `EventQuery.agenda`. Naming `event_participants` in
     * the SQL is also what makes the watch re-emit when only a participant row changes —
     * PowerSync derives the watched tables from the query. Soft-deleted participant rows
     * never reach the device (sync-config filters `deleted_at IS NULL`; the client table
     * has no such column).
     */
    const val EVENTS_SQL: String = """
        SELECT *,
               (SELECT group_concat(ep.person_id) FROM event_participants ep
                 WHERE ep.event_id = events.id) AS participant_ids
          FROM events WHERE rrule IS NULL
    """

    /**
     * Materialised occurrences of the recurring masters excluded above. Every field an
     * occurrence doesn't own comes from its master `m`, mirroring the web's `OCC_SELECT`:
     * `origin` keeps an ICS series read-only, and `rhythm_id` is how an auto-scheduled
     * rhythm — which renders ONLY through this query — keeps its marker. Aliases are
     * explicit because the mapper reads by column name. Participants are the master's too.
     */
    const val OCCURRENCES_SQL: String = """
        SELECT o.id AS id, o.household_id AS household_id, o.event_id AS event_id,
               o.override_id AS override_id, o.original_start AS original_start,
               coalesce(o.title, m.title) AS title, m.description AS description,
               coalesce(o.location, m.location) AS location,
               o.starts_at AS starts_at, o.ends_at AS ends_at, o.all_day AS all_day,
               m.is_countdown AS is_countdown, o.person_id AS person_id,
               m.calendar_id AS calendar_id, m.goal_id AS goal_id, m.goal_step_id AS goal_step_id,
               m.rhythm_id AS rhythm_id, m.origin AS origin, m.origin_ref_id AS origin_ref_id,
               m.timezone AS timezone, m.status AS status,
               o.visibility AS visibility, o.owner_person_id AS owner_person_id,
               (SELECT group_concat(ep.person_id) FROM event_participants ep
                 WHERE ep.event_id = m.id) AS participant_ids
          FROM event_occurrences o
          JOIN events m ON m.id = o.event_id
    """
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

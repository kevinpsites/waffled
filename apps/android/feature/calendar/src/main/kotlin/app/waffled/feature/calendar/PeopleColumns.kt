package app.waffled.feature.calendar

import app.waffled.core.model.Person

/**
 * Anything the calendar can bucket by person. Implemented by [EventRow]; the columns only
 * ever read the id and the people, so tests (and any future row type) need no more.
 */
interface CalendarEntry {
    val id: String
    val people: EventPeople
}

/**
 * Per-person calendar columns — the bucketing behind the People view, ported from
 * `apps/ios/.../Calendar/PeopleColumns.swift` and mirroring the web's `peopleColumns`
 * (`apps/web/src/kiosk/components/cal-people.ts`).
 *
 * An event lands in its OWNER's column and in every participant's column, so a shared
 * event reads from each person's lane instead of hiding under one name. "Owner" is
 * `person_id` (the assignee that drives the event's colour) — NOT `owner_person_id`, which
 * exists for personal-calendar visibility and says nothing about whose day this belongs to.
 *
 * Bucketing is COLUMN-driven (ask each person "is this yours?") rather than event-driven
 * (collect columns from an event's participants): participant rows may name someone outside
 * the household, and this ignores those for free instead of inventing a phantom column.
 *
 * The multi-column People VIEW itself is tablet-only and out of scope for the phone port —
 * a phone column is too narrow to read. The bucketing ships now because the phone's person
 * FILTER shares its membership rule ([belongsTo]), and one rule means the two can't drift.
 */
object PeopleColumns {

    /**
     * The leading catch-all column, present only when something needs it. Underscore-prefixed
     * so it can never collide with a person's uuid.
     */
    const val UNASSIGNED_ID: String = "_everyone"

    const val UNASSIGNED_NAME: String = "Everyone"

    data class Column<T : CalendarEntry>(
        val id: String,
        val name: String,
        val colorHex: String?,
        val avatarEmoji: String?,
        val events: List<T>,
    )

    /** Is this event [personId]'s — as owner or as a participant? */
    fun belongsTo(people: EventPeople, personId: String): Boolean =
        people.ownerPersonId == personId || personId in people.participantIds

    fun <T : CalendarEntry> build(events: List<T>, people: List<Person>): List<Column<T>> {
        val columns = people.map { member ->
            Column(
                id = member.id,
                name = member.name,
                colorHex = member.colorHex,
                avatarEmoji = member.avatarEmoji,
                events = events.filter { belongsTo(it.people, member.id) },
            )
        }

        // Anything no column claimed — nobody on it, or its only people have left the
        // household. It must not silently disappear from the view.
        val claimed = columns.flatMapTo(mutableSetOf()) { col -> col.events.map { it.id } }
        val orphans = events.filter { it.id !in claimed }
        if (orphans.isEmpty()) return columns

        return listOf(
            Column(UNASSIGNED_ID, UNASSIGNED_NAME, colorHex = null, avatarEmoji = null, events = orphans),
        ) + columns
    }

    // No lane packing lives here, matching iOS: the view that renders columns packs its own
    // lanes, and a second copy here would only ever be exercised by tests — so it could stay
    // green while the real one regressed.
}

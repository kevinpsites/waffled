package app.waffled.feature.calendar

import app.waffled.core.model.Person
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The Kotlin port of `apps/ios/Tests/PeopleColumnsTests.swift`, mirroring the web's
 * `peopleColumns` (`apps/web/src/kiosk/components/cal-people.ts`).
 *
 * An event belongs in its OWNER's column (`personId` — the assignee that drives the
 * colour, not `ownerPersonId`, which is the personal-calendar visibility flag) and
 * additionally in every participant's column, so a shared event reads from each person's
 * lane instead of hiding under one name.
 */
class PeopleColumnsTest {

    /** A minimal entry — the columns only ever look at the id and the people. */
    private data class Entry(
        override val id: String,
        override val people: EventPeople,
    ) : CalendarEntry

    private fun person(id: String, name: String) = Person(id = id, name = name)

    private fun event(id: String, owner: String? = null, participants: List<String> = emptyList()) =
        Entry(id, EventPeople(ownerPersonId = owner, participantIds = participants.toSet()))

    private val family = listOf(person("p1", "Jerry"), person("p2", "Elaine"), person("p3", "George"))

    /** Which column ids an event landed in. */
    private fun landedIn(columns: List<PeopleColumns.Column<Entry>>, eventId: String): List<String> =
        columns.filter { col -> col.events.any { it.id == eventId } }.map { it.id }

    @Test
    fun anOwnedEventGoesInTheOwnersColumn() {
        val columns = PeopleColumns.build(listOf(event("e1", owner = "p1")), family)
        assertEquals(listOf("p1"), landedIn(columns, "e1"))
    }

    @Test
    fun aSharedEventRepeatsInEveryParticipantsColumn() {
        // The point of the feature.
        val e = event("e1", owner = "p1", participants = listOf("p1", "p2"))
        assertEquals(listOf("p1", "p2"), landedIn(PeopleColumns.build(listOf(e), family), "e1"))
    }

    @Test
    fun unionsOwnerAndParticipantsWithoutDuplicating() {
        // The write paths disagree about whether the owner is ALSO a participant row (the
        // editor derives personId from participants.first; the meal/goal paths don't).
        // Union both so it doesn't matter which one wrote the event.
        val columns = PeopleColumns.build(listOf(event("e1", owner = "p1", participants = listOf("p2"))), family)
        assertEquals(listOf("p1", "p2"), landedIn(columns, "e1"))
        assertEquals(1, columns.first { it.id == "p1" }.events.size)
    }

    @Test
    fun ignoresParticipantsOutsideTheHousehold() {
        // Participant rows may name someone outside the household (a null person_id with an
        // external_email). Bucketing is column-driven, so an unknown id has no column to
        // land in — it must not invent one.
        val e = event("e1", owner = "p1", participants = listOf("newman"))
        assertEquals(listOf("p1", "p2", "p3"), PeopleColumns.build(listOf(e), family).map { it.id })
    }

    @Test
    fun keepsAColumnForEveryPersonEvenAnEmptyOne() {
        val columns = PeopleColumns.build(listOf(event("e1", owner = "p1")), family)
        assertEquals(listOf("p1", "p2", "p3"), columns.map { it.id })
        assertTrue(columns.first { it.id == "p3" }.events.isEmpty())
    }

    @Test
    fun unassignedEventsGetALeadingEveryoneColumn() {
        // An event belonging to nobody must not vanish.
        val columns = PeopleColumns.build(listOf(event("e1"), event("e2", owner = "p1")), family)
        assertEquals(PeopleColumns.UNASSIGNED_ID, columns.first().id)
        assertEquals(listOf(PeopleColumns.UNASSIGNED_ID), landedIn(columns, "e1"))
    }

    @Test
    fun omitsTheEveryoneColumnWhenEverythingHasSomeone() {
        val columns = PeopleColumns.build(listOf(event("e1", owner = "p1")), family)
        assertFalse(columns.any { it.id == PeopleColumns.UNASSIGNED_ID })
    }

    // ---- the phone's person filter ---------------------------------------------

    @Test
    fun thePersonFilterMatchesTheOwnerOrAnyParticipant() {
        // The phone has no People mode — a column is too narrow to read, so the filter chip
        // covers "just show me one person's day" instead. Same membership rule.
        val shared = event("e1", owner = "p1", participants = listOf("p2"))
        assertTrue(PeopleColumns.belongsTo(shared.people, "p1"))
        assertTrue(PeopleColumns.belongsTo(shared.people, "p2"))
        assertFalse(PeopleColumns.belongsTo(shared.people, "p3"))
    }
}

package app.waffled.feature.kiosk

import app.waffled.core.sync.SyncedEvent
import kotlin.test.Test
import kotlin.test.assertEquals

class KioskEventsByPersonTest {
    private fun event(id: String, owner: String?, participants: List<String> = emptyList()) =
        SyncedEvent(id = id, householdId = "h", title = id, startsAt = null, personId = owner, participantIds = participants)

    @Test
    fun anEventLandsOnItsOwnerAndEveryParticipant() {
        val events = listOf(event("a", "p1"), event("b", null, listOf("p1", "p2")), event("c", "p2"))

        val byPerson = KioskEventsByPerson.group(listOf("p1", "p2", "p3"), events)

        assertEquals(listOf("a", "b"), byPerson["p1"]?.map { it.id })
        assertEquals(listOf("b", "c"), byPerson["p2"]?.map { it.id })
        assertEquals(emptyList(), byPerson["p3"].orEmpty())
    }
}

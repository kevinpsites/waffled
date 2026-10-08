package app.waffled.feature.goals

import app.waffled.core.network.WaffledJson
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Kotlin port of `apps/ios/Tests/GoalLogEntryEditableTests.swift`, plus the save shape
 * the entry sheet builds from it.
 *
 * An entry that counted itself — a checklist tick, a confirmed calendar event, a Health
 * sync — comes back `editable: false`: the server keeps its amount, day and people in step
 * with its source and refuses changes to them, so the sheet offers the note alone.
 */
class GoalLogEntryEditableTest {

    private fun decode(json: String) = WaffledJson.decodeFromString<GoalsApi.GoalDetail.LogEntry>(json)

    @Test
    fun readsTheFlagWhenTheServerSendsIt() {
        val derived = decode(
            """{"id":"l1","amount":1,"loggedAt":"2026-08-31T18:00:00Z","dateKey":"2026-08-31","note":null,"participants":[],"editable":false,"source":"calendar"}""",
        )
        assertEquals(false, derived.editable)
        assertEquals("calendar", derived.source)

        val own = decode(
            """{"id":"l2","amount":3,"loggedAt":"2026-08-31T18:00:00Z","dateKey":"2026-08-31","note":"hike","participants":[],"editable":true}""",
        )
        assertEquals(true, own.editable)
    }

    @Test
    fun decodesAgainstAServerTooOldToSendIt() {
        val entry = decode(
            """{"id":"l3","amount":2,"loggedAt":"2026-08-31T18:00:00Z","dateKey":"2026-08-31","note":null,"participants":[]}""",
        )
        // Null, not false — only an explicit false locks, so an older server behaves as before.
        assertNull(entry.editable)
        assertFalse(GoalEntryEdit.isLocked(entry))
    }

    private val derived = GoalsApi.GoalDetail.LogEntry(
        id = "l1", amount = 1.0, dateKey = "2026-08-31", editable = false,
        participants = listOf(GoalsApi.GoalDetail.LogEntry.Credited(personId = "p1")),
    )

    @Test
    fun aLockedEntrySendsItsNoteWithItsOwnDayAndNothingElse() {
        assertTrue(GoalEntryEdit.isLocked(derived))
        val patch = GoalEntryEdit.patch(
            entry = derived, goalType = "total", participantCount = 3,
            amount = 9.0, who = setOf("p2"), note = "  walked the dog ", day = LocalDate.of(2026, 9, 2),
        )
        // The server accepts a note-only change when amount, day and people are unchanged;
        // the entry's own day is re-sent so it never drifts.
        assertEquals(GoalEntryEdit.Patch(amount = null, personIds = null, note = "walked the dog", loggedOn = "2026-08-31"), patch)
    }

    @Test
    fun anOwnEntrySendsEverythingThePersonCanChange() {
        val own = derived.copy(editable = true)
        val patch = GoalEntryEdit.patch(
            entry = own, goalType = "count", participantCount = 3,
            amount = 2.4, who = setOf("p2"), note = "", day = LocalDate.of(2026, 9, 2),
        )
        assertEquals(GoalEntryEdit.Patch(amount = 2.0, personIds = listOf("p2"), note = "", loggedOn = "2026-09-02"), patch)
    }

    @Test
    fun aHabitEntryHasNoAmountAndASoloGoalNoWho() {
        val patch = GoalEntryEdit.patch(
            entry = derived.copy(editable = null), goalType = "habit", participantCount = 1,
            amount = 1.0, who = setOf("p1"), note = "x", day = LocalDate.of(2026, 9, 2),
        )
        assertNull(patch.amount)
        assertNull(patch.personIds)
    }
}

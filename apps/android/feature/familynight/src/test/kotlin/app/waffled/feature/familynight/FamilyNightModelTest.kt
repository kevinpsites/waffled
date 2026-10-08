package app.waffled.feature.familynight

import kotlinx.coroutines.test.runTest
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** Port of `FamilyNightModelTests.swift`. */
class FamilyNightModelTest {

    private class Rejected : Exception()

    private class Feed(var snapshot: FamilyNightApi.View) {
        var fetchFails = false
        var saveFails = false
        var fetchCount = 0
        val saves = mutableListOf<Triple<String, String, String?>>()
    }

    private fun familyNight(personId: String? = "person-1", personName: String? = "Avery"): FamilyNightApi.View {
        val part = FamilyNightApi.Part(id = "activity", label = "Activity", emoji = "gamecontroller", rotates = true)
        return FamilyNightApi.View(
            config = FamilyNightApi.Config(parts = listOf(part), dayOfWeek = 5, time = "19:00"),
            members = listOf(
                FamilyNightApi.Member(id = "person-1", name = "Avery"),
                FamilyNightApi.Member(id = "person-2", name = "Jordan"),
            ),
            next = FamilyNightApi.Next(
                date = "2026-07-31",
                occurrenceId = "occurrence-1",
                status = "planned",
                assignments = listOf(
                    FamilyNightApi.Assignment(
                        partId = part.id,
                        label = part.label,
                        emoji = part.emoji,
                        personId = personId,
                        personName = personName,
                        suggested = false,
                    ),
                ),
            ),
        )
    }

    private fun model(feed: Feed) = FamilyNightModel(
        fetchFamilyNight = {
            feed.fetchCount++
            if (feed.fetchFails) throw Rejected()
            feed.snapshot
        },
        saveAssignment = { date, partId, personId ->
            feed.saves += Triple(date, partId, personId)
            if (feed.saveFails) throw Rejected()
            val name = feed.snapshot.members.firstOrNull { it.id == personId }?.name
            feed.snapshot = familyNight(personId, name)
        },
    )

    private val FamilyNightModel.firstName get() = state.value.view?.next?.assignments?.firstOrNull()?.personName

    @Test
    fun `failed refresh keeps the last confirmed schedule`() = runTest {
        val feed = Feed(familyNight())
        val model = model(feed)
        model.load()
        feed.fetchFails = true

        model.load()

        assertEquals("Avery", model.firstName)
        assertTrue(model.state.value.loaded)
    }

    @Test
    fun `failed assignment keeps snapshot and does not refetch`() = runTest {
        val feed = Feed(familyNight())
        feed.saveFails = true
        val model = model(feed)
        model.load()

        assertFailsWith<Rejected> { model.assign(partId = "activity", personId = "person-2") }

        assertEquals(1, feed.saves.size)
        assertEquals(1, feed.fetchCount)
        assertEquals("Avery", model.firstName)
    }

    @Test
    fun `successful assignment reloads the confirmed schedule`() = runTest {
        val feed = Feed(familyNight())
        val model = model(feed)
        model.load()

        val outcome = model.assign(partId = "activity", personId = "person-2")

        assertEquals(FamilyNightModel.MutationOutcome.Refreshed, outcome)
        assertEquals(Triple("2026-07-31", "activity", "person-2"), feed.saves.first())
        assertEquals(2, feed.fetchCount)
        assertEquals("Jordan", model.firstName)
    }

    @Test
    fun `successful assignment reports when the follow-up refresh fails`() = runTest {
        val feed = Feed(familyNight())
        val model = model(feed)
        model.load()
        feed.fetchFails = true

        val outcome = model.assign(partId = "activity", personId = "person-2")

        assertEquals(FamilyNightModel.MutationOutcome.SavedButRefreshFailed, outcome)
        assertEquals(1, feed.saves.size)
        assertEquals(2, feed.fetchCount)
        assertEquals("Avery", model.firstName)
    }

    @Test
    fun `assigning before anything has loaded is a no-op`() = runTest {
        val feed = Feed(familyNight())
        val model = model(feed)

        assertEquals(FamilyNightModel.MutationOutcome.Refreshed, model.assign("activity", "person-2"))
        assertEquals(0, feed.saves.size)
    }
}

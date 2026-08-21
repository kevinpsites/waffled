package app.waffled.feature.calendar

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * The Kotlin port of `apps/ios/Tests/CountdownsModelTests.swift`.
 *
 * The model is driven through function seams (the same shape iOS uses) rather than a
 * mocked HTTP client: these are state-machine rules — what survives a failed write, what a
 * double-tap does — and they must hold regardless of how the request was made. The wire
 * contract is covered separately in `CalendarApiTest` against a real MockWebServer.
 */
class CountdownsModelTest {

    private class Rejected : Exception("rejected")

    /** A scriptable stand-in for the countdowns endpoint. */
    private class Feed(var items: List<CalendarApi.Countdown>) {
        var fetchCount = 0
        var createFails = false
        var updateFails = false
        var deleteFails = false
        val deletedIds = mutableListOf<String>()
        var deleteGate: CompletableDeferred<Unit>? = null
    }

    private fun countdown(id: String, title: String = "Beach trip", source: String = "standalone") =
        CalendarApi.Countdown(
            id = id,
            title = title,
            date = "2026-08-15",
            daysLeft = 21,
            source = source,
            emoji = "🏖️",
        )

    private fun model(feed: Feed) = CountdownsModel(
        fetchCountdowns = {
            feed.fetchCount++
            CountdownsModel.Fetched(feed.items, sleeps = false)
        },
        createCountdown = { _, _, _ -> if (feed.createFails) throw Rejected() },
        updateCountdown = { _, _, _, _ -> if (feed.updateFails) throw Rejected() },
        deleteCountdown = { id ->
            feed.deletedIds += id
            feed.deleteGate?.await()
            if (feed.deleteFails) throw Rejected()
        },
    )

    // ---- formatting ------------------------------------------------------------

    @Test
    fun theTodayCardWordingHonoursTheSleepsSetting() {
        assertEquals("Today!", CountdownFormat.label(0, sleeps = false))
        assertEquals("Today!", CountdownFormat.label(-3, sleeps = true))
        assertEquals("Tomorrow", CountdownFormat.label(1, sleeps = false))
        assertEquals("1 sleep", CountdownFormat.label(1, sleeps = true))
        assertEquals("5 days", CountdownFormat.label(5, sleeps = false))
        assertEquals("5 sleeps", CountdownFormat.label(5, sleeps = true))
    }

    @Test
    fun theCompactMonthBadgeIgnoresTheSleepsSetting() {
        assertEquals("Today!", CountdownFormat.short(0))
        assertEquals("5d", CountdownFormat.short(5))
    }

    @Test
    fun formatsAYmdDateForDisplayAndDegradesOnJunk() {
        assertEquals("Aug 3", CountdownFormat.dateLabel("2026-08-03"))
        assertEquals("", CountdownFormat.dateLabel("not-a-date"))
    }

    // ---- loading ---------------------------------------------------------------

    @Test
    fun groupsLoadedItemsByDateForTheMonthBadges() = runTest {
        // Stored (rebuilt when items change) so 42 month cells don't each regroup the list
        // per render.
        val feed = Feed(listOf(countdown("c1"), countdown("c2"), countdown("c3").copy(date = "2026-09-01")))
        val model = model(feed)

        model.load()

        assertEquals(listOf("c1", "c2"), model.byDate["2026-08-15"]?.map { it.id })
        assertEquals(listOf("c3"), model.byDate["2026-09-01"]?.map { it.id })
        assertTrue(model.loaded)
    }

    @Test
    fun aFailedLoadStillMarksTheModelLoaded() = runTest {
        // Otherwise the card sits on "Loading…" for ever.
        val model = CountdownsModel(
            fetchCountdowns = { throw Rejected() },
            createCountdown = { _, _, _ -> },
            updateCountdown = { _, _, _, _ -> },
            deleteCountdown = { },
        )
        model.load()
        assertTrue(model.loaded)
        assertTrue(model.items.isEmpty())
    }

    // ---- mutations -------------------------------------------------------------

    @Test
    fun aFailedDeleteKeepsTheCountdownAndAllowsARetry() = runTest {
        val item = countdown("countdown-1")
        val feed = Feed(listOf(item))
        feed.deleteFails = true
        val model = model(feed)
        model.load()

        assertFailsWith<Rejected> { model.remove(item) }

        assertEquals(listOf("countdown-1"), feed.deletedIds)
        assertEquals(listOf("countdown-1"), model.items.map { it.id })

        feed.deleteFails = false
        model.remove(item)

        assertEquals(listOf("countdown-1", "countdown-1"), feed.deletedIds)
        assertTrue(model.items.isEmpty())
    }

    @Test
    fun aSuccessfulDeleteRemovesTheCountdown() = runTest {
        val first = countdown("countdown-1")
        val feed = Feed(listOf(first, countdown("countdown-2")))
        val model = model(feed)
        model.load()

        model.remove(first)

        assertEquals(listOf("countdown-1"), feed.deletedIds)
        assertEquals(listOf("countdown-2"), model.items.map { it.id })
    }

    @Test
    fun concurrentDeletesIssueOneRequest() = runTest {
        // A double-tap on the ✕ must not fire two DELETEs.
        val item = countdown("countdown-1")
        val feed = Feed(listOf(item))
        val gate = CompletableDeferred<Unit>()
        feed.deleteGate = gate
        val model = model(feed)
        model.load()

        val first = async { model.remove(item) }
        while (feed.deletedIds.isEmpty()) yield()

        model.remove(item)
        assertEquals(listOf("countdown-1"), feed.deletedIds)

        gate.complete(Unit)
        first.await()

        assertEquals(listOf("countdown-1"), feed.deletedIds)
        assertTrue(model.items.isEmpty())
    }

    @Test
    fun onlyStandaloneItemsCanBeRemovedOrEdited() = runTest {
        // Events and birthdays are managed at their source.
        val birthday = countdown("b1", source = "birthday")
        val feed = Feed(listOf(birthday))
        val model = model(feed)
        model.load()

        model.remove(birthday)
        model.update(birthday, title = "Nope", date = "2026-09-01", emoji = null)

        assertTrue(feed.deletedIds.isEmpty())
        assertEquals(listOf("b1"), model.items.map { it.id })
    }

    @Test
    fun aFailedCreatePropagatesWithoutRefreshing() = runTest {
        val feed = Feed(emptyList())
        feed.createFails = true
        val model = model(feed)
        model.load()

        assertFailsWith<Rejected> { model.add(title = "Vacation", date = "2026-09-01", emoji = null) }

        assertEquals(1, feed.fetchCount)
        assertTrue(model.items.isEmpty())
    }

    @Test
    fun aFailedUpdateKeepsTheExistingCountdown() = runTest {
        val item = countdown("countdown-1", title = "Beach trip")
        val feed = Feed(listOf(item))
        feed.updateFails = true
        val model = model(feed)
        model.load()

        assertFailsWith<Rejected> {
            model.update(item, title = "Mountain trip", date = "2026-09-01", emoji = null)
        }

        assertEquals("Beach trip", model.items.first().title)
        assertEquals(1, feed.fetchCount)
    }

    @Test
    fun aSuccessfulWriteReloadsSoTheServersMergedListWins() = runTest {
        // daysLeft and the birthday/event rows are computed server-side, so the model
        // re-reads rather than patching its own copy.
        val feed = Feed(emptyList())
        val model = model(feed)
        model.load()

        feed.items = listOf(countdown("new"))
        model.add(title = "Vacation", date = "2026-09-01", emoji = null)

        assertEquals(2, feed.fetchCount)
        assertEquals(listOf("new"), model.items.map { it.id })
    }
}

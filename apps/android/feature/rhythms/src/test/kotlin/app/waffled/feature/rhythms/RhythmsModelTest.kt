package app.waffled.feature.rhythms

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Translated from the model, register-failure, backdate and paused-action suites of `RhythmsTests.swift`. */
class RhythmsModelTest {

    private class Rejected : Exception("rejected")

    private class Feed(
        var attention: List<RhythmsApi.AttentionItem> = emptyList(),
        var all: List<RhythmsApi.Rhythm> = emptyList(),
    ) {
        var fetchFails = false
        var mutationFails = false
        var attentionLoads = 0
        var listLoads = 0
        val completed = mutableListOf<String>()
        val completedAt = mutableListOf<String?>()
        val skipped = mutableListOf<Pair<String, String>>()
        val booked = mutableListOf<List<Any?>>()
        val deleted = mutableListOf<String>()
        val saved = mutableListOf<Pair<String?, JsonObject>>()

        private fun guard() { if (mutationFails) throw Rejected() }

        fun model(now: Instant = at("2026-08-18T12:00:00")) = RhythmsModel(
            fetchAttention = { _, _ ->
                attentionLoads++
                if (fetchFails) throw Rejected()
                attention
            },
            fetchRhythms = {
                listLoads++
                if (fetchFails) throw Rejected()
                all
            },
            complete = { id, at -> guard(); completed += id; completedAt += at },
            skip = { id, start -> guard(); skipped += id to start },
            book = { id, startsAt, allDay, periodStart -> guard(); booked += listOf(id, startsAt, allDay, periodStart) },
            save = { id, body -> guard(); saved += id to body },
            remove = { id -> guard(); deleted += id },
            zone = { UTC },
            now = { now },
        )
    }

    // ---- loads ----

    @Test
    fun `attention loads sorted, and every row's status line is precomputed on load`() = runTest {
        val feed = Feed(
            attention = listOf(
                unscheduled(rhythm(id = "b", title = "Temple visit", satisfiedBy = RhythmShape.Scheduling), "2026-07-01", "2026-08-25"),
                due(rhythm(id = "a", title = "Air filter"), "2026-08-15T09:00:00Z", overdue = true),
            ),
        )
        val model = feed.model()
        model.loadAttention()
        val s = model.state.value
        assertTrue(s.loaded)
        assertEquals(listOf("a", "b"), s.attention.map { it.rhythm.id })
        assertEquals("3 days late", s.statusLines["a"])
        assertEquals("7 days left to book it", s.statusLines["b"])
    }

    @Test
    fun `an attention kind this build has no words for is dropped, the rest kept`() = runTest {
        val feed = Feed(
            attention = listOf(
                due(rhythm(id = "a"), "2026-08-15T09:00:00Z", overdue = true),
                RhythmsApi.AttentionItem(rawKind = "nudged", rhythm = rhythm(id = "z")),
            ),
        )
        val model = feed.model()
        model.loadAttention()
        assertEquals(listOf("a"), model.state.value.attention.map { it.rhythm.id })
    }

    @Test
    fun `a failed refresh keeps what was on screen but still counts as loaded`() = runTest {
        val feed = Feed(attention = listOf(due(rhythm(id = "a"), "2026-08-15T09:00:00Z", overdue = true)))
        val model = feed.model()
        model.loadAttention()
        feed.fetchFails = true
        model.loadAttention()
        assertTrue(model.state.value.loaded)
        assertEquals(listOf("a"), model.state.value.attention.map { it.rhythm.id })
    }

    // ---- mutations ----

    @Test
    fun `marking a due rhythm done posts the completion, then refetches`() = runTest {
        val feed = Feed(attention = listOf(due(rhythm(id = "a"), "2026-08-15T09:00:00Z", overdue = true)))
        val model = feed.model()
        model.loadAttention()
        feed.attention = emptyList()
        model.markDone("a")
        assertEquals(listOf("a"), feed.completed)
        assertEquals(2, feed.attentionLoads)
        assertEquals(0, feed.listLoads)
        assertTrue(model.state.value.attention.isEmpty())
    }

    @Test
    fun `skipping a period sends the period start it was surfaced with`() = runTest {
        val item = unscheduled(rhythm(id = "b", satisfiedBy = RhythmShape.Scheduling), "2026-07-01", "2026-10-01")
        val feed = Feed(attention = listOf(item))
        val model = feed.model()
        model.loadAttention()
        model.skipPeriod(item)
        assertEquals(listOf("b" to "2026-07-01"), feed.skipped)
    }

    @Test
    fun `booking a period hands the server an instant and refetches`() = runTest {
        val feed = Feed(attention = listOf(unscheduled(rhythm(id = "b", satisfiedBy = RhythmShape.Scheduling), "2026-07-01", "2026-10-01")))
        val model = feed.model()
        model.loadAttention()
        model.book("b", at("2026-08-20T18:00:00"), allDay = false, periodStart = "2026-07-01")
        assertEquals(listOf<Any?>("b", "2026-08-20T18:00:00Z", false, "2026-07-01"), feed.booked.single())
        assertEquals(2, feed.attentionLoads)
    }

    @Test
    fun `a mutation that fails throws and leaves the list untouched`() = runTest {
        val feed = Feed(attention = listOf(due(rhythm(id = "a"), "2026-08-15T09:00:00Z", overdue = true)))
        val model = feed.model()
        model.loadAttention()
        feed.mutationFails = true
        assertFailsWith<Rejected> { model.markDone("a") }
        assertEquals(listOf("a"), model.state.value.attention.map { it.rhythm.id })
    }

    @Test
    fun `pausing a rhythm is a PATCH of isActive, not a delete`() = runTest {
        val feed = Feed(all = listOf(rhythm(id = "a")))
        val model = feed.model()
        model.loadAll()
        model.setActive("a", isActive = false)
        assertTrue(feed.deleted.isEmpty())
        assertEquals("a", feed.saved.single().first)
        assertEquals(JsonPrimitive(false), feed.saved.single().second["isActive"])
        assertEquals(2, feed.listLoads)
    }

    @Test
    fun `deleting removes it for good and refetches the register`() = runTest {
        val feed = Feed(all = listOf(rhythm(id = "a")))
        val model = feed.model()
        model.loadAll()
        feed.all = emptyList()
        model.delete("a")
        assertEquals(listOf("a"), feed.deleted)
        assertTrue(model.state.value.rhythms.isEmpty())
    }

    @Test
    fun `pushing out patches a new due date a week past the later of now and due`() = runTest {
        val r = rhythm(id = "a", nextDueAt = "2026-08-14T09:00:00Z")
        val feed = Feed(all = listOf(r))
        val model = feed.model(now = at("2026-08-20T09:00:00"))
        model.pushOut(r)
        assertEquals(JsonPrimitive("2026-08-27T09:00:00Z"), feed.saved.single().second["nextDueAt"])
    }

    @Test
    fun `saving a new form creates, saving an edited one patches`() = runTest {
        val feed = Feed()
        val model = feed.model()
        model.save(RhythmForm(title = "Trash"))
        model.save(RhythmForm(editingId = "a", title = "Trash"))
        assertNull(feed.saved[0].first)
        assertNotNull(feed.saved[0].second["satisfiedBy"])
        assertEquals("a", feed.saved[1].first)
        assertNull(feed.saved[1].second["satisfiedBy"])
    }

    // ---- the register ----

    @Test
    fun `the register bands by when, not by kind, and precomputes each row's detail line`() = runTest {
        val feed = Feed(
            all = listOf(
                rhythm(id = "a", title = "Air filter", lastCompletedAt = "2026-05-20T09:00:00Z", nextDueAt = "2026-08-20T09:00:00Z"),
                rhythm(
                    id = "b", title = "Temple visit", satisfiedBy = RhythmShape.Scheduling, startsOn = "2026-01-01",
                    currentPeriodStart = "2026-07-01", currentPeriodEnd = "2026-10-01", satisfied = true,
                    bookedAt = "2026-08-19T18:00:00Z",
                ),
            ),
        )
        val model = feed.model()
        model.loadAll()
        val s = model.state.value
        assertEquals(listOf("Coming up", "Steady"), s.bands.map { it.title })
        assertEquals(listOf("a"), s.bands.first().rhythms.map { it.id })
        assertEquals(listOf("b"), s.bands.last().rhythms.map { it.id })
        assertEquals("Booked", s.countdowns["b"]?.number)
        assertTrue(s.detailLines["a"]!!.contains("last done"))
        assertFalse(s.detailLines["b"]!!.contains("last done"))
        assertTrue(s.detailLines["b"]!!.contains("on the calendar for "))
    }

    @Test
    fun `paused rhythms are named apart from the bands`() = runTest {
        val feed = Feed(all = listOf(rhythm(id = "z", title = "Zed", isActive = false), rhythm(id = "y", title = "Yak", isActive = false)))
        val model = feed.model()
        model.loadAll()
        assertTrue(model.state.value.bands.isEmpty())
        assertEquals(listOf("Yak", "Zed"), model.state.value.paused.map { it.title })
    }

    @Test
    fun `member names arriving after the rhythms still reach the detail lines`() = runTest {
        val feed = Feed(all = listOf(rhythm(id = "a", personId = "p1", every = "1 year")))
        val model = feed.model()
        model.loadAll()
        assertEquals("Every year · never done", model.state.value.detailLines["a"])
        model.setPersonNames(mapOf("p1" to "Jerry"))
        assertEquals("Every year · never done · Jerry", model.state.value.detailLines["a"])
    }

    @Test
    fun `a failure after a good load is still reported, the rows stay, and recovery clears it`() = runTest {
        val feed = Feed(all = listOf(rhythm(id = "a")))
        val model = feed.model()
        model.loadAll()
        assertFalse(model.state.value.listFailed)
        feed.fetchFails = true
        model.loadAll()
        assertTrue(model.state.value.listFailed)
        assertEquals(listOf("a"), model.state.value.rhythms.map { it.id })
        feed.fetchFails = false
        model.loadAll()
        assertFalse(model.state.value.listFailed)
    }

    @Test
    fun `a failure on the very first load is reported, not shown as an empty household`() = runTest {
        val feed = Feed(all = listOf(rhythm(id = "a")))
        feed.fetchFails = true
        val model = feed.model()
        model.loadAll()
        assertTrue(model.state.value.listLoaded)
        assertTrue(model.state.value.listFailed)
    }

    // ---- backdating ----

    @Test
    fun `marking done now sends no date, an earlier day sends that day`() = runTest {
        val feed = Feed(all = listOf(rhythm(id = "a")))
        val model = feed.model()
        model.markDone("a")
        model.markDone("a", on = at("2026-08-14T12:00:00"))
        assertNull(feed.completedAt[0])
        assertEquals("2026-08-14T12:00:00Z", feed.completedAt[1])
    }

    // ---- paused rhythms offer no period actions ----

    @Test
    fun `an active rhythm finds its attention item, a paused one does not`() = runTest {
        val active = rhythm(id = "a", satisfiedBy = RhythmShape.Scheduling)
        val feed = Feed(attention = listOf(unscheduled(active, "2026-08-01", "2026-09-01")), all = listOf(active))
        val model = feed.model()
        model.loadAttention()
        assertNotNull(model.attentionItem(active))
        assertNull(model.attentionItem(active.copy(isActive = false)))
    }

    // ---- detail lines ----

    private val metaNow = at("2026-08-26T12:00:00")

    @Test
    fun `a rhythm whose periods haven't started says so`() {
        val future = rhythm(
            id = "f", satisfiedBy = RhythmShape.Scheduling, startsOn = "2027-03-01", autoSchedule = true,
            rrule = "FREQ=WEEKLY;BYDAY=MO", satisfied = false,
        )
        val lines = RhythmsModel.detailLines(listOf(future), emptyMap(), at("2026-08-19T12:00:00"), UTC)
        assertEquals("Every 3 months · periods start Mar 1, 2027", lines["f"])
    }

    @Test
    fun `a register row leads with the cadence and never restates its own countdown`() {
        val booking = rhythm(
            id = "t", title = "Trash", personId = "p1", satisfiedBy = RhythmShape.Scheduling, every = "7 days",
            startsOn = "2026-08-19", currentPeriodStart = "2026-08-19", currentPeriodEnd = "2026-08-27", satisfied = false,
        )
        assertEquals(
            "Every week · not on the calendar yet · Jerry",
            RhythmsModel.detailLines(listOf(booking), mapOf("p1" to "Jerry"), metaNow, UTC)["t"],
        )
        val booked = rhythm(
            id = "u", title = "Temple visit", satisfiedBy = RhythmShape.Scheduling, every = "7 days",
            currentPeriodStart = "2026-08-19", currentPeriodEnd = "2026-08-27", satisfied = true,
            bookedAt = "2026-08-20T18:00:00Z",
        )
        assertEquals(
            "Every week · on the calendar for Aug 20, 6:00 PM",
            RhythmsModel.detailLines(listOf(booked), emptyMap(), metaNow, UTC)["u"],
        )
    }

    @Test
    fun `a settled period says whether it was booked or skipped`() {
        val skipped = rhythm(
            satisfiedBy = RhythmShape.Scheduling, startsOn = "2026-08-17",
            currentPeriodStart = "2026-08-17", currentPeriodEnd = "2026-08-24", satisfied = true,
        )
        assertTrue(RhythmsModel.detailLines(listOf(skipped), emptyMap(), metaNow, UTC)["r1"]!!.contains("handled without a booking"))
    }

    @Test
    fun `a self-booking row separates one empty period from a series that is gone`() {
        val alive = rhythm(
            id = "a", title = "Temple Visit", personId = "p1", satisfiedBy = RhythmShape.Scheduling,
            every = "7 days", startsOn = "2026-08-19", autoSchedule = true, rrule = "FREQ=WEEKLY;BYDAY=WE",
            currentPeriodStart = "2026-08-26", currentPeriodEnd = "2026-09-02", satisfied = false, hasSeries = true,
        )
        assertEquals(
            "Every week · nothing on the calendar this time · Jerry",
            RhythmsModel.detailLines(listOf(alive), mapOf("p1" to "Jerry"), metaNow, UTC)["a"],
        )
        val gone = alive.copy(id = "g", personId = null, hasSeries = false)
        assertEquals(
            "Every week · the series needs putting back",
            RhythmsModel.detailLines(listOf(gone), emptyMap(), metaNow, UTC)["g"],
        )
        val healthy = alive.copy(id = "b", personId = null, satisfied = true, bookedAt = "2026-08-26T18:00:00Z")
        assertEquals(
            "Every week · on the calendar for Aug 26, 6:00 PM",
            RhythmsModel.detailLines(listOf(healthy), emptyMap(), metaNow, UTC)["b"],
        )
    }

    @Test
    fun `a completion row says when it last happened, and admits when it never has`() {
        val done = rhythm(
            id = "a", title = "Air filter", notes = "Furnace, 20x25x1", every = "3 mons",
            lastCompletedAt = "2026-05-24T09:00:00Z",
        )
        assertEquals(
            "Every 3 months · last done May 24, 2026 · Furnace, 20x25x1",
            RhythmsModel.detailLines(listOf(done), emptyMap(), metaNow, UTC)["a"],
        )
        val never = rhythm(id = "b", title = "Gutters", every = "1 year")
        assertEquals("Every year · never done", RhythmsModel.detailLines(listOf(never), emptyMap(), metaNow, UTC)["b"])
    }

    @Test
    fun `a paused row says only that it is paused`() {
        val off = rhythm(
            id = "p", title = "Trash", satisfiedBy = RhythmShape.Scheduling, every = "7 days", isActive = false,
            currentPeriodStart = "2026-08-19", currentPeriodEnd = "2026-08-27", satisfied = false,
        )
        assertEquals("Every week · paused", RhythmsModel.detailLines(listOf(off), emptyMap(), metaNow, UTC)["p"])
    }

    // ---- the booking period a register row offers ----

    @Test
    fun `an open scheduling period is offered for booking, a settled or paused one is not`() {
        val open = rhythm(
            satisfiedBy = RhythmShape.Scheduling, every = "7 days",
            currentPeriodStart = "2026-08-17", currentPeriodEnd = "2026-08-24", satisfied = false,
        )
        val item = RhythmsModel.openPeriod(open)
        assertEquals("2026-08-17", item?.periodStart)
        assertEquals("2026-08-24", item?.bookableUntil)
        assertNull(RhythmsModel.openPeriod(open.copy(satisfied = true)))
        assertNull(RhythmsModel.openPeriod(open.copy(isActive = false)))
        assertNull(RhythmsModel.openPeriod(rhythm()))
    }
}

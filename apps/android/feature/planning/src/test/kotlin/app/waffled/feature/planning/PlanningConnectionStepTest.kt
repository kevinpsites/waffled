package app.waffled.feature.planning

import app.waffled.core.model.WaffledDates
import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import app.waffled.core.testing.ApiTestHarness
import app.waffled.feature.planning.api.PlanningConnectionApi
import app.waffled.feature.planning.api.PlanningConnectionBoard
import app.waffled.feature.planning.api.PlanningConnectionEvent
import app.waffled.feature.planning.api.PlanningConnectionPairing
import app.waffled.feature.planning.api.PlanningConnectionSlot
import app.waffled.feature.planning.api.PlanningConnectionSlots
import app.waffled.feature.planning.api.PlanningHttp
import app.waffled.feature.planning.steps.PlanningConnectionCopy
import app.waffled.feature.planning.steps.PlanningConnectionModel
import app.waffled.feature.planning.steps.PlanningConnectionRow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import java.time.ZoneId
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

// Weekly Planning · step 5 "Connection". Port of iOS `PlanningConnectionStepTests.swift`:
// the catch-up ladder stops on the credit and gives up rather than looping; exactly one
// chip reads as chosen; "Link a time" writes a pointer only; and the event made for a
// pairing is identified BY DIFFERENCE.

private const val CONNECTION_WEEK = "2026-09-06"
private const val CONNECTION_SESSION = "session-1"

private class ConnectionFeed(var boards: List<PlanningConnectionBoard>) {
    var reads = 0
    var throwOnRead: Int? = null
    val waits = mutableListOf<Duration>()
    val saved = mutableListOf<Map<String, String>>()
    var saveFails = false
    var slotsResult: PlanningConnectionSlots? = null

    fun next(): PlanningConnectionBoard {
        reads += 1
        if (throwOnRead == reads || boards.isEmpty()) error("rejected")
        return boards[minOf(reads - 1, boards.size - 1)]
    }

    fun model() = PlanningConnectionModel(
        fetchBoard = { next() },
        fetchSlots = { _, _ -> slotsResult ?: error("rejected") },
        saveLinks = { _, links ->
            saved += links
            if (saveFails) error("rejected")
        },
        wait = { waits += it },
    )
}

private fun event(id: String, title: String, day: String = "Saturday", minutes: Int? = 120) = PlanningConnectionEvent(
    id = id, title = title, startsAt = "2026-09-12T18:00:00.000Z", endsAt = "2026-09-12T20:00:00.000Z",
    allDay = false, minutes = minutes, day = day, time = "1:00 PM", `when` = "$day 1:00 PM",
)

private fun slot(date: String, startsAt: String? = null) =
    PlanningConnectionSlot(date = date, startsAt = startsAt, kind = "open", afterTitle = null, label = "Sun · free all day")

private fun pairing(
    ids: List<String>,
    who: String,
    already: List<PlanningConnectionEvent> = emptyList(),
    together: List<PlanningConnectionEvent> = emptyList(),
    lastTogetherOn: String? = null,
    slots: List<PlanningConnectionSlot> = emptyList(),
) = PlanningConnectionPairing(ids, who, lastTogetherOn, null, already, together, slots)

private fun board(pairings: List<PlanningConnectionPairing>) = PlanningConnectionBoard(CONNECTION_WEEK, pairings)

class PlanningConnectionDecodingTest {

    private val boardJson = """
    {"weekStart":"2026-09-06","pairings":[
      {"personIds":["kevin","wally"],"who":"Kevin and Wally","lastTogetherOn":null,"lastTogetherTitle":null,
       "alreadyThisWeek":[{"id":"evt-yard","title":"Yard work","startsAt":"2026-09-12T18:00:00.000Z",
         "endsAt":"2026-09-12T20:00:00.000Z","allDay":false,"minutes":120,"day":"Saturday","time":"1:00 PM",
         "when":"Saturday 1:00 PM"}],
       "togetherThisWeek":[],
       "slots":[
         {"date":"2026-09-06","startsAt":null,"kind":"open","afterTitle":null,"label":"Sun · free all day"},
         {"date":"2026-09-09","startsAt":"2026-09-10T00:30:00.000Z","kind":"after","afterTitle":"Scouts","label":"Wed after Scouts"}]},
      {"personIds":["kevin","kelly"],"who":"Kevin and Kelly","lastTogetherOn":"2026-07-23","lastTogetherTitle":"Date night",
       "alreadyThisWeek":[],
       "togetherThisWeek":[{"id":"evt-hales","title":"Dinner at the Hales","startsAt":"2026-09-07T23:00:00.000Z",
         "endsAt":"2026-09-08T01:30:00.000Z","allDay":false,"minutes":150,"day":"Monday","time":"6:00 PM",
         "when":"Monday 6:00 PM"}],
       "slots":[]}]}
    """

    @Test fun `decodes the board the server actually sends`() {
        val decoded = WaffledJson.decodeFromString(PlanningConnectionBoard.serializer(), boardJson)
        assertEquals("2026-09-06", decoded.weekStart)
        assertEquals(2, decoded.pairings.size)
        val kw = decoded.pairings.first()
        assertEquals("Kevin and Wally", kw.who)
        assertEquals("kevin-wally", kw.key)
        assertEquals(listOf("Yard work"), kw.alreadyThisWeek.map { it.title })
        assertEquals(120, kw.alreadyThisWeek.first().minutes)
        assertEquals("Saturday 1:00 PM", kw.alreadyThisWeek.first().`when`)
        assertNull(kw.lastTogetherOn)
    }

    /** `startsAt: null` means the WHOLE DAY IS FREE — not unknown, not malformed. */
    @Test fun `a null slot start means free all day rather than missing`() {
        val slots = WaffledJson.decodeFromString(PlanningConnectionBoard.serializer(), boardJson).pairings.first().slots
        assertEquals(2, slots.size)
        assertNull(slots[0].startsAt)
        assertTrue(slots[0].isFreeAllDay)
        assertEquals("open", slots[0].kind)
        assertFalse(slots[1].isFreeAllDay)
        assertEquals("Scouts", slots[1].afterTitle)
        assertEquals("Wed after Scouts", slots[1].label)
    }

    /** The server's instant carries milliseconds; a strict parser would drop the slot's hour. */
    @Test fun `the slot's instant parses with the app's tolerant parser`() {
        val after = WaffledJson.decodeFromString(PlanningConnectionBoard.serializer(), boardJson).pairings.first().slots.last()
        assertEquals(1_789_000_200L, WaffledDates.parseInstant(after.startsAt, ZoneId.of("UTC"))?.epochSecond)
    }

    @Test fun `decodes the slots read make-a-pairing uses`() {
        val json = """{"weekStart":"2026-09-06","personIds":["kevin","wally","lottie"],"who":"Kevin, Wally and Lottie",
            "slots":[{"date":"2026-09-09","startsAt":"2026-09-10T00:30:00.000Z","kind":"after","afterTitle":"Scouts","label":"Wed after Scouts"}]}"""
        val decoded = WaffledJson.decodeFromString(PlanningConnectionSlots.serializer(), json)
        assertEquals(listOf("kevin", "wally", "lottie"), decoded.personIds)
        assertEquals("Kevin, Wally and Lottie", decoded.who)
        assertEquals("after", decoded.slots.first().kind)
    }
}

class PlanningConnectionApiTest {

    @Test fun `the reads and the links write put the right things on the wire`() = runTest {
        val harness = ApiTestHarness()
        harness.start()
        val api = PlanningConnectionApi(PlanningHttp(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens))
        harness.enqueueJson("""{"weekStart":"2026-09-06","pairings":[]}""")
        harness.enqueueJson("""{"weekStart":"2026-09-06","personIds":["a","b"],"who":"A and B","slots":[]}""")
        harness.enqueueJson("""{"ok":true}""")

        api.board(CONNECTION_WEEK)
        api.slots(CONNECTION_WEEK, listOf("a", "b"))
        api.saveLinks(CONNECTION_SESSION, mapOf("a-b" to "e1"))

        assertEquals("/api/weekly-planning/connection?weekStart=2026-09-06", harness.takeRequest().path)
        assertEquals("/api/weekly-planning/connection/slots?weekStart=2026-09-06&people=a%2Cb", harness.takeRequest().path)
        val put = harness.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals("/api/weekly-planning/connection/links", put.path)
        assertEquals(
            buildJsonObject {
                put("sessionId", CONNECTION_SESSION)
                put("links", buildJsonObject { put("a-b", "e1") })
            },
            Json.parseToJsonElement(put.body.readUtf8()).jsonObject,
        )
        harness.stop()
    }
}

class PlanningConnectionCopyTest {

    @Test fun `the row leads with time that already exists`() {
        val p = pairing(listOf("a", "b"), "Kevin and Wally", already = listOf(event("e1", "Yard work")))
        assertEquals(
            "Saturday’s Yard work is the two of you for 2 hours — that may already be it.",
            PlanningConnectionCopy.sentence(p, null),
        )
    }

    @Test fun `a linked event answers the pairing whatever else the week says`() {
        val p = pairing(
            listOf("a", "b"), "Kevin and Kelly",
            already = listOf(event("e1", "Yard work")),
            together = listOf(event("e2", "Dinner at the Hales", day = "Monday", minutes = 150)),
        )
        assertEquals(
            "Nothing new — Monday’s Dinner at the Hales already is it, and you said so out loud.",
            PlanningConnectionCopy.sentence(p, "e2"),
        )
    }

    @Test fun `a near miss is named and the staleness is dated`() {
        val one = pairing(
            listOf("a", "b"), "Kevin and Kelly",
            together = listOf(event("e2", "Dinner at the Hales", day = "Friday", minutes = null)),
            lastTogetherOn = "2026-08-08",
        )
        assertEquals(
            "Nothing on the calendar with just the two of you since Aug 8. Friday’s Dinner at the Hales is you both, but it’s not that.",
            PlanningConnectionCopy.sentence(one, null),
        )
        val many = pairing(listOf("a", "b"), "Kevin and Kelly", together = listOf(event("e2", "Dinner"), event("e3", "Church")))
        assertEquals(
            "Nothing on the calendar with just the two of you. You’re both at 2 things this week, but none of them is that.",
            PlanningConnectionCopy.sentence(many, null),
        )
        assertEquals(
            "Nothing on the calendar with just the two of you.",
            PlanningConnectionCopy.sentence(pairing(listOf("a", "b"), "Kevin and Lottie"), null),
        )
    }

    @Test fun `the staleness date does not slip west of greenwich`() {
        assertEquals("Aug 8", PlanningConnectionCopy.monthDay("2026-08-08"))
        assertEquals("Jan 1", PlanningConnectionCopy.monthDay("2027-01-01"))
        assertEquals("garbage", PlanningConnectionCopy.monthDay("garbage"))
    }

    @Test fun `the made note names who it was for`() {
        assertEquals("Added to the calendar — Kevin and Lottie", PlanningConnectionCopy.madeNote(listOf("Kevin", "Lottie")))
        assertEquals("Added to the calendar — Kevin, Wally and Lottie", PlanningConnectionCopy.madeNote(listOf("Kevin", "Wally", "Lottie")))
        assertEquals("Added to the calendar", PlanningConnectionCopy.madeNote(emptyList()))
    }

    @Test fun `duration words read like words`() {
        assertEquals("1 hour", PlanningConnectionCopy.durationWords(60))
        assertEquals("2 hours", PlanningConnectionCopy.durationWords(120))
        assertEquals("45 minutes", PlanningConnectionCopy.durationWords(45))
        assertEquals("150 minutes", PlanningConnectionCopy.durationWords(150))
    }

    @Test fun `both on it is every event this week with both of them on it`() {
        val p = pairing(listOf("a", "b"), "Kevin and Kelly", already = listOf(event("e1", "Yard work")), together = listOf(event("e2", "Dinner")))
        assertEquals(listOf("e1", "e2"), PlanningConnectionCopy.bothOnIt(p).map { it.id })
    }

    @Test fun `credited pairings claim their rows first`() {
        val pairings = listOf(
            pairing(listOf("a", "b"), "A and B"),
            pairing(listOf("c", "d"), "C and D"),
            pairing(listOf("e", "f"), "E and F"),
            pairing(listOf("g", "h"), "G and H", already = listOf(event("e1", "Yard work"))),
        )
        assertEquals(listOf("A and B", "C and D", "G and H"), PlanningConnectionCopy.visible(pairings).map { it.who })
    }

    @Test fun `the cap grows when more than three pairings have time on the week`() {
        val credited = (0 until 4).map { i -> pairing(listOf("p$i", "q$i"), "Pair $i", already = listOf(event("e$i", "Dinner"))) }
        val shown = PlanningConnectionCopy.visible(credited + pairing(listOf("x", "y"), "X and Y"))
        assertEquals(4, shown.size)
        assertTrue(shown.all { it.alreadyThisWeek.isNotEmpty() })
    }

    @Test fun `the server's own order survives the cut`() {
        val pairings = listOf(
            pairing(listOf("a", "b"), "A and B"),
            pairing(listOf("c", "d"), "C and D", already = listOf(event("e1", "Dinner"))),
            pairing(listOf("e", "f"), "E and F"),
        )
        assertEquals(listOf("A and B", "C and D", "E and F"), PlanningConnectionCopy.visible(pairings).map { it.who })
    }

    @Test fun `credited counts the whole board`() {
        assertEquals(0, PlanningConnectionCopy.credited(null))
        assertEquals(
            3,
            PlanningConnectionCopy.credited(
                board(
                    listOf(
                        pairing(listOf("a", "b"), "A and B", already = listOf(event("e1", "One"), event("e2", "Two"))),
                        pairing(listOf("c", "d"), "C and D", already = listOf(event("e3", "Three"))),
                    ),
                ),
            ),
        )
    }
}

class PlanningConnectionRowTest {

    @Test fun `with several candidates and no answer no chip stands for anything`() {
        val p = pairing(
            listOf("a", "b"), "Kevin and Wally",
            already = listOf(event("e1", "Yard work"), event("e2", "Drive to practice")),
            together = listOf(event("e3", "Dinner")),
        )
        val row = PlanningConnectionRow.of(p, null)
        assertNull(row.oneTap)
        assertFalse(row.oneTapChosen)
        assertTrue(row.showPicker)
        assertEquals(3, row.candidates.size)
    }

    @Test fun `the one obvious candidate gets a chip that is not yet chosen`() {
        val row = PlanningConnectionRow.of(pairing(listOf("a", "b"), "Kevin and Wally", already = listOf(event("e1", "Yard work"))), null)
        assertEquals("e1", row.oneTap?.id)
        assertFalse(row.oneTapChosen)
        assertFalse(row.showPicker)
    }

    @Test fun `exactly one chip reads as chosen and it names the event`() {
        val p = pairing(
            listOf("a", "b"), "Kevin and Kelly",
            already = listOf(event("e1", "Yard work"), event("e2", "Drive")),
            together = listOf(event("e3", "Dinner at the Hales", day = "Monday")),
        )
        val row = PlanningConnectionRow.of(p, "e3")
        assertEquals("e3", row.answer?.id)
        assertEquals("e3", row.oneTap?.id)
        assertTrue(row.oneTapChosen)
        assertTrue(row.sentence.contains("Dinner at the Hales"))
        assertTrue(row.showPicker)
    }

    @Test fun `a link pointing at nothing on the week leaves the row unanswered`() {
        val row = PlanningConnectionRow.of(pairing(listOf("a", "b"), "Kevin and Kelly", already = listOf(event("e1", "Yard work"))), "gone")
        assertNull(row.answer)
        assertFalse(row.oneTapChosen)
        assertEquals("e1", row.oneTap?.id)
        assertTrue(row.sentence.contains("that may already be it"))
    }

    @Test fun `only two slots fit on a row`() {
        val p = pairing(listOf("a", "b"), "A and B", slots = listOf(slot("2026-09-06"), slot("2026-09-07"), slot("2026-09-08")))
        assertEquals(2, PlanningConnectionRow.of(p, null).slots.size)
    }
}

class PlanningConnectionModelTest {

    @Test fun `a failed read keeps the board and still counts as loaded`() = runTest {
        val feed = ConnectionFeed(listOf(board(listOf(pairing(listOf("a", "b"), "A and B")))))
        val m = feed.model()
        m.load(CONNECTION_WEEK)
        feed.throwOnRead = 2
        m.load(CONNECTION_WEEK)
        assertEquals(1, m.state.value.board?.pairings?.size)
        assertTrue(m.state.value.loaded)
        assertTrue(m.state.value.failed)
    }

    @Test fun `the ladder stops as soon as the credit appears`() = runTest {
        val empty = board(listOf(pairing(listOf("a", "b"), "A and B")))
        val credited = board(listOf(pairing(listOf("a", "b"), "A and B", already = listOf(event("new", "Coffee")))))
        val feed = ConnectionFeed(listOf(empty, empty, empty, credited))
        val m = feed.model()
        m.load(CONNECTION_WEEK)

        m.settleAfterSave(CONNECTION_WEEK, CONNECTION_SESSION, listOf("a", "b"))

        assertEquals(4, feed.reads)
        assertEquals(listOf(250.milliseconds, 500.milliseconds), feed.waits)
        assertEquals("new", m.state.value.rows.first().oneTap?.id)
    }

    @Test fun `the ladder gives up after six reads`() = runTest {
        val feed = ConnectionFeed(listOf(board(listOf(pairing(listOf("a", "b"), "A and B")))))
        val m = feed.model()
        m.load(CONNECTION_WEEK)

        m.settleAfterSave(CONNECTION_WEEK, CONNECTION_SESSION, listOf("a", "b"))

        assertEquals(7, feed.reads)
        assertEquals(listOf(250.milliseconds, 500.milliseconds, 1.seconds, 2.seconds, 3.seconds), feed.waits)
        assertTrue(m.state.value.links.isEmpty())
        assertTrue(feed.saved.isEmpty())
        assertEquals(JsonPrimitive(1), m.state.value.decisionData["added"])
    }

    @Test fun `a failed read stops the ladder rather than retrying`() = runTest {
        val feed = ConnectionFeed(listOf(board(listOf(pairing(listOf("a", "b"), "A and B")))))
        val m = feed.model()
        m.load(CONNECTION_WEEK)
        feed.throwOnRead = 2

        m.settleAfterSave(CONNECTION_WEEK, CONNECTION_SESSION, listOf("a", "b"))

        assertEquals(2, feed.reads)
        assertTrue(feed.waits.isEmpty())
        assertTrue(m.state.value.failed)
        assertEquals(1, m.state.value.board?.pairings?.size)
    }

    @Test fun `the auto link picks the event that appeared`() = runTest {
        val before = board(listOf(pairing(listOf("a", "b"), "A and B", already = listOf(event("old", "Yard work")))))
        val after = board(listOf(pairing(listOf("a", "b"), "A and B", already = listOf(event("old", "Yard work"), event("fresh", "Coffee")))))
        val feed = ConnectionFeed(listOf(before, after))
        val m = feed.model()
        m.load(CONNECTION_WEEK)

        m.settleAfterSave(CONNECTION_WEEK, CONNECTION_SESSION, listOf("a", "b"))

        assertEquals(mapOf("a-b" to "fresh"), m.state.value.links)
        assertEquals(listOf(mapOf("a-b" to "fresh")), feed.saved)
        assertEquals("fresh", m.state.value.rows.first().answer?.id)
        assertTrue(m.state.value.rows.first().oneTapChosen)
    }

    @Test fun `an event for a pairing with no row links nothing`() = runTest {
        val feed = ConnectionFeed(listOf(board(listOf(pairing(listOf("a", "b"), "A and B")))))
        val m = feed.model()
        m.load(CONNECTION_WEEK)

        m.settleAfterSave(CONNECTION_WEEK, CONNECTION_SESSION, listOf("a", "b", "c"))

        assertTrue(m.state.value.links.isEmpty())
        assertTrue(feed.saved.isEmpty())
        assertEquals(JsonPrimitive(1), m.state.value.decisionData["added"])
    }

    @Test fun `making a pairing resets the bar and says what was added`() = runTest {
        val feed = ConnectionFeed(listOf(board(listOf(pairing(listOf("a", "b"), "A and B")))))
        val m = feed.model()
        m.load(CONNECTION_WEEK)
        val before = m.state.value.madeGeneration

        m.settleAfterSave(CONNECTION_WEEK, CONNECTION_SESSION, listOf("a", "b"), listOf("Kevin", "Lottie"))

        assertEquals(before + 1, m.state.value.madeGeneration)
        assertEquals("Added to the calendar — Kevin and Lottie", m.state.value.madeNote)
        m.clearMadeNote()
        assertNull(m.state.value.madeNote)
    }

    @Test fun `linking writes a pointer and picking it again undoes it`() = runTest {
        val feed = ConnectionFeed(
            listOf(board(listOf(pairing(listOf("a", "b"), "A and B", already = listOf(event("e1", "Yard work")), together = listOf(event("e2", "Dinner")))))),
        )
        val m = feed.model()
        m.load(CONNECTION_WEEK)

        m.link("a-b", "e2", CONNECTION_SESSION)
        assertEquals(mapOf("a-b" to "e2"), m.state.value.links)
        assertEquals("e2", m.state.value.rows.first().answer?.id)

        m.link("a-b", "e2", CONNECTION_SESSION)
        assertTrue(m.state.value.links.isEmpty())
        assertNull(m.state.value.rows.first().answer)
        assertEquals(listOf(mapOf("a-b" to "e2"), emptyMap()), feed.saved)
        assertEquals(1, feed.reads)
    }

    @Test fun `a failed link write costs the memory not the sitting`() = runTest {
        val feed = ConnectionFeed(listOf(board(listOf(pairing(listOf("a", "b"), "A and B", already = listOf(event("e1", "Yard work")))))))
        feed.saveFails = true
        val m = feed.model()
        m.load(CONNECTION_WEEK)

        m.link("a-b", "e1", CONNECTION_SESSION)

        assertEquals(mapOf("a-b" to "e1"), m.state.value.links)
        assertEquals(1, feed.saved.size)
    }

    @Test fun `the crumb carries the links so answering the step does not wipe them`() = runTest {
        val feed = ConnectionFeed(listOf(board(listOf(pairing(listOf("a", "b"), "A and B", already = listOf(event("e1", "Yard work")))))))
        val m = feed.model()
        m.load(CONNECTION_WEEK)
        m.link("a-b", "e1", CONNECTION_SESSION)

        assertEquals(
            buildJsonObject {
                put("added", 0)
                put("alreadyCounted", 1)
                put("links", buildJsonObject { put("a-b", "e1") })
            },
            m.state.value.decisionData,
        )
    }

    @Test fun `links are seeded from the step's own row before the read lands`() = runTest {
        val feed = ConnectionFeed(
            listOf(board(listOf(pairing(listOf("a", "b"), "A and B", already = listOf(event("e1", "Yard work"), event("e2", "Drive")))))),
        )
        val m = feed.model()

        m.seedLinks(JsonObject(mapOf("a-b" to JsonPrimitive("e2"), "junk" to JsonPrimitive(3))), CONNECTION_WEEK)
        m.load(CONNECTION_WEEK)

        assertEquals(mapOf("a-b" to "e2"), m.state.value.links)
        assertEquals("e2", m.state.value.rows.first().answer?.id)
        m.seedLinks(JsonObject(mapOf("a-b" to JsonPrimitive("e1"))), CONNECTION_WEEK)
        assertEquals(mapOf("a-b" to "e2"), m.state.value.links)
    }

    @Test fun `stepping to another week does not inherit the first week's links`() = runTest {
        val feed = ConnectionFeed(
            listOf(
                board(listOf(pairing(listOf("a", "b"), "A and B", already = listOf(event("e1", "Yard work"))))),
                board(listOf(pairing(listOf("a", "b"), "A and B", already = listOf(event("e9", "Museum"))))),
            ),
        )
        val m = feed.model()
        m.seedLinks(JsonObject(mapOf("a-b" to JsonPrimitive("e1"))), CONNECTION_WEEK)
        m.load(CONNECTION_WEEK)
        assertEquals(mapOf("a-b" to "e1"), m.state.value.links)

        m.seedLinks(null, "2026-09-13")

        assertTrue(m.state.value.links.isEmpty())
        assertNull(m.state.value.rows.first().answer)
    }

    @Test fun `another week adopts its own links`() = runTest {
        val feed = ConnectionFeed(
            listOf(
                board(listOf(pairing(listOf("a", "b"), "A and B", already = listOf(event("e1", "Yard work"))))),
                board(listOf(pairing(listOf("a", "b"), "A and B", already = listOf(event("e9", "Museum"))))),
            ),
        )
        val m = feed.model()
        m.seedLinks(JsonObject(mapOf("a-b" to JsonPrimitive("e1"))), CONNECTION_WEEK)
        m.load(CONNECTION_WEEK)

        m.seedLinks(JsonObject(mapOf("a-b" to JsonPrimitive("e9"))), "2026-09-13")
        m.load("2026-09-13")

        assertEquals(mapOf("a-b" to "e9"), m.state.value.links)
        assertEquals("e9", m.state.value.rows.first().answer?.id)
    }

    @Test fun `the step draws only the visible rows`() = runTest {
        val feed = ConnectionFeed(listOf(board((0 until 6).map { i -> pairing(listOf("p$i", "q$i"), "Pair $i") })))
        val m = feed.model()
        m.load(CONNECTION_WEEK)
        assertEquals(6, m.state.value.board?.pairings?.size)
        assertEquals(listOf("Pair 0", "Pair 1", "Pair 2"), m.state.value.rows.map { it.who })
    }

    @Test fun `slots for an arbitrary pairing come back or cleanly do not`() = runTest {
        val feed = ConnectionFeed(listOf(board(emptyList())))
        val m = feed.model()
        assertNull(m.slots(CONNECTION_WEEK, listOf("a")))

        feed.slotsResult = PlanningConnectionSlots(CONNECTION_WEEK, listOf("a", "b"), "A and B", listOf(slot("2026-09-06")))
        val result = m.slots(CONNECTION_WEEK, listOf("a", "b"))
        assertEquals("A and B", result?.who)
        assertEquals(true, result?.slots?.first()?.isFreeAllDay)
    }
}

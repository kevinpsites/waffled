package app.waffled.feature.planning

import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import app.waffled.core.testing.ApiTestHarness
import app.waffled.feature.planning.api.HorizonNote
import app.waffled.feature.planning.api.HorizonTag
import app.waffled.feature.planning.api.HorizonView
import app.waffled.feature.planning.api.ParkedTagChange
import app.waffled.feature.planning.api.PlanningHorizonApi
import app.waffled.feature.planning.api.PlanningHttp
import app.waffled.feature.planning.api.PlanningParkedItem
import app.waffled.feature.planning.steps.LooseEndCopy
import app.waffled.feature.planning.steps.PlanningHorizonModel
import app.waffled.feature.planning.steps.PlanningTagChoice
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Weekly Planning · step 3 "Horizon scan". Port of iOS `PlanningHorizonTests.swift`; the
// window arithmetic is asserted in `PlanningSharedLogicTest`. The case that matters most:
// with no `primary` tag, the bar opens on "No tag" rather than on whatever is first.

private const val HORIZON_SESSION = "33333333-3333-4333-8333-333333333333"
private const val PARKED_NOTE_ID = "44444444-4444-4444-8444-444444444444"
private const val OTHER_NOTE_ID = "55555555-5555-4555-8555-555555555555"

class PlanningHorizonDecodingTest {

    @Test fun `decodes the tags and the board`() {
        val json = """
        {"tags":[
            {"stepKey":"connection","label":"Connection","hint":"It’s time with someone"},
            {"stepKey":"goals","label":"Goals","hint":"Somebody’s working on it"},
            {"stepKey":"meals","label":"Meals","hint":"It changes what we eat"},
            {"stepKey":"tasks","label":"Tasks","hint":"Someone owns it this week","primary":true},
            {"stepKey":"kids","label":"Kids","hint":"It’s about one of the kids"}],
         "parked":[
            {"id":"$PARKED_NOTE_ID","note":"Camping — we need to pack","stepKey":"tasks",
             "stepLabel":"Tasks","createdAt":"2026-09-02T18:04:11.000Z"},
            {"id":"$OTHER_NOTE_ID","note":"Something is coming up",
             "stepKey":null,"stepLabel":null,"createdAt":"2026-09-02T18:06:02.000Z"}]}
        """
        val view = WaffledJson.decodeFromString(HorizonView.serializer(), json)
        assertEquals(listOf("connection", "goals", "meals", "tasks", "kids"), view.tags.map { it.stepKey })
        assertEquals(listOf("tasks"), view.tags.filter { it.primary == true }.map { it.stepKey })
        assertNull(view.tags[0].primary)
        assertEquals(2, view.parked.size)
        assertEquals("Tasks", view.parked[0].stepLabel)
        assertNull(view.parked[1].stepKey)
        assertNull(view.parked[1].stepLabel)
    }

    @Test fun `decodes a view with neither key`() {
        val view = WaffledJson.decodeFromString(HorizonView.serializer(), "{}")
        assertTrue(view.tags.isEmpty())
        assertTrue(view.parked.isEmpty())
    }

    @Test fun `the read omits an empty session`() = runTest {
        val harness = ApiTestHarness()
        harness.start()
        val api = PlanningHorizonApi(PlanningHttp(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens))
        harness.enqueueJson("{}")
        harness.enqueueJson("{}")
        api.horizon("")
        api.horizon(HORIZON_SESSION)
        assertEquals("/api/weekly-planning/horizon", harness.takeRequest().path)
        assertEquals("/api/weekly-planning/horizon?sessionId=$HORIZON_SESSION", harness.takeRequest().path)
        harness.stop()
    }
}

private class HorizonFeed(var snapshot: HorizonView) {
    var fetchFails = false
    var parkFails = false
    var updateFails = false
    var fetchCount = 0
    val parkCalls = mutableListOf<Triple<String, String?, String>>()
    val updateCalls = mutableListOf<UpdateCall>()

    data class UpdateCall(val id: String, val note: String?, val tag: ParkedTagChange, val sessionId: String)

    fun model() = PlanningHorizonModel(
        fetchHorizon = {
            fetchCount += 1
            if (fetchFails) error("refused")
            snapshot
        },
        parkNote = { note, stepKey, sessionId ->
            parkCalls += Triple(note, stepKey, sessionId)
            if (parkFails) error("refused")
            PlanningParkedItem(PARKED_NOTE_ID, note, stepKey, "open", sessionId, "2026-09-02T18:04:11.000Z")
        },
        updateNote = { id, note, tag, sessionId ->
            updateCalls += UpdateCall(id, note, tag, sessionId)
            if (updateFails) error("refused")
            // The row the SERVER wrote: an omitted field comes back unchanged.
            val existing = snapshot.parked.firstOrNull { it.id == id }
            PlanningParkedItem(
                id = id,
                note = note ?: existing?.note.orEmpty(),
                stepKey = if (tag is ParkedTagChange.To) tag.stepKey else existing?.stepKey,
                status = "open",
                sessionId = sessionId,
                createdAt = existing?.createdAt ?: "2026-09-02T18:04:11.000Z",
            )
        },
    )
}

private fun tag(key: String, label: String, primary: Boolean? = null) = HorizonTag(key, label, "because", primary)

private val fullTags = listOf(
    tag("connection", "Connection"),
    tag("goals", "Goals"),
    tag("meals", "Meals"),
    tag("tasks", "Tasks", primary = true),
    tag("kids", "Kids"),
)

class PlanningHorizonModelTest {

    @Test fun `the tag starts on the server's primary`() = runTest {
        val m = HorizonFeed(HorizonView(fullTags, emptyList())).model()
        m.load(HORIZON_SESSION)

        assertEquals(PlanningTagChoice.Unset, m.state.value.tagChoice)
        assertEquals("tasks", m.state.value.chosenStepKey)
        assertEquals("Tasks", m.state.value.chosenLabel)

        m.choose(PlanningTagChoice.Step("meals"))
        assertEquals("meals", m.state.value.chosenStepKey)
        assertEquals("Meals", m.state.value.chosenLabel)

        m.choose(PlanningTagChoice.NoTag)
        assertNull(m.state.value.chosenStepKey)
        assertNull(m.state.value.chosenLabel)
    }

    @Test fun `with no primary the bar opens on no tag`() = runTest {
        val m = HorizonFeed(HorizonView(listOf(tag("connection", "Connection"), tag("goals", "Goals")), emptyList())).model()
        m.load(HORIZON_SESSION)
        assertNull(m.state.value.chosenStepKey)
        assertNull(m.state.value.chosenLabel)
    }

    @Test fun `parks with a tag`() = runTest {
        val feed = HorizonFeed(HorizonView(fullTags, emptyList()))
        val m = feed.model()
        m.load(HORIZON_SESSION)
        m.choose(PlanningTagChoice.Step("meals"))

        assertTrue(m.park("  Camping — we need to pack  ", HORIZON_SESSION))

        assertEquals(Triple("Camping — we need to pack", "meals", HORIZON_SESSION), feed.parkCalls.last())
        val s = m.state.value
        assertEquals(1, s.parked.size)
        assertEquals(PARKED_NOTE_ID, s.parked[0].id)
        assertEquals("Meals", s.parked[0].stepLabel)
        assertEquals("2026-09-02T18:04:11.000Z", s.parked[0].createdAt)
        // Reset for the next note in the burst — back to the primary, not to "meals".
        assertEquals(PlanningTagChoice.Unset, s.tagChoice)
        assertEquals("tasks", s.chosenStepKey)
        assertEquals(JsonPrimitive(1), s.decisionData["parked"])
    }

    @Test fun `parks without a tag`() = runTest {
        val feed = HorizonFeed(HorizonView(fullTags, emptyList()))
        val m = feed.model()
        m.load(HORIZON_SESSION)
        m.choose(PlanningTagChoice.NoTag)

        assertTrue(m.park("Something is coming up", HORIZON_SESSION))

        assertEquals(1, feed.parkCalls.size)
        assertNull(feed.parkCalls[0].second)
        assertNull(m.state.value.parked[0].stepKey)
        assertNull(m.state.value.parked[0].stepLabel)
    }

    @Test fun `a refused park changes nothing`() = runTest {
        val feed = HorizonFeed(
            HorizonView(fullTags, listOf(HorizonNote(PARKED_NOTE_ID, "Already here", null, null, "2026-09-02T17:00:00.000Z"))),
        )
        feed.parkFails = true
        val m = feed.model()
        m.load(HORIZON_SESSION)
        m.choose(PlanningTagChoice.Step("kids"))

        assertFalse(m.park("Camping", HORIZON_SESSION))

        val s = m.state.value
        assertEquals(listOf("Already here"), s.parked.map { it.note })
        assertEquals(LooseEndCopy.WRITE_FAILED, s.errorMessage)
        assertFalse(s.parking)
        assertEquals(PlanningTagChoice.Step("kids"), s.tagChoice)
        assertEquals(JsonPrimitive(1), s.decisionData["parked"])
    }

    @Test fun `an empty note never leaves the device`() = runTest {
        val feed = HorizonFeed(HorizonView(fullTags, emptyList()))
        val m = feed.model()
        m.load(HORIZON_SESSION)
        assertFalse(m.park("   ", HORIZON_SESSION))
        assertTrue(feed.parkCalls.isEmpty())
        assertNull(m.state.value.errorMessage)
    }

    @Test fun `a failed refresh keeps the tags and the board`() = runTest {
        val feed = HorizonFeed(HorizonView(fullTags, emptyList()))
        val m = feed.model()
        m.load(HORIZON_SESSION)
        feed.fetchFails = true

        m.load(HORIZON_SESSION)

        assertTrue(m.state.value.loaded)
        assertEquals(5, m.state.value.tags.size)
        assertEquals(2, feed.fetchCount)
    }

    @Test fun `the crumb is counts only`() = runTest {
        val m = HorizonFeed(HorizonView(fullTags, emptyList())).model()
        m.load(HORIZON_SESSION)
        m.recordEventAdded()
        m.recordEventAdded()
        assertTrue(m.park("A note", HORIZON_SESSION))
        assertEquals<Map<String, Any>>(
            mapOf("added" to JsonPrimitive(2), "parked" to JsonPrimitive(1)),
            m.state.value.decisionData,
        )
    }
}

class PlanningParkedNoteEditTest {

    private fun board() = HorizonFeed(
        HorizonView(
            fullTags,
            listOf(
                HorizonNote(PARKED_NOTE_ID, "by the poster bored", "tasks", "Tasks", "2026-09-02T18:04:11.000Z"),
                HorizonNote(OTHER_NOTE_ID, "Something else", null, null, "2026-09-02T18:06:02.000Z"),
            ),
        ),
    )

    @Test fun `rewrites the words and sends nothing else`() = runTest {
        val feed = board()
        val m = feed.model()
        m.load(HORIZON_SESSION)

        assertTrue(m.update(PARKED_NOTE_ID, "buy the poster board", ParkedTagChange.Unchanged, HORIZON_SESSION))

        assertEquals(
            HorizonFeed.UpdateCall(PARKED_NOTE_ID, "buy the poster board", ParkedTagChange.Unchanged, HORIZON_SESSION),
            feed.updateCalls.single(),
        )
        val s = m.state.value
        assertEquals("buy the poster board", s.parked[0].note)
        assertEquals("tasks", s.parked[0].stepKey)
        assertEquals("Tasks", s.parked[0].stepLabel)
        assertEquals(listOf(PARKED_NOTE_ID, OTHER_NOTE_ID), s.parked.map { it.id })
        assertNull(s.errorMessage)
    }

    @Test fun `moves the tag and relabels from the catalog`() = runTest {
        val feed = board()
        val m = feed.model()
        m.load(HORIZON_SESSION)

        assertTrue(m.update(PARKED_NOTE_ID, null, ParkedTagChange.To("meals"), HORIZON_SESSION))

        assertNull(feed.updateCalls[0].note)
        assertEquals(ParkedTagChange.To("meals"), feed.updateCalls[0].tag)
        assertEquals("meals", m.state.value.parked[0].stepKey)
        assertEquals("Meals", m.state.value.parked[0].stepLabel)
        assertEquals("by the poster bored", m.state.value.parked[0].note)
    }

    @Test fun `taking the tag off sends an explicit no tag`() = runTest {
        val feed = board()
        val m = feed.model()
        m.load(HORIZON_SESSION)

        assertTrue(m.update(PARKED_NOTE_ID, null, ParkedTagChange.To(null), HORIZON_SESSION))

        assertEquals(ParkedTagChange.To(null), feed.updateCalls[0].tag)
        assertNull(m.state.value.parked[0].stepKey)
        assertNull(m.state.value.parked[0].stepLabel)
    }

    @Test fun `a refused edit changes nothing`() = runTest {
        val feed = board()
        feed.updateFails = true
        val m = feed.model()
        m.load(HORIZON_SESSION)

        assertFalse(m.update(PARKED_NOTE_ID, "something new", ParkedTagChange.To("meals"), HORIZON_SESSION))

        val s = m.state.value
        assertEquals("by the poster bored", s.parked[0].note)
        assertEquals("tasks", s.parked[0].stepKey)
        assertEquals(LooseEndCopy.WRITE_FAILED, s.errorMessage)
        assertFalse(s.parking)
    }

    @Test fun `an unknown id leaves the board untouched`() = runTest {
        val m = board().model()
        m.load(HORIZON_SESSION)

        assertTrue(m.update("99999999-9999-4999-8999-999999999999", "elsewhere", ParkedTagChange.Unchanged, HORIZON_SESSION))

        assertEquals(listOf("by the poster bored", "Something else"), m.state.value.parked.map { it.note })
    }
}

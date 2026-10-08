package app.waffled.feature.planning

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import app.waffled.core.testing.ApiTestHarness
import app.waffled.feature.chores.ChoreScopePolicy
import app.waffled.feature.chores.ChoresApi
import app.waffled.feature.planning.api.PlanningHttp
import app.waffled.feature.planning.api.PlanningTasksApi
import app.waffled.feature.planning.api.PlanningTasksBoard
import app.waffled.feature.planning.api.PlanningTasksChore
import app.waffled.feature.planning.api.PlanningTasksHandOut
import app.waffled.feature.planning.api.asChoreInstance
import app.waffled.feature.planning.steps.PlanningTaskColumn
import app.waffled.feature.planning.steps.PlanningTaskDrag
import app.waffled.feature.planning.steps.PlanningTasksComposer
import app.waffled.feature.planning.steps.PlanningTasksFormat
import app.waffled.feature.planning.steps.PlanningTasksModel
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Weekly Planning · step 8 (Tasks). Port of iOS `PlanningTasksStepTests.swift`. Two things
// matter most: a reassignment is TWO writes (the chore PATCH plus an assign for EVERY
// pending instance), with an EXPLICIT null on the take-back; and the lent verb reports
// `false` when the composer is cancelled.

private val boardJson = """
{
  "weekStart": "2026-09-06",
  "newTaskDay": "2026-09-06",
  "people": [
    { "id": "p-kevin", "name": "Kevin", "avatarEmoji": null, "colorHex": null,
      "memberType": "adult", "isAdmin": true, "recurringChores": 0, "chores": [] },
    { "id": "p-wally", "name": "Wally", "avatarEmoji": "🐢", "colorHex": "#25A368",
      "memberType": "kid", "isAdmin": false, "recurringChores": 2, "chores": [
        { "id": "c-trash", "title": "Take out the trash", "emoji": "🗑️",
          "rrule": "FREQ=WEEKLY;BYDAY=MO,TH", "cadence": "weekly",
          "days": ["2026-09-07", "2026-09-10"], "dueOn": null, "dueTime": "07:30",
          "carriedOver": false, "rewardAmount": 3, "rewardCurrency": "stars",
          "requiresApproval": true, "requiresPhoto": true,
          "pendingInstanceIds": ["i-trash-mon", "i-trash-thu"] }
      ] },
    { "id": "p-lottie", "name": "Lottie", "avatarEmoji": "🦄", "colorHex": "#7A5AF8",
      "memberType": "kid", "isAdmin": false, "recurringChores": 1, "chores": [
        { "id": "c-library", "title": "Return the library books", "emoji": null,
          "rrule": null, "cadence": "once",
          "days": [], "dueOn": "2026-09-02", "dueTime": null,
          "carriedOver": true, "rewardAmount": 0, "rewardCurrency": null,
          "requiresApproval": false, "requiresPhoto": false,
          "pendingInstanceIds": ["i-library"], "completableInstanceId": "i-library" }
      ] }
  ],
  "unassigned": [
    { "id": "c-sitter", "title": "Book the sitter", "emoji": null,
      "rrule": null, "cadence": "once",
      "days": [], "dueOn": null, "dueTime": null,
      "carriedOver": false, "rewardAmount": 1.5, "rewardCurrency": null,
      "requiresApproval": false, "requiresPhoto": false,
      "pendingInstanceIds": [] }
  ],
  "rhythms": [
    { "id": "r-plants", "title": "Water the plants", "emoji": "🪴", "personId": "p-wally",
      "detail": "Due Wed", "overdue": false, "canComplete": true },
    { "id": "r-dentist", "title": "Book the dentist", "emoji": null, "personId": null,
      "detail": "Not booked yet", "overdue": false, "canComplete": false }
  ]
}
"""

private fun decodedBoard(): PlanningTasksBoard = WaffledJson.decodeFromString(PlanningTasksBoard.serializer(), boardJson)

private fun chore(json: String): PlanningTasksChore = WaffledJson.decodeFromString(PlanningTasksChore.serializer(), json)

private fun card(
    cadence: String,
    days: List<String> = emptyList(),
    dueOn: String? = null,
    dueTime: String? = null,
    carriedOver: Boolean = false,
): PlanningTasksChore = chore(
    """
    { "id": "c-x", "title": "A task", "emoji": null, "rrule": null,
      "cadence": "$cadence", "days": [${days.joinToString(",") { "\"$it\"" }}],
      "dueOn": ${dueOn?.let { "\"$it\"" } ?: "null"},
      "dueTime": ${dueTime?.let { "\"$it\"" } ?: "null"},
      "carriedOver": $carriedOver, "rewardAmount": 0, "rewardCurrency": null,
      "requiresApproval": false, "requiresPhoto": false, "pendingInstanceIds": [] }
    """,
)

private class TasksRejected : Exception("rejected")

private class TasksBoardFeed(var board: PlanningTasksBoard) {
    var fetchFails = false
    var handOutFails = false
    var saveFails: Exception? = null
    var completeFails = false
    var fetchCount = 0
    val handOuts = mutableListOf<Pair<String, String?>>()
    val saves = mutableListOf<Pair<String?, JsonObject>>()
    val completed = mutableListOf<String>()
    val settledRhythms = mutableListOf<String>()
    val settleSessions = mutableListOf<String>()

    fun model() = PlanningTasksModel(
        fetchBoard = {
            fetchCount += 1
            if (fetchFails) throw TasksRejected()
            board
        },
        handOut = { chore, personId ->
            handOuts += chore.id to personId
            if (handOutFails) throw TasksRejected()
        },
        saveChore = { choreId, body ->
            saves += choreId to body
            saveFails?.let { throw it }
        },
        complete = { instanceId ->
            if (completeFails) throw TasksRejected()
            completed += instanceId
        },
        settleRhythm = { id, sessionId ->
            settledRhythms += id
            settleSessions += sessionId
        },
    )
}

private const val WEEK = "2026-09-06"

class PlanningTasksStepTest {

    @Test fun `the week's rhythms decode with whether done applies`() {
        val board = decodedBoard()
        assertEquals(listOf("Water the plants", "Book the dentist"), board.rhythms.map { it.title })
        assertTrue(board.rhythms[0].canComplete)
        assertFalse(board.rhythms[1].canComplete)
    }

    @Test fun `a board from before rhythms still decodes`() {
        val bare = WaffledJson.decodeFromString(
            PlanningTasksBoard.serializer(),
            """{"weekStart":"2026-09-06","newTaskDay":"2026-09-06","people":[],"unassigned":[]}""",
        )
        assertTrue(bare.rhythms.isEmpty())
    }

    @Test fun `settling a rhythm goes through resolve and re-reads`() = runTest {
        val feed = TasksBoardFeed(decodedBoard())
        val model = feed.model()
        model.load(WEEK)
        val reads = feed.fetchCount
        val plants = model.current.board!!.rhythms.first()
        assertTrue(model.settleRhythm(plants, "s-1", WEEK))
        assertEquals(listOf("r-plants"), feed.settledRhythms)
        assertEquals(listOf("s-1"), feed.settleSessions)
        assertEquals(reads + 1, feed.fetchCount)
    }

    @Test fun `a booking rhythm is not settled from here`() = runTest {
        val feed = TasksBoardFeed(decodedBoard())
        val model = feed.model()
        model.load(WEEK)
        assertFalse(model.settleRhythm(model.current.board!!.rhythms.last(), "s-1", WEEK))
        assertTrue(feed.settledRhythms.isEmpty())
    }

    @Test fun `marking done completes the open day and re-reads`() = runTest {
        val feed = TasksBoardFeed(decodedBoard())
        val model = feed.model()
        model.load(WEEK)
        val library = model.current.board!!.people.first { it.id == "p-lottie" }.chores.first()
        assertEquals("i-library", library.completableInstanceId)
        val reads = feed.fetchCount
        assertTrue(model.markDone(library, WEEK))
        assertEquals(listOf("i-library"), feed.completed)
        assertEquals(reads + 1, feed.fetchCount)
        assertNull(model.current.notice)
    }

    @Test fun `an approval task says it is waiting for a parent`() = runTest {
        val feed = TasksBoardFeed(decodedBoard())
        val model = feed.model()
        model.load(WEEK)
        val approval = chore(
            """
            { "id": "c-room", "title": "Tidy the room", "emoji": null, "rrule": null, "cadence": "once",
              "days": [], "dueOn": null, "dueTime": null, "carriedOver": false, "rewardAmount": 0,
              "rewardCurrency": null, "requiresApproval": true, "requiresPhoto": false,
              "pendingInstanceIds": ["i-room"], "completableInstanceId": "i-room" }
            """,
        )
        assertTrue(model.markDone(approval, WEEK))
        assertTrue(model.current.notice?.contains("waiting for a parent") == true)
    }

    @Test fun `nothing due yet writes nothing`() = runTest {
        val feed = TasksBoardFeed(decodedBoard())
        val model = feed.model()
        model.load(WEEK)
        val trash = model.current.board!!.people.first { it.id == "p-wally" }.chores.first()
        assertNull(trash.completableInstanceId)
        assertFalse(model.markDone(trash, WEEK))
        assertTrue(feed.completed.isEmpty())
    }

    @Test fun `a failed complete says so and keeps the board`() = runTest {
        val feed = TasksBoardFeed(decodedBoard())
        val model = feed.model()
        model.load(WEEK)
        val library = model.current.board!!.people.first { it.id == "p-lottie" }.chores.first()
        feed.completeFails = true
        assertFalse(model.markDone(library, WEEK))
        assertNotNull(model.current.errorMessage)
        assertNotNull(model.current.board)
    }

    // ── The two-write hand-out ──

    @Test fun `handing a task over moves the definition and every open instance`() {
        val trash = decodedBoard().people.first { it.name == "Wally" }.chores.first()
        val plan = PlanningTasksHandOut.plan(trash, "p-lottie")
        assertEquals("c-trash", plan.choreId)
        assertEquals(buildJsonObject { put("personId", "p-lottie") }, plan.patch)
        assertEquals(listOf("i-trash-mon", "i-trash-thu"), plan.instanceIds)
        assertEquals("p-lottie", plan.personId)
    }

    @Test fun `taking a task back sends an explicit null rather than omitting the key`() {
        val trash = decodedBoard().people.first { it.name == "Wally" }.chores.first()
        val plan = PlanningTasksHandOut.plan(trash, null)
        assertEquals(setOf("personId"), plan.patch.keys)
        assertEquals(JsonNull, plan.patch["personId"])
        assertEquals(listOf("i-trash-mon", "i-trash-thu"), plan.instanceIds)
        assertNull(plan.personId)
    }

    @Test fun `a task with no open instances is just the patch`() {
        assertTrue(PlanningTasksHandOut.plan(decodedBoard().unassigned.first(), "p-kevin").instanceIds.isEmpty())
    }

    // ── The lent verb ──

    @Test fun `the lent verb reports false when the composer is cancelled`() = runTest {
        val feed = TasksBoardFeed(decodedBoard())
        val model = feed.model()
        model.load(WEEK)
        var reported: Boolean? = null
        model.beginHandoff("book the sitter") { reported = it }
        val composer = model.current.composer as? PlanningTasksComposer.Add ?: error("the handoff didn't open the add composer")
        assertNull(composer.personId)
        assertEquals("book the sitter", composer.note)
        assertNull(reported)
        assertFalse(model.composerDismissed())
        assertEquals(false, reported)
        assertTrue(feed.saves.isEmpty())
    }

    @Test fun `the lent verb reports true only once a task really exists`() = runTest {
        val feed = TasksBoardFeed(decodedBoard())
        val model = feed.model()
        model.load(WEEK)
        var reported: Boolean? = null
        model.beginHandoff("book the sitter") { reported = it }
        val error = model.saveFromComposer(null, buildJsonObject { put("title", "Book the sitter") })
        assertNull(error)
        assertNull(reported, "the sheet is still up — nothing is settled until it closes")
        assertTrue(model.composerDismissed())
        assertEquals(true, reported)
        assertEquals(1, feed.saves.size)
        assertNull(feed.saves.first().first, "a null chore id creates rather than edits")
    }

    @Test fun `a failed save keeps the sheet up and leaves the note unsettled`() = runTest {
        val feed = TasksBoardFeed(decodedBoard()).apply { saveFails = TasksRejected() }
        val model = feed.model()
        model.load(WEEK)
        var reported: Boolean? = null
        model.beginHandoff("book the sitter") { reported = it }
        assertNotNull(model.saveFromComposer(null, JsonObject(emptyMap())))
        assertNull(reported)
        assertFalse(model.composerDismissed())
        assertEquals(false, reported)
    }

    @Test fun `a forbidden save says only a parent can add tasks`() = runTest {
        val feed = TasksBoardFeed(decodedBoard()).apply { saveFails = WaffledApiException(403, "Forbidden") }
        val model = feed.model()
        model.load(WEEK)
        model.openAdd(null)
        assertEquals(
            "Only a parent can add or edit tasks. Switch to a parent to make changes.",
            model.saveFromComposer(null, JsonObject(emptyMap())),
        )
    }

    @Test fun `abandoning the step withdraws an open handoff rather than leaving it waiting`() = runTest {
        val model = TasksBoardFeed(decodedBoard()).model()
        model.load(WEEK)
        var reported: Boolean? = null
        model.beginHandoff("book the sitter") { reported = it }
        model.abandonHandoff()
        assertEquals(false, reported)
    }

    // ── The loading contract ──

    @Test fun `a failed read keeps the board that was already on screen`() = runTest {
        val feed = TasksBoardFeed(decodedBoard())
        val model = feed.model()
        model.load(WEEK)
        feed.fetchFails = true
        model.load(WEEK)
        assertEquals(3, model.current.board?.people?.size)
        assertTrue(model.current.loaded)
    }

    @Test fun `a failed hand-out re-reads the board and tallies nothing`() = runTest {
        val feed = TasksBoardFeed(decodedBoard()).apply { handOutFails = true }
        val model = feed.model()
        model.load(WEEK)
        val sitter = model.current.board!!.unassigned.first()
        assertFalse(model.give(sitter, "p-wally", WEEK))
        assertEquals(1, feed.handOuts.size)
        assertEquals(2, feed.fetchCount)
        assertEquals(0, model.current.assigned)
        assertNotNull(model.current.errorMessage)
        assertFalse(model.current.errorMessage!!.contains("stayed where it was"))
    }

    @Test fun `the tally undoes itself on a take-back so the recap can't over-report`() = runTest {
        val feed = TasksBoardFeed(decodedBoard())
        val model = feed.model()
        model.load(WEEK)
        val sitter = model.current.board!!.unassigned.first()
        assertTrue(model.give(sitter, "p-wally", WEEK))
        assertEquals(1, model.current.assigned)
        assertTrue(model.give(sitter, null, WEEK))
        assertEquals(0, model.current.assigned)
        assertEquals(3, feed.fetchCount)
        assertEquals(listOf("p-wally", null), feed.handOuts.map { it.second })
    }

    // ── Decoding ──

    @Test fun `decodes the board verbatim off the wire`() {
        val board = decodedBoard()
        assertEquals("2026-09-06", board.weekStart)
        assertEquals("2026-09-06", board.newTaskDay)
        assertEquals(listOf("Kevin", "Wally", "Lottie"), board.people.map { it.name })
        assertTrue(board.people[0].isAdmin)
        assertEquals(2, board.people[1].recurringChores)
        val trash = board.people[1].chores.first()
        assertEquals("weekly", trash.cadence)
        assertEquals(listOf("2026-09-07", "2026-09-10"), trash.days)
        assertNull(trash.dueOn)
        assertEquals("07:30", trash.dueTime)
        assertEquals(3.0, trash.rewardAmount)
        assertTrue(trash.requiresApproval)
        assertTrue(trash.requiresPhoto)
        assertEquals(listOf("i-trash-mon", "i-trash-thu"), trash.pendingInstanceIds)
        val library = board.people[2].chores.first()
        assertTrue(library.carriedOver)
        assertEquals("2026-09-02", library.dueOn)
        assertEquals(listOf("Book the sitter"), board.unassigned.map { it.title })
        assertEquals(1.5, board.unassigned[0].rewardAmount)
    }

    // ── The chip ──

    @Test fun `the day chip names what the server said and nothing else`() {
        val board = decodedBoard()
        assertEquals("Mon, Thu 7:30am", PlanningTasksFormat.dayChip(board.people[1].chores.first()))
        assertEquals("Carried over", PlanningTasksFormat.dayChip(board.people[2].chores.first()))
        assertEquals(
            "Every day",
            PlanningTasksFormat.dayChip(
                card(
                    "daily",
                    days = listOf("2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"),
                ),
            ),
        )
        assertEquals("Sep 21", PlanningTasksFormat.dayChip(card("once", dueOn = "2026-09-21")))
        assertEquals("No day set", PlanningTasksFormat.dayChip(card("once")))
        assertEquals("12am", PlanningTasksFormat.shortTime("00:00"))
        assertEquals("12:05pm", PlanningTasksFormat.shortTime("12:05"))
        assertEquals("", PlanningTasksFormat.shortTime(null))
    }

    @Test fun `only a one-off's day can be set from the board`() {
        assertTrue(PlanningTasksFormat.dayIsSettable(card("once")))
        assertFalse(PlanningTasksFormat.dayIsSettable(card("weekly", days = listOf("2026-09-07"))))
        assertTrue(PlanningTasksFormat.dayIsUnset(card("once")))
        assertFalse(PlanningTasksFormat.dayIsUnset(card("once", carriedOver = true)))
    }

    @Test fun `provenance only claims what the chores module can say`() {
        assertEquals("One-off task", PlanningTasksFormat.provenance(card("once")))
        assertEquals("Recurring chore", PlanningTasksFormat.provenance(card("weekly")))
        assertEquals("Left over from before this week", PlanningTasksFormat.provenance(card("once", carriedOver = true)))
    }

    @Test fun `the fairness line is stated rather than scored`() {
        assertEquals("No recurring chores yet", PlanningTasksFormat.carriesLabel(0))
        assertEquals("Carries 1 recurring chore", PlanningTasksFormat.carriesLabel(1))
        assertEquals("Carries 4 recurring chores", PlanningTasksFormat.carriesLabel(4))
    }

    // ── Bridging into the app's own chore editor ──

    @Test fun `a card opens the app's chore editor without losing any setting`() {
        val instance = decodedBoard().people[1].chores.first().asChoreInstance(owner = "p-wally")
        assertEquals("c-trash", instance.choreId)
        assertEquals("Take out the trash", instance.choreTitle)
        assertEquals("p-wally", instance.personId)
        assertEquals(3, instance.rewardAmount)
        assertEquals("stars", instance.rewardCurrency)
        assertEquals("FREQ=WEEKLY;BYDAY=MO,TH", instance.rrule)
        assertEquals("07:30", instance.dueTime)
        assertTrue(instance.requiresApproval)
        assertTrue(instance.requiresPhoto)
    }

    @Test fun `a card in the strip bridges with nobody on it and keeps its day`() {
        val instance = decodedBoard().people[2].chores.first().asChoreInstance(owner = null)
        assertNull(instance.personId)
        assertEquals("2026-09-02", instance.dueOn)
        assertNull(instance.rrule)
        assertEquals(0, instance.rewardAmount)
    }

    @Test fun `a one-off card hands the editor its open day so saving finds it`() {
        val library = decodedBoard().people[2].chores.first().asChoreInstance(owner = null)
        assertEquals("i-library", library.id)
        assertEquals("i-library", ChoreScopePolicy.instanceId(library.id, library.choreId))
    }

    @Test fun `a card with no open day edits the chore itself with no instance`() {
        val board = decodedBoard()
        val trash = board.people[1].chores.first().asChoreInstance(owner = "p-wally")
        val sitter = board.unassigned.first().asChoreInstance(owner = null)
        assertNull(ChoreScopePolicy.instanceId(trash.id, trash.choreId))
        assertNull(ChoreScopePolicy.instanceId(sitter.id, sitter.choreId))
    }

    @Test fun `a fractional reward survives the bridge as a whole number`() {
        assertEquals(2, decodedBoard().unassigned.first().asChoreInstance(owner = null).rewardAmount)
    }

    // ── The crumb ──

    @Test fun `the crumb is counts only`() = runTest {
        val model = TasksBoardFeed(decodedBoard()).model()
        model.load(WEEK)
        val crumb = model.current.crumb
        assertEquals(setOf("assigned", "leftUpForGrabs"), crumb.keys)
        assertEquals(JsonPrimitive(0), crumb["assigned"])
        assertEquals(JsonPrimitive(1), crumb["leftUpForGrabs"])
    }

    // ── Dragging a card onto a person ──

    @Test fun `a drop resolves against the board rather than the gesture that started it`() = runTest {
        val model = TasksBoardFeed(decodedBoard()).model()
        model.load(WEEK)
        assertEquals(PlanningTaskColumn.Person("p-wally"), model.column("c-trash"))
        assertEquals(PlanningTaskColumn.Person("p-lottie"), model.column("c-library"))
        assertEquals(PlanningTaskColumn.UpForGrabs, model.column("c-sitter"))
        assertNull(model.column("c-nowhere"))
    }

    @Test fun `dropping a card on someone hands it over down the same path as tapping a face`() = runTest {
        val feed = TasksBoardFeed(decodedBoard())
        val model = feed.model()
        model.load(WEEK)
        assertTrue(model.drop("c-sitter", PlanningTaskColumn.Person("p-wally"), WEEK))
        assertEquals(listOf<Pair<String, String?>>("c-sitter" to "p-wally"), feed.handOuts)
        assertEquals(1, model.current.assigned)
        assertEquals(2, feed.fetchCount)
    }

    @Test fun `dropping someone's card on the strip puts it back up for grabs`() = runTest {
        val feed = TasksBoardFeed(decodedBoard())
        val model = feed.model()
        model.load(WEEK)
        assertTrue(model.drop("c-trash", PlanningTaskColumn.UpForGrabs, WEEK))
        assertEquals(listOf<String?>(null), feed.handOuts.map { it.second })
        assertEquals(0, model.current.assigned)
    }

    @Test fun `dropping a card back where it already sits writes nothing and tallies nothing`() = runTest {
        val feed = TasksBoardFeed(decodedBoard())
        val model = feed.model()
        model.load(WEEK)
        assertFalse(model.drop("c-trash", PlanningTaskColumn.Person("p-wally"), WEEK))
        assertFalse(model.drop("c-sitter", PlanningTaskColumn.UpForGrabs, WEEK))
        assertTrue(feed.handOuts.isEmpty())
        assertEquals(0, model.current.assigned)
        assertEquals(1, feed.fetchCount)
        assertNull(model.current.errorMessage)
    }

    @Test fun `a card that is no longer on the board is refused without a write`() = runTest {
        val feed = TasksBoardFeed(decodedBoard())
        val model = feed.model()
        model.load(WEEK)
        assertFalse(model.drop("c-gone", PlanningTaskColumn.Person("p-wally"), WEEK))
        assertTrue(feed.handOuts.isEmpty())
        assertEquals(0, model.current.assigned)
    }

    @Test fun `the drag payload is not text so it cannot be dropped into a field`() {
        // A text MIME type would be accepted by every text field in the app.
        assertFalse(PlanningTaskDrag.MIME_TYPE.startsWith("text/"))
        assertEquals("c-trash", PlanningTaskDrag.choreId(PlanningTaskDrag("c-trash")))
        assertNull(PlanningTaskDrag.choreId("c-trash"))
    }
}

/** The hand-out's two writes, on the wire. */
class PlanningTasksApiTest {

    @Test fun `a hand-out patches the chore then assigns every open day`() = runTest {
        val harness = ApiTestHarness()
        harness.start()
        try {
            val client = WaffledHttp.client(harness.tokens, harness.serverAddress)
            val api = PlanningTasksApi(PlanningHttp(client, harness.tokens), ChoresApi(client, harness.tokens))
            repeat(3) { harness.enqueueNoContent() }
            api.handOut(decodedBoard().people[1].chores.first(), null)

            val patch = harness.takeRequest()
            assertEquals("PATCH", patch.method)
            assertEquals("/api/chores/c-trash", patch.path)
            assertEquals(JsonNull, Json.parseToJsonElement(patch.body.readUtf8()).jsonObject["personId"])
            listOf("i-trash-mon", "i-trash-thu").forEach { id ->
                val assign = harness.takeRequest()
                assertEquals("/api/chore-instances/$id/assign", assign.path)
                assertEquals(JsonNull, Json.parseToJsonElement(assign.body.readUtf8()).jsonObject["personId"])
            }
        } finally {
            harness.stop()
        }
    }

    @Test fun `the board read names the planned week`() = runTest {
        val harness = ApiTestHarness()
        harness.start()
        try {
            val client = WaffledHttp.client(harness.tokens, harness.serverAddress)
            val api = PlanningTasksApi(PlanningHttp(client, harness.tokens), ChoresApi(client, harness.tokens))
            harness.enqueueJson("""{"weekStart":"2026-09-06","newTaskDay":"2026-09-06","people":[],"unassigned":[]}""")
            api.board("2026-09-06")
            assertEquals("/api/weekly-planning/tasks?weekStart=2026-09-06", harness.takeRequest().path)
        } finally {
            harness.stop()
        }
    }
}

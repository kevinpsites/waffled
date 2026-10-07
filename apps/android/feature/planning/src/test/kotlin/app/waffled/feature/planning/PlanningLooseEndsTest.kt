package app.waffled.feature.planning

import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import app.waffled.core.testing.ApiTestHarness
import app.waffled.feature.planning.api.LooseEnd
import app.waffled.feature.planning.api.LooseEndCounts
import app.waffled.feature.planning.api.LooseEndDestination
import app.waffled.feature.planning.api.LooseEndDestinations
import app.waffled.feature.planning.api.LooseEndOwner
import app.waffled.feature.planning.api.LooseEndResolution
import app.waffled.feature.planning.api.LooseEndRoute
import app.waffled.feature.planning.api.LooseEndsView
import app.waffled.feature.planning.api.PlanningHttp
import app.waffled.feature.planning.api.PlanningListCandidate
import app.waffled.feature.planning.api.PlanningLooseEndsApi
import app.waffled.feature.planning.steps.LooseEndChoice
import app.waffled.feature.planning.steps.LooseEndCopy
import app.waffled.feature.planning.steps.LooseEndGroup
import app.waffled.feature.planning.steps.PlanningLooseEndsModel
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
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

// Weekly Planning · step 1 "Loose ends". Port of iOS `PlanningLooseEndsTests.swift`. The
// sent-here suite lives in `PlanningSharedLogicTest`, next to `PlanningRouteSeed`.

private const val CHORE_ID = "11111111-1111-4111-8111-111111111111"
private const val NOTE_ID = "22222222-2222-4222-8222-222222222222"
private const val SESSION = "33333333-3333-4333-8333-333333333333"
private const val WEEK = "2026-09-06"

class PlanningLooseEndsDecodingTest {

    @Test fun `decodes the view`() {
        val json = """
        {
          "weekStart": "2026-09-06",
          "notDone": [
            {"key":"chore:$CHORE_ID","kind":"chore","id":"$CHORE_ID","title":"Take the bins out",
             "emoji":"🗑️","detail":"3 days late","actions":["done"]}
          ],
          "parked": [
            {"key":"parked:$NOTE_ID","kind":"parked","id":"$NOTE_ID","title":"Ask about the school trip",
             "emoji":null,"detail":"Parked by Kevin · today","actions":["done","drop"]}
          ],
          "counts": {"notDone":1,"parked":1},
          "destinations": {
            "notDone":[
              {"to":"tasks","label":"Tasks","hint":"Give it an owner and a day","primary":true},
              {"to":"calendar","label":"Calendar","hint":"It needs an appointment slot"}
            ],
            "parked":[
              {"to":"tasks","label":"Make it a task","hint":"Someone owns it this week","primary":true}
            ]
          },
          "routes":[
            {"kind":"chore","id":"$CHORE_ID","title":"Take the bins out","source":"notDone","to":"tasks"}
          ],
          "sources":["chores","lists","rhythms"]
        }
        """
        val view = WaffledJson.decodeFromString(LooseEndsView.serializer(), json)

        assertEquals("2026-09-06", view.weekStart)
        assertEquals(1, view.counts.notDone)
        assertEquals(1, view.counts.parked)
        assertEquals(listOf("chores", "lists", "rhythms"), view.sources)
        assertEquals("chore:$CHORE_ID", view.notDone.first().key)
        assertEquals("3 days late", view.notDone.first().detail)
        assertEquals(listOf("done"), view.notDone.first().actions)
        assertEquals(listOf("done", "drop"), view.parked.first().actions)
        assertNull(view.parked.first().emoji)
        assertEquals("tasks", view.routes.first().to)
        assertEquals("notDone", view.routes.first().source)
        assertNull(view.lists)
    }

    @Test fun `destination primary is absent on all but one`() {
        val json = """
        {"notDone":[
           {"to":"tasks","label":"Tasks","hint":"Give it an owner and a day","primary":true},
           {"to":"calendar","label":"Calendar","hint":"It needs an appointment slot"}],
         "parked":[{"to":"calendar","label":"Put it on the calendar","hint":"A date to look, or a deadline"}]}
        """
        val d = WaffledJson.decodeFromString(LooseEndDestinations.serializer(), json)
        assertEquals(true, d.notDone[0].primary)
        assertNull(d.notDone[1].primary)
        assertNull(d.parked[0].primary)
    }

    @Test fun `decodes an item with no emoji or detail keys`() {
        val json = """{"key":"rhythm:$CHORE_ID","kind":"rhythm","id":"$CHORE_ID","title":"Water the plants","actions":[]}"""
        val item = WaffledJson.decodeFromString(LooseEnd.serializer(), json)
        assertNull(item.emoji)
        assertNull(item.detail)
        assertTrue(item.actions.isEmpty())
    }

    @Test fun `decodes the resolve answer`() {
        val r = WaffledJson.decodeFromString(
            LooseEndResolution.serializer(),
            """{"ok":true,"kind":"parked","id":"$NOTE_ID","action":"drop"}""",
        )
        assertTrue(r.ok)
        assertEquals("parked", r.kind)
        assertEquals(NOTE_ID, r.id)
        assertEquals("drop", r.action)
    }

    @Test fun `decodes the owner with everything needed to paint it`() {
        val json = """
        {"key":"chore:1","kind":"chore","id":"1","title":"Make your bed","emoji":"🛏️",
         "detail":"20 days late","actions":["done"],
         "owner":{"id":"p2","name":"Wally","colorHex":"#25A368","avatarEmoji":"🐢"}}
        """
        val end = WaffledJson.decodeFromString(LooseEnd.serializer(), json)
        assertEquals("Wally", end.owner?.name)
        assertEquals("#25A368", end.owner?.colorHex)
        assertEquals("🐢", end.owner?.avatarEmoji)
    }

    @Test fun `an unowned item and one from an older server both decode as nobody`() {
        val explicit = """{"key":"list:1","kind":"list","id":"1","title":"Return the books","emoji":null,
            "detail":"on Around the house","actions":["done"],"owner":null}"""
        val absent = """{"key":"chore:1","kind":"chore","id":"1","title":"Make your bed","emoji":null,
            "detail":null,"actions":["done"]}"""
        assertNull(WaffledJson.decodeFromString(LooseEnd.serializer(), explicit).owner)
        assertNull(WaffledJson.decodeFromString(LooseEnd.serializer(), absent).owner)
    }
}

class PlanningLooseEndsApiTest {

    private val harness = ApiTestHarness()

    private fun api(): PlanningLooseEndsApi {
        harness.start()
        return PlanningLooseEndsApi(PlanningHttp(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens))
    }

    @Test fun `the read sends the week and the session`() = runTest {
        val api = api()
        harness.enqueueJson("""{"weekStart":"2026-09-06"}""")
        api.looseEnds(WEEK, SESSION)
        assertEquals("/api/weekly-planning/loose-ends?weekStart=2026-09-06&sessionId=$SESSION", harness.takeRequest().path)
        harness.stop()
    }

    /** Undo is an explicit null on the wire: an omitted `to` would read as a malformed route. */
    @Test fun `undoing a route sends an explicit null destination`() = runTest {
        val api = api()
        harness.enqueueJson("""{"routes":[]}""")
        api.route(SESSION, "chore", CHORE_ID, "Bins", "notDone", null)
        val body = Json.parseToJsonElement(harness.takeRequest().body.readUtf8()).jsonObject
        assertEquals(setOf("sessionId", "kind", "id", "title", "source", "to"), body.keys)
        assertEquals(JsonNull, body["to"])
        harness.stop()
    }

    @Test fun `resolving omits an empty session`() = runTest {
        val api = api()
        harness.enqueueJson("""{"ok":true,"kind":"chore","id":"$CHORE_ID","action":"done"}""")
        api.resolve("chore", CHORE_ID, "done", null)
        val body = Json.parseToJsonElement(harness.takeRequest().body.readUtf8()).jsonObject
        assertEquals(setOf("kind", "id", "action"), body.keys)
        harness.stop()
    }
}

class LooseEndChoiceTest {

    private fun item(kind: String, actions: List<String>) =
        LooseEnd(key = "$kind:$CHORE_ID", kind = kind, id = CHORE_ID, title = "Take the bins out", actions = actions)

    private val notDoneDests = listOf(
        LooseEndDestination("tasks", "Tasks", "Give it an owner and a day", primary = true),
        LooseEndDestination("calendar", "Calendar", "It needs an appointment slot"),
    )

    @Test fun `not done keeps its writing answer quiet`() {
        val built = LooseEndChoice.build(item("chore", listOf("done")), LooseEndGroup.NotDone, notDoneDests)
        assertEquals(listOf("to:tasks", "to:calendar"), built.choices.map { it.key })
        assertTrue(built.choices.first().isPrimary)
        assertEquals(listOf("leave", "do:done"), built.quiet.map { it.key })
        assertEquals("Leave it open", built.quiet.first().label)
        assertEquals("It’s done already", built.quiet.last().label)
    }

    @Test fun `parked promotes talk about it and keep it parked`() {
        val dests = listOf(LooseEndDestination("tasks", "Make it a task", "Someone owns it this week", primary = true))
        val built = LooseEndChoice.build(item("parked", listOf("done", "drop")), LooseEndGroup.Parked, dests)
        assertEquals(listOf("to:tasks", "do:done", "leave"), built.choices.map { it.key })
        assertEquals("Talk about it now", built.choices[1].label)
        assertEquals("Keep it parked", built.choices[2].label)
        assertEquals(listOf("do:drop"), built.quiet.map { it.key })
        assertEquals("Drop it", built.quiet.first().label)
    }

    @Test fun `not done names no goals`() {
        assertTrue(LooseEndGroup.NotDone.note.contains("overdue chores, unchecked items on your lists, rhythms past due."))
        assertFalse(LooseEndGroup.NotDone.note.contains("goal", ignoreCase = true))
        assertFalse(LooseEndGroup.NotDone.note.contains("habit", ignoreCase = true))
        assertEquals("Chore", LooseEndCopy.kindLabel("chore"))
        assertEquals("Errand", LooseEndCopy.kindLabel("errand"))
    }

    @Test fun `an item with no actions still routes`() {
        val built = LooseEndChoice.build(item("chore", emptyList()), LooseEndGroup.NotDone, notDoneDests)
        assertEquals(2, built.choices.size)
        assertEquals(listOf("leave"), built.quiet.map { it.key })
    }

    @Test fun `cleared copy names the sources and the other group`() {
        assertEquals(
            "We checked your chores, lists. 1 parked note is still waiting.",
            LooseEndCopy.clearedSubtitle(LooseEndGroup.NotDone, listOf("chores", "lists"), 1),
        )
        assertEquals(
            "We checked your modules. Both groups are clear.",
            LooseEndCopy.clearedSubtitle(LooseEndGroup.NotDone, emptyList(), 0),
        )
        assertTrue(
            LooseEndCopy.clearedSubtitle(LooseEndGroup.Parked, listOf("chores"), 2)
                .endsWith("2 loose ends are still waiting."),
        )
    }
}

private class LooseEndsFeed(var snapshot: LooseEndsView) {
    var fetchFails = false
    var routeFails = false
    var resolveFails = false
    var ruleListFails = false
    var fetchCount = 0
    val routeCalls = mutableListOf<List<String?>>()
    val resolveCalls = mutableListOf<List<String>>()
    val parkCalls = mutableListOf<Pair<String, String>>()
    val listRulings = mutableListOf<Pair<String, Boolean>>()
    var routesAfterWrite: List<LooseEndRoute> = emptyList()

    fun model() = PlanningLooseEndsModel(
        fetchLooseEnds = { _, _ ->
            fetchCount += 1
            if (fetchFails) error("refused")
            snapshot
        },
        routeLooseEnd = { sessionId, kind, id, title, source, to ->
            routeCalls += listOf(sessionId, kind, id, title, source, to)
            if (routeFails) error("refused")
            routesAfterWrite
        },
        resolveLooseEnd = { kind, id, action, sessionId ->
            resolveCalls += listOf(kind, id, action, sessionId)
            if (resolveFails) error("refused")
        },
        ruleList = { id, relevant ->
            listRulings += id to relevant
            if (ruleListFails) error("refused")
        },
        parkNote = { note, sessionId -> parkCalls += note to sessionId },
    )
}

private fun looseEnd(key: String, kind: String, id: String, title: String, actions: List<String>, owner: LooseEndOwner? = null) =
    LooseEnd(key = key, kind = kind, id = id, title = title, actions = actions, owner = owner)

private fun looseEndsView(
    notDone: List<LooseEnd>,
    parked: List<LooseEnd> = emptyList(),
    routes: List<LooseEndRoute> = emptyList(),
    lists: List<PlanningListCandidate>? = null,
) = LooseEndsView(
    weekStart = WEEK,
    notDone = notDone,
    parked = parked,
    counts = LooseEndCounts(notDone.size, parked.size),
    destinations = LooseEndDestinations(
        notDone = listOf(
            LooseEndDestination("tasks", "Tasks", "Give it an owner and a day", primary = true),
            LooseEndDestination("calendar", "Calendar", "It needs an appointment slot"),
        ),
        parked = listOf(
            LooseEndDestination("tasks", "Make it a task", "Someone owns it this week", primary = true),
            LooseEndDestination("meals", "Take it to Meals", "It changes what we eat", stepTitle = "Meals"),
        ),
    ),
    routes = routes,
    sources = listOf("chores", "lists"),
    lists = lists,
)

/** What a route looks like on the step's row — all five keys, defaults included. */
private fun routeJson(kind: String, id: String, title: String, source: String, to: String) = buildJsonObject {
    put("kind", kind)
    put("id", id)
    put("title", title)
    put("source", source)
    put("to", to)
}

class PlanningLooseEndsModelTest {

    private val chore = looseEnd("chore:$CHORE_ID", "chore", CHORE_ID, "Take the bins out", listOf("done"))

    @Test fun `routes then undoes`() = runTest {
        val feed = LooseEndsFeed(looseEndsView(notDone = listOf(chore)))
        val m = feed.model()
        m.load(WEEK, SESSION)
        assertEquals(1, m.state.value.remaining(LooseEndGroup.NotDone))

        val routed = LooseEndRoute("chore", CHORE_ID, "Take the bins out", "notDone", "tasks")
        feed.routesAfterWrite = listOf(routed)
        assertTrue(m.send(chore, LooseEndGroup.NotDone, "tasks", SESSION))

        assertEquals(listOf(SESSION, "chore", CHORE_ID, "Take the bins out", "notDone", "tasks"), feed.routeCalls.last())
        assertEquals(0, m.state.value.remaining(LooseEndGroup.NotDone))
        assertEquals(listOf("Take the bins out"), m.state.value.trail.map { it.title })
        assertEquals(
            JsonArray(listOf(routeJson("chore", CHORE_ID, "Take the bins out", "notDone", "tasks"))),
            m.state.value.decisionData["routes"],
        )
        assertEquals(JsonPrimitive(0), m.state.value.decisionData["left"])

        feed.routesAfterWrite = emptyList()
        assertTrue(m.undo(routed, SESSION))

        assertEquals(2, feed.routeCalls.size)
        assertNull(feed.routeCalls.last()[5])
        assertEquals("chore", feed.routeCalls.last()[1])
        assertEquals(1, m.state.value.remaining(LooseEndGroup.NotDone))
        assertTrue(m.state.value.trail.isEmpty())
        assertEquals(JsonArray(emptyList()), m.state.value.decisionData["routes"])
    }

    @Test fun `seeds routes from the read`() = runTest {
        val routed = LooseEndRoute("chore", CHORE_ID, "Take the bins out", "notDone", "kids")
        val m = LooseEndsFeed(looseEndsView(notDone = listOf(chore), routes = listOf(routed))).model()
        m.load(WEEK, SESSION)
        assertEquals(1, m.state.value.routes.size)
        assertEquals(0, m.state.value.remaining(LooseEndGroup.NotDone))
        assertEquals(1, m.state.value.total(LooseEndGroup.NotDone))
    }

    @Test fun `seeds routes from the step's own data so a failed read cannot wipe them`() = runTest {
        val persisted = JsonArray(listOf(routeJson("chore", CHORE_ID, "Take the bins out", "notDone", "tasks")))
        val feed = LooseEndsFeed(looseEndsView(notDone = listOf(chore)))
        feed.fetchFails = true
        val m = feed.model()

        m.seedRoutes(persisted)
        m.load(WEEK, SESSION)

        assertEquals(1, m.state.value.routes.size)
        assertEquals("tasks", m.state.value.routes[0].to)
        assertEquals("Take the bins out", m.state.value.routes[0].title)
        assertEquals(persisted, m.state.value.decisionData["routes"])
    }

    @Test fun `a successful read overrides the seed`() = runTest {
        val persisted = JsonArray(listOf(routeJson("chore", CHORE_ID, "Stale", "notDone", "kids")))
        val m = LooseEndsFeed(looseEndsView(notDone = listOf(chore))).model()

        m.seedRoutes(persisted)
        assertEquals(1, m.state.value.routes.size)
        m.load(WEEK, SESSION)

        assertTrue(m.state.value.routes.isEmpty())
        m.seedRoutes(JsonPrimitive("nonsense"))
        m.seedRoutes(null)
        assertTrue(m.state.value.routes.isEmpty())
    }

    @Test fun `a refused route leaves the deck alone`() = runTest {
        val feed = LooseEndsFeed(looseEndsView(notDone = listOf(chore)))
        feed.routeFails = true
        val m = feed.model()
        m.load(WEEK, SESSION)

        assertFalse(m.send(chore, LooseEndGroup.NotDone, "tasks", SESSION))

        val s = m.state.value
        assertTrue(s.routes.isEmpty())
        assertEquals(1, s.remaining(LooseEndGroup.NotDone))
        assertTrue(s.trail.isEmpty())
        assertEquals(LooseEndCopy.WRITE_FAILED, s.errorMessage)
        assertFalse(s.working)
    }

    @Test fun `settling writes then reloads`() = runTest {
        val feed = LooseEndsFeed(looseEndsView(notDone = listOf(chore)))
        val m = feed.model()
        m.load(WEEK, SESSION)
        feed.snapshot = looseEndsView(notDone = emptyList())

        assertTrue(m.settle(chore, "done", WEEK, SESSION))

        assertEquals("done", feed.resolveCalls.last()[2])
        assertEquals(SESSION, feed.resolveCalls.last()[3])
        assertEquals(2, feed.fetchCount)
        assertEquals(0, m.state.value.remaining(LooseEndGroup.NotDone))
        assertEquals(JsonPrimitive(1), m.state.value.decisionData["answered"])
    }

    @Test fun `a refused settle does not count or refetch`() = runTest {
        val feed = LooseEndsFeed(looseEndsView(notDone = listOf(chore)))
        feed.resolveFails = true
        val m = feed.model()
        m.load(WEEK, SESSION)

        assertFalse(m.settle(chore, "done", WEEK, SESSION))

        assertEquals(1, feed.fetchCount)
        assertEquals(1, m.state.value.remaining(LooseEndGroup.NotDone))
        assertEquals(JsonPrimitive(0), m.state.value.decisionData["answered"])
        assertEquals(LooseEndCopy.WRITE_FAILED, m.state.value.errorMessage)
    }

    @Test fun `leaving it open touches no endpoint`() = runTest {
        val feed = LooseEndsFeed(looseEndsView(notDone = listOf(chore)))
        val m = feed.model()
        m.load(WEEK, SESSION)

        m.leave(chore)

        assertEquals(0, m.state.value.remaining(LooseEndGroup.NotDone))
        assertTrue(feed.routeCalls.isEmpty())
        assertTrue(feed.resolveCalls.isEmpty())
        m.resetForWeek()
        assertEquals(1, m.state.value.remaining(LooseEndGroup.NotDone))
    }

    @Test fun `parking adds to the board`() = runTest {
        val feed = LooseEndsFeed(looseEndsView(notDone = emptyList()))
        val m = feed.model()
        m.load(WEEK, SESSION)
        feed.snapshot = looseEndsView(
            notDone = emptyList(),
            parked = listOf(looseEnd("parked:$NOTE_ID", "parked", NOTE_ID, "Ask about the school trip", listOf("done", "drop"))),
        )

        assertTrue(m.park("  Ask about the school trip  ", WEEK, SESSION))

        assertEquals("Ask about the school trip", feed.parkCalls.last().first)
        assertEquals(1, m.state.value.remaining(LooseEndGroup.Parked))
        assertFalse(m.park("   ", WEEK, SESSION))
        assertEquals(1, feed.parkCalls.size)
    }

    @Test fun `a failed refresh keeps the last read`() = runTest {
        val feed = LooseEndsFeed(looseEndsView(notDone = listOf(chore)))
        val m = feed.model()
        m.load(WEEK, SESSION)
        feed.fetchFails = true

        m.load(WEEK, SESSION)

        assertTrue(m.state.value.loaded)
        assertEquals(1, m.state.value.remaining(LooseEndGroup.NotDone))
        assertEquals(WEEK, m.state.value.view?.weekStart)
    }

    @Test fun `a first load that fails is still loaded`() = runTest {
        val feed = LooseEndsFeed(looseEndsView(notDone = listOf(chore)))
        feed.fetchFails = true
        val m = feed.model()

        m.load(WEEK, SESSION)

        assertTrue(m.state.value.loaded)
        assertNull(m.state.value.view)
    }

    @Test fun `settling keeps the card away and the count honest`() = runTest {
        val fish = looseEnd("chore:c0", "chore", "c0", "Feed the fish", listOf("done"))
        val feed = LooseEndsFeed(looseEndsView(notDone = listOf(fish, chore)))
        val m = feed.model()
        m.load(WEEK, SESSION)
        assertEquals(2, m.state.value.total(LooseEndGroup.NotDone))

        assertTrue(m.settle(fish, "done", WEEK, SESSION))
        assertEquals(listOf(chore.key), m.state.value.open(LooseEndGroup.NotDone).map { it.key })
        assertEquals(2, m.state.value.total(LooseEndGroup.NotDone))
        assertEquals(1, m.state.value.remaining(LooseEndGroup.NotDone))
    }

    @Test fun `a re-read that reorders the sources keeps the deck order`() = runTest {
        val fish = looseEnd("chore:c0", "chore", "c0", "Feed the fish", listOf("done"))
        val milk = looseEnd("list:l1", "list", "l1", "Milk", listOf("done"))
        val feed = LooseEndsFeed(looseEndsView(notDone = listOf(fish, chore, milk)))
        val m = feed.model()
        m.load(WEEK, SESSION)

        feed.snapshot = looseEndsView(notDone = listOf(milk, chore))
        assertTrue(m.settle(fish, "done", WEEK, SESSION))
        assertEquals(listOf(chore.key, milk.key), m.state.value.open(LooseEndGroup.NotDone).map { it.key })
        assertEquals(3, m.state.value.total(LooseEndGroup.NotDone))
    }

    @Test fun `ruling a list out drops its cards from the count`() = runTest {
        val milk = looseEnd("list:l1", "list", "l1", "Milk", listOf("done"))
        val feed = LooseEndsFeed(looseEndsView(notDone = listOf(chore, milk)))
        val m = feed.model()
        m.load(WEEK, SESSION)
        assertEquals(2, m.state.value.total(LooseEndGroup.NotDone))

        feed.snapshot = looseEndsView(notDone = listOf(chore))
        assertTrue(m.ruleList("l1", false, WEEK, SESSION))
        assertEquals(1, m.state.value.total(LooseEndGroup.NotDone))
    }

    @Test fun `ruling a list out keeps what was already answered`() = runTest {
        val fish = looseEnd("chore:c0", "chore", "c0", "Feed the fish", listOf("done"))
        val milk = looseEnd("list:l1", "list", "l1", "Milk", listOf("done"))
        val feed = LooseEndsFeed(looseEndsView(notDone = listOf(fish, chore, milk)))
        val m = feed.model()
        m.load(WEEK, SESSION)

        feed.snapshot = looseEndsView(notDone = listOf(chore, milk))
        assertTrue(m.settle(fish, "done", WEEK, SESSION))
        feed.snapshot = looseEndsView(notDone = listOf(chore))
        assertTrue(m.ruleList("l1", false, WEEK, SESSION))
        assertEquals(2, m.state.value.total(LooseEndGroup.NotDone))
        assertEquals(1, m.state.value.remaining(LooseEndGroup.NotDone))
    }

    @Test fun `the trail names the step not the verb`() = runTest {
        val m = LooseEndsFeed(looseEndsView(notDone = listOf(chore))).model()
        m.load(WEEK, SESSION)
        assertEquals("Tasks", m.state.value.stepName("tasks"))
        assertEquals("Meals", m.state.value.stepName("meals"))
        assertEquals("familyNight", m.state.value.stepName("familyNight"))
    }

    @Test fun `the trail lists everything sent most recent first`() = runTest {
        val routes = listOf("a", "b", "c", "d").map { LooseEndRoute("chore", it, it, "notDone", "tasks") }
        val m = LooseEndsFeed(looseEndsView(notDone = emptyList(), routes = routes)).model()
        m.load(WEEK, SESSION)
        assertEquals(listOf("d", "c", "b", "a"), m.state.value.trail.map { it.title })
    }

    @Test fun `the model carries the owner to the row`() = runTest {
        val owned = looseEnd("chore:1", "chore", "1", "Make your bed", listOf("done"), LooseEndOwner("p2", "Wally", "#25A368", "🐢"))
        val m = LooseEndsFeed(looseEndsView(notDone = listOf(owned))).model()
        m.load(WEEK, SESSION)
        assertEquals("Wally", m.state.value.open(LooseEndGroup.NotDone).first().owner?.name)
    }
}

class PlanningLooseEndsListChoiceTest {
    private val repairs = PlanningListCandidate("l1", "Repairs", "🔧", true)
    private val someday = PlanningListCandidate("l2", "Someday", "💭", true)

    @Test fun `the candidates come off the step's own read`() = runTest {
        val feed = LooseEndsFeed(looseEndsView(notDone = emptyList(), lists = listOf(repairs, someday)))
        val m = feed.model()
        m.load(WEEK, SESSION)
        assertEquals(listOf("Repairs", "Someday"), m.state.value.listCandidates.map { it.name })
        assertEquals(1, feed.fetchCount)
    }

    @Test fun `ruling one list out sends only that list and re-reads`() = runTest {
        val feed = LooseEndsFeed(looseEndsView(notDone = emptyList(), lists = listOf(repairs, someday)))
        val m = feed.model()
        m.load(WEEK, SESSION)

        assertTrue(m.ruleList("l2", false, WEEK, SESSION))

        assertEquals(listOf("l2" to false), feed.listRulings)
        assertEquals(2, feed.fetchCount)
    }

    @Test fun `a refused ruling says so and changes nothing`() = runTest {
        val feed = LooseEndsFeed(looseEndsView(notDone = emptyList(), lists = listOf(repairs, someday)))
        feed.ruleListFails = true
        val m = feed.model()
        m.load(WEEK, SESSION)

        assertFalse(m.ruleList("l2", false, WEEK, SESSION))

        assertNotNull(m.state.value.errorMessage)
        assertEquals(1, feed.fetchCount)
    }

    @Test fun `no candidates means nothing to choose between`() = runTest {
        val m = LooseEndsFeed(looseEndsView(notDone = emptyList())).model()
        m.load(WEEK, SESSION)
        assertTrue(m.state.value.listCandidates.isEmpty())
    }
}

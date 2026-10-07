package app.waffled.feature.planning

import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import app.waffled.core.testing.ApiTestHarness
import app.waffled.feature.goals.GoalDisplay
import app.waffled.feature.planning.api.PlanningGoalGoal
import app.waffled.feature.planning.api.PlanningGoalsApi
import app.waffled.feature.planning.api.PlanningGoalsCrumb
import app.waffled.feature.planning.api.PlanningGoalsView
import app.waffled.feature.planning.api.asGoalList
import app.waffled.feature.planning.steps.PlanningGoalsStepModel
import app.waffled.feature.planning.steps.PlanningGoalsText
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
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

// Weekly Planning · step 6 — Goals. Port of iOS `PlanningGoalsStepTests.swift`. Three
// invariants a "simplification" would undo: a goal's number comes off `GoalDisplay`, NOT
// `totalProgress`; the crumb mirrors the server's focus map for SETTLED groups only; and a
// failed fetch keeps the last good groups while a failed write mutates nothing.

private object GoalsFixture {

    fun goalJson(
        id: String,
        title: String,
        type: String,
        total: Double,
        target: String = "null",
        habitTarget: String = "null",
        habitPeriod: String = "null",
        periodDone: String = "null",
        stepDone: String = "null",
        stepTotal: String = "null",
        isFeatured: Boolean = false,
        pace: String = "null",
        week: String = "",
    ): String = """
        {"id":"$id","goalListId":"list-family","title":"$title","emoji":"📚",
         "category":"intellectual","goalType":"$type","unit":null,
         "habitPeriod":$habitPeriod,"habitTargetPerPeriod":$habitTarget,
         "trackingMode":"shared","participantMode":null,"targetBasis":null,"deadline":null,
         "isFeatured":$isFeatured,"isSpotlight":false,"target":$target,
         "totalProgress":$total,"periodDone":$periodDone,"stepDone":$stepDone,
         "stepTotal":$stepTotal,"logMethod":"manual","hasRewards":false,
         "milestoneTotal":0,"milestoneReached":0,"streakDays":3,"autoFromCalendar":false,
         "healthMetric":null,"createdAt":"2026-01-01T00:00:00.000Z","participants":[],
         "pace":$pace$week}
    """

    fun json(familyExtra: String? = null): String = """
    {"groups":[
      {"listId":"list-family","name":"Family","emoji":"🏡","colorHex":"#EC6049",
       "isPrivate":false,"sortOrder":0,"isEveryone":true,"settled":true,
       "focusGoalId":"goal-read",
       "members":[
         {"personId":"p-kevin","name":"Kevin Sites","avatarEmoji":"🧔","colorHex":"#2F7FED","age":41},
         {"personId":"p-wally","name":"Wally Sites","avatarEmoji":"🧒","colorHex":"#25A368","age":null}
       ],
       "goals":[
         ${familyExtra?.let { "$it," } ?: ""}
         ${goalJson("goal-read", "Read together", "habit", 340.0, habitTarget = "5",
            habitPeriod = "\"week\"", periodDone = "2", isFeatured = true,
            pace = """{"text":"2 of 5 last week","tone":"behind"}""")},
         ${goalJson("goal-walk", "Walk the loop", "count", 12.0, target = "20",
            pace = """{"text":"3 days logged last week","tone":"ok"}""",
            week = ""","weekTargetable":true,"weekTarget":10,"weekDone":3""")}
       ]},
      {"listId":"list-lottie","name":"Lottie","emoji":"🎀","colorHex":null,
       "isPrivate":false,"sortOrder":1,"isEveryone":false,"settled":true,
       "focusGoalId":null,
       "members":[{"personId":"p-lottie","name":"Lottie Sites","avatarEmoji":"🎀","colorHex":"#E0548B","age":6}],
       "goals":[
         ${goalJson("goal-recital", "Recital practice", "checklist", 99.0, stepDone = "3",
            stepTotal = "4", pace = """{"text":"roughly 1 a month","tone":"flat"}""")}
       ]},
      {"listId":"list-couple","name":"Us","emoji":"💛","colorHex":null,
       "isPrivate":true,"sortOrder":2,"isEveryone":false,"settled":false,
       "focusGoalId":"goal-date",
       "members":[
         {"personId":"p-kevin","name":"Kevin Sites","avatarEmoji":"🧔","colorHex":"#2F7FED","age":41},
         {"personId":"p-kelly","name":"Kelly Sites","avatarEmoji":"👩","colorHex":"#8A5CF0","age":40}
       ],
       "goals":[${goalJson("goal-date", "Date night", "count", 1.0, target = "12", isFeatured = true)}]}
    ]}
    """

    fun decode(text: String): PlanningGoalsView = WaffledJson.decodeFromString(PlanningGoalsView.serializer(), text)

    fun decoded(): PlanningGoalsView = decode(json())

    fun decodedWithNewFamilyGoal(): PlanningGoalsView =
        decode(json(goalJson("goal-sunset", "Sunset walks", "count", 0.0, target = "30", isFeatured = true)))
}

private class Rejected : Exception("rejected")

private class GoalsFeed(var snapshot: PlanningGoalsView) {
    var fetchFails = false
    var writeFails = false
    var createFails = false
    var fetchCount = 0
    val writes = mutableListOf<Pair<String, String?>>()
    val creates = mutableListOf<JsonObject>()
    val weekTargets = mutableListOf<Pair<String, Double?>>()
    var afterCreate: PlanningGoalsView? = null

    fun model() = PlanningGoalsStepModel(
        fetchGoals = {
            fetchCount += 1
            if (fetchFails) throw Rejected()
            snapshot
        },
        setFocus = { _, listId, goalId ->
            writes += listId to goalId
            if (writeFails) throw Rejected()
            snapshot
        },
        createGoal = { body ->
            creates += body
            if (createFails) throw Rejected()
            afterCreate?.let { snapshot = it }
        },
        setWeekTarget = { _, goalId, target ->
            weekTargets += goalId to target
            if (writeFails) throw Rejected()
            snapshot
        },
    )
}

class PlanningGoalsDecodingTest {

    @Test fun `the step's view decodes from the server's own shape`() {
        val view = GoalsFixture.decoded()
        assertEquals(3, view.groups.size)
        val family = view.groups[0]
        assertEquals("list-family", family.listId)
        assertFalse(family.isPrivate)
        assertTrue(family.isEveryone)
        assertTrue(family.settled)
        assertEquals("goal-read", family.focusGoalId)
        assertEquals(0, family.sortOrder)
        assertEquals(2, family.goals.size)
        assertEquals(41, family.members[0].age)
        assertNull(family.members[1].age)
        assertTrue(view.groups[2].isPrivate)
    }

    @Test fun `a habit's number comes off the display axis not its lifetime total`() {
        val read = GoalsFixture.decoded().groups[0].goals[0].goal
        assertEquals("habit", read.goalType)
        assertEquals(340.0, read.totalProgress)
        assertEquals(2.0, GoalDisplay.progress(read))
        assertEquals(5.0, GoalDisplay.target(read))
        assertEquals(0.4, GoalDisplay.fraction(read))
        assertEquals("this week", PlanningGoalsText.axisLabel(read))
    }

    @Test fun `a checklist is measured in steps and a count in its total`() {
        val view = GoalsFixture.decoded()
        val recital = view.groups[1].goals[0].goal
        assertEquals(3.0, GoalDisplay.progress(recital))
        assertEquals(4.0, GoalDisplay.target(recital))
        assertEquals("steps done", PlanningGoalsText.axisLabel(recital))
        val walk = view.groups[0].goals[1].goal
        assertEquals(12.0, GoalDisplay.progress(walk))
        assertEquals(20.0, GoalDisplay.target(walk))
    }

    @Test fun `the pace sentence and its tone arrive with the goal`() {
        val view = GoalsFixture.decoded()
        assertEquals("2 of 5 last week", view.groups[0].goals[0].pace?.text)
        assertEquals("behind", view.groups[0].goals[0].pace?.tone)
        assertEquals("flat", view.groups[1].goals[0].pace?.tone)
        assertNull(view.groups[2].goals[0].pace)
    }
}

class PlanningGoalsCrumbTest {

    @Test fun `the crumb mirrors the server's focus map including its explicit null`() {
        val focus = PlanningGoalsCrumb.decision(GoalsFixture.decoded())["focus"]!!.jsonObject
        assertEquals(JsonPrimitive("goal-read"), focus["list-family"])
        // "Nothing this week" is a REAL answer that must survive as a null.
        assertEquals(JsonNull, focus["list-lottie"])
        assertEquals(2, focus.size)
    }

    @Test fun `an unsettled group's adopted pin is not recorded as an answer`() {
        val focus = PlanningGoalsCrumb.decision(GoalsFixture.decoded())["focus"]!!.jsonObject
        assertFalse("list-couple" in focus)
    }
}

class PlanningGoalsStepModelTest {

    @Test fun `no crumb is offered before a read has landed`() = runTest {
        val feed = GoalsFeed(GoalsFixture.decoded()).apply { fetchFails = true }
        val model = feed.model()
        model.load("session-1")
        assertTrue(model.current.loaded)
        assertNull(model.current.crumb)
    }

    @Test fun `the step skips past a settled group to land on what is left`() = runTest {
        val json = GoalsFixture.json().replace(
            "\"isEveryone\":false,\"settled\":true",
            "\"isEveryone\":false,\"settled\":false",
        )
        val view = GoalsFixture.decode(json)
        val model = GoalsFeed(view).model()
        model.load("session-1")
        assertTrue(view.groups[0].settled)
        assertEquals("list-lottie", model.current.tabId)
    }

    @Test fun `the step opens on the only unsettled group when the others are done`() = runTest {
        val model = GoalsFeed(GoalsFixture.decoded()).model()
        model.load("session-1")
        assertEquals("list-couple", model.current.tabId)
        assertEquals(2, model.current.settledCount)
    }

    @Test fun `a failed read keeps the groups it had and still counts as loaded`() = runTest {
        val feed = GoalsFeed(GoalsFixture.decoded())
        val model = feed.model()
        model.load("session-1")
        feed.fetchFails = true
        model.load("session-1")
        assertEquals(3, model.current.groups.size)
        assertTrue(model.current.loaded)
    }

    @Test fun `nothing this week is sent as a real answer not as a missing one`() = runTest {
        val feed = GoalsFeed(GoalsFixture.decoded())
        val model = feed.model()
        model.load("session-1")
        model.pick("session-1", "list-couple", null)
        assertEquals(listOf<Pair<String, String?>>("list-couple" to null), feed.writes)
    }

    @Test fun `a failed write leaves the last good answer on screen and does not refetch`() = runTest {
        val feed = GoalsFeed(GoalsFixture.decoded())
        val model = feed.model()
        model.load("session-1")
        feed.writeFails = true
        model.pick("session-1", "list-family", "goal-walk")
        assertEquals(1, feed.fetchCount)
        assertNotNull(model.current.errorMessage)
        assertEquals("goal-read", model.current.groups[0].focusGoalId)
        assertFalse(model.current.isFrozen(shellBusy = false))
    }

    @Test fun `the tab the family is standing on survives a write`() = runTest {
        val model = GoalsFeed(GoalsFixture.decoded()).model()
        model.load("session-1")
        model.selectTab("list-family")
        model.pick("session-1", "list-family", "goal-walk")
        assertEquals("list-family", model.current.tabId)
    }

    // The web's default-tab effect once overwrote a quick tap; here the default only fills
    // an EMPTY (or vanished) selection, so a reload after a tap must leave the tap alone.
    @Test fun `a quick tab tap is not reverted by the default tab on the next read`() = runTest {
        val model = GoalsFeed(GoalsFixture.decoded()).model()
        model.load("session-1")
        model.selectTab("list-lottie")
        model.load("session-1")
        assertEquals("list-lottie", model.current.tabId)
        assertEquals("list-lottie", model.current.active?.listId)
    }

    @Test fun `a tap on a tab the step does not have is ignored`() = runTest {
        val model = GoalsFeed(GoalsFixture.decoded()).model()
        model.load("session-1")
        model.selectTab("list-nope")
        assertEquals("list-couple", model.current.tabId)
    }
}

class PlanningGoalsTextTest {

    @Test fun `the group sub-line only ever states facts the server sent`() {
        val view = GoalsFixture.decoded()
        assertEquals("shared · everyone tracks it", PlanningGoalsText.groupSubtitle(view.groups[0]))
        assertEquals("individual · age 6", PlanningGoalsText.groupSubtitle(view.groups[1]))
        assertEquals("private · just the two of you", PlanningGoalsText.groupSubtitle(view.groups[2]))
    }

    @Test fun `the verdict tells already-pinned apart from we-decided`() {
        val view = GoalsFixture.decoded()
        assertEquals("★ This week · Read together", PlanningGoalsText.verdict(view.groups[0]))
        assertEquals("No focus this week — that’s allowed", PlanningGoalsText.verdict(view.groups[1]))
        assertEquals(
            "Pinned already · Date night — keep it, or pick another",
            PlanningGoalsText.verdict(view.groups[2]),
        )
    }
}

class PlanningGoalsNewGoalTest {

    private val editorBody = buildJsonObject {
        put("title", "Sunset walks")
        put("goalListId", JsonNull)
        put("goalType", "count")
        put("isFeatured", true)
        put("targetValue", 30.0)
    }

    private suspend fun makeGoal(model: PlanningGoalsStepModel) {
        model.openNewGoal()
        val target = model.current.newForListId ?: error("the composer refused to open")
        model.submitNewGoal("session-1", target, editorBody)
    }

    @Test fun `the goal is made in the group whose tab is selected`() = runTest {
        val feed = GoalsFeed(GoalsFixture.decoded())
        val model = feed.model()
        model.load("session-1")
        model.selectTab("list-family")
        model.openNewGoal()
        assertEquals("list-family", model.current.newForListId)
        val made = model.submitNewGoal("session-1", "list-family", editorBody)
        assertTrue(made)
        assertEquals(1, feed.creates.size)
        assertEquals(JsonPrimitive("list-family"), feed.creates[0]["goalListId"])
        assertEquals(JsonPrimitive(true), feed.creates[0]["isFeatured"])
        assertEquals(JsonPrimitive("Sunset walks"), feed.creates[0]["title"])
        assertEquals(JsonPrimitive(30.0), feed.creates[0]["targetValue"])
    }

    @Test fun `the group is the only thing the step overrules`() {
        val out = PlanningGoalsStepModel.newGoalBody(
            buildJsonObject {
                put("title", "Sunset walks")
                put("goalListId", "list-lottie")
                put("isFeatured", false)
                put("isSpotlight", true)
                put("participantIds", JsonArray(listOf(JsonPrimitive("p-kevin"))))
            },
            listId = "list-family",
        )
        assertEquals(JsonPrimitive("list-family"), out["goalListId"])
        assertEquals(JsonPrimitive(false), out["isFeatured"])
        assertEquals(JsonPrimitive(true), out["isSpotlight"])
        assertEquals(JsonPrimitive("Sunset walks"), out["title"])
        assertEquals(JsonArray(listOf(JsonPrimitive("p-kevin"))), out["participantIds"])
        assertEquals(5, out.size)
    }

    @Test fun `the new goal shows up in that group's list rather than vanishing`() = runTest {
        val feed = GoalsFeed(GoalsFixture.decoded()).apply { afterCreate = GoalsFixture.decodedWithNewFamilyGoal() }
        val model = feed.model()
        model.load("session-1")
        model.selectTab("list-family")
        makeGoal(model)
        assertEquals(2, feed.fetchCount)
        assertEquals("list-family", model.current.active?.listId)
        assertTrue(model.current.active!!.goals.any { it.goal.id == "goal-sunset" })
        assertNull(model.current.newForListId)
        assertFalse(model.current.creating)
    }

    @Test fun `making a goal is not the same as confirming it for the week`() = runTest {
        val feed = GoalsFeed(GoalsFixture.decoded())
        val model = feed.model()
        model.load("session-1")
        model.selectTab("list-couple")
        makeGoal(model)
        assertEquals(1, feed.creates.size)
        assertTrue(feed.writes.isEmpty())
        assertEquals(false, model.current.groups.first { it.listId == "list-couple" }.settled)
        assertEquals(2, model.current.settledCount)
    }

    @Test fun `a refetch that fails after the goal was saved keeps the last good groups`() = runTest {
        val feed = GoalsFeed(GoalsFixture.decoded())
        val model = feed.model()
        model.load("session-1")
        val revBefore = model.current.rev
        feed.fetchFails = true
        makeGoal(model)
        assertEquals(1, feed.creates.size)
        assertEquals(3, model.current.groups.size)
        assertEquals("goal-read", model.current.groups[0].focusGoalId)
        assertEquals(revBefore, model.current.rev)
        assertNull(model.current.newForListId)
        assertFalse(model.current.creating)
    }

    @Test fun `a create that fails says so and changes nothing`() = runTest {
        val feed = GoalsFeed(GoalsFixture.decoded()).apply { createFails = true }
        val model = feed.model()
        model.load("session-1")
        model.openNewGoal()
        val made = model.submitNewGoal("session-1", "list-couple", editorBody)
        assertFalse(made)
        assertNotNull(model.current.errorMessage)
        assertEquals(1, feed.fetchCount)
        assertNull(model.current.newForListId)
        assertFalse(model.current.isFrozen(shellBusy = false))
    }

    @Test fun `a submit naming a group the step does not have creates nothing`() = runTest {
        val feed = GoalsFeed(GoalsFixture.decoded())
        val model = feed.model()
        model.load("session-1")
        val made = model.submitNewGoal("session-1", "list-that-went-away", editorBody)
        assertFalse(made)
        assertTrue(feed.creates.isEmpty())
        assertFalse(model.current.creating)
    }

    @Test fun `there is nothing to open when the step has no groups`() = runTest {
        val feed = GoalsFeed(GoalsFixture.decoded()).apply { fetchFails = true }
        val model = feed.model()
        model.load("session-1")
        model.openNewGoal()
        assertNull(model.current.newForListId)
        assertNull(model.current.newGoalGroup)
    }

    @Test fun `a manager may add to any group and everyone else only to their own`() {
        val groups = GoalsFixture.decoded().groups
        val (family, lottie, couple) = groups
        for (g in groups) assertTrue(PlanningGoalsStepModel.canTarget(g, canManageGoals = true, personId = "p-lottie"))
        assertTrue(PlanningGoalsStepModel.canTarget(lottie, canManageGoals = false, personId = "p-lottie"))
        assertFalse(PlanningGoalsStepModel.canTarget(family, canManageGoals = false, personId = "p-lottie"))
        assertFalse(PlanningGoalsStepModel.canTarget(couple, canManageGoals = false, personId = "p-kevin"))
        assertFalse(PlanningGoalsStepModel.canTarget(lottie, canManageGoals = false, personId = "p-kevin"))
        assertFalse(PlanningGoalsStepModel.canTarget(lottie, canManageGoals = false, personId = null))
    }

    @Test fun `the group handed to the editor carries its people so participants follow the list`() {
        val list = GoalsFixture.decoded().groups[2].asGoalList()
        assertEquals("list-couple", list.id)
        assertEquals("Us", list.name)
        assertEquals("💛", list.emoji)
        assertEquals(1, list.goalCount)
        assertEquals(listOf("p-kevin", "p-kelly"), list.members.map { it.personId })
        assertEquals("Kelly Sites", list.members[1].name)
        assertEquals("🧔", list.members[0].avatarEmoji)
        assertEquals("#8A5CF0", list.members[1].colorHex)
    }
}

class PlanningGoalsWeekTargetTest {

    private fun goal(id: String): PlanningGoalGoal =
        GoalsFixture.decoded().groups.flatMap { it.goals }.first { it.id == id }

    @Test fun `a count goal carries this week's target and what was logged`() {
        val walk = goal("goal-walk")
        assertTrue(walk.weekTargetable)
        assertEquals(10.0, walk.weekTarget)
        assertEquals(3.0, walk.weekDone)
        assertEquals("3 of 10 this week", PlanningGoalsText.weekLine(walk))
    }

    @Test fun `a habit is not offered one and an older server sends none`() {
        val read = goal("goal-read")
        assertFalse(read.weekTargetable)
        assertNull(read.weekTarget)
        assertEquals(0.0, read.weekDone)
        assertEquals("No target for this week", PlanningGoalsText.weekLine(read))
    }

    @Test fun `the box reads blank as clear and refuses junk`() {
        assertEquals(PlanningGoalsText.TargetEntry.Set(12.0), PlanningGoalsText.parseTarget("12"))
        assertEquals(PlanningGoalsText.TargetEntry.Set(2.5), PlanningGoalsText.parseTarget(" 2.5 "))
        assertEquals(PlanningGoalsText.TargetEntry.Clear, PlanningGoalsText.parseTarget(""))
        assertEquals(PlanningGoalsText.TargetEntry.Invalid, PlanningGoalsText.parseTarget("0"))
        assertEquals(PlanningGoalsText.TargetEntry.Invalid, PlanningGoalsText.parseTarget("ten"))
    }

    @Test fun `setting a target writes it and leaves the focus alone`() = runTest {
        val feed = GoalsFeed(GoalsFixture.decoded())
        val model = feed.model()
        model.load("s-1")
        model.setWeekTarget("s-1", "goal-walk", 12.0)
        assertEquals(listOf<Pair<String, Double?>>("goal-walk" to 12.0), feed.weekTargets)
        assertTrue(feed.writes.isEmpty())
    }

    @Test fun `a cleared target is sent as null`() = runTest {
        val feed = GoalsFeed(GoalsFixture.decoded())
        val model = feed.model()
        model.load("s-1")
        model.setWeekTarget("s-1", "goal-walk", null)
        assertEquals(1, feed.weekTargets.size)
        assertNull(feed.weekTargets.first().second)
    }
}

/** The two writes carry their null on the wire: the server reads it as "nothing" / "clear". */
class PlanningGoalsApiTest {

    private val harness = ApiTestHarness()

    private fun <T> withApi(block: suspend (PlanningGoalsApi) -> T) = runTest {
        harness.start()
        try {
            block(PlanningGoalsApi(goalsHttpFor(harness)))
        } finally {
            harness.stop()
        }
    }

    private fun body(): JsonObject = Json.parseToJsonElement(harness.takeRequest().body.readUtf8()).jsonObject

    @Test fun `the read names the session in the query`() = withApi { api ->
        harness.enqueueJson("""{"groups":[]}""")
        api.goals("s 1")
        assertEquals("/api/weekly-planning/goals?sessionId=s%201", harness.takeRequest().path)
    }

    @Test fun `nothing this week is an explicit null goalId`() = withApi { api ->
        harness.enqueueJson("""{"groups":[]}""")
        api.setFocus("s1", "list-a", null)
        val b = body()
        assertEquals(setOf("sessionId", "listId", "goalId"), b.keys)
        assertEquals(JsonNull, b["goalId"])
    }

    @Test fun `a cleared week target is an explicit null`() = withApi { api ->
        harness.enqueueJson("""{"groups":[]}""")
        api.setWeekTarget("s1", "goal-a", null)
        val b = body()
        assertEquals(JsonNull, b["target"])
        assertEquals(JsonPrimitive("goal-a"), b["goalId"])
    }
}

private fun goalsHttpFor(harness: ApiTestHarness) =
    app.waffled.feature.planning.api.PlanningHttp(WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens)

package app.waffled.feature.planning

import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import app.waffled.core.testing.ApiTestHarness
import app.waffled.feature.goals.GoalDisplay
import app.waffled.feature.planning.api.PlanningKidPick
import app.waffled.feature.planning.api.PlanningKidsApi
import app.waffled.feature.planning.api.PlanningKidsChoice
import app.waffled.feature.planning.api.PlanningKidsCrumb
import app.waffled.feature.planning.api.PlanningKidsView
import app.waffled.feature.planning.steps.KidsQuestion
import app.waffled.feature.planning.steps.PlanningKidsStepModel
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

/**
 * Port of `PlanningKidsStepTests.swift`. Two things matter most: the four-state answer
 * (absent / null / key / text, each a distinct body) and an unsaved typed draft surviving
 * a change of mind.
 */
class PlanningKidsStepTest {

    private object Fx {
        const val SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        const val WEEK = "2026-09-06"
        const val WALLY = "11111111-1111-4111-8111-111111111111"
        const val LOTTIE = "22222222-2222-4222-8222-222222222222"

        const val READ_GOAL = """{"id":"g-read","goalListId":"list-wally","title":"Read together","emoji":"📚",
         "category":"intellectual","goalType":"habit","unit":null,"habitPeriod":"week",
         "habitTargetPerPeriod":5,"trackingMode":"shared","participantMode":null,
         "targetBasis":null,"deadline":null,"isFeatured":false,"isSpotlight":false,
         "target":null,"totalProgress":340,"periodDone":2,"stepDone":null,"stepTotal":null,
         "logMethod":"manual","hasRewards":false,"milestoneTotal":0,"milestoneReached":0,
         "streakDays":4,"autoFromCalendar":false,"healthMetric":null,
         "createdAt":"2026-01-01T00:00:00.000Z","participants":[]}"""

        fun focusSnapshot(key: String): String? = when (key) {
            "goal:g-read" -> """{"source":"goal","id":"g-read","emoji":"📚","label":"Read together","detail":"2 of 5 this week"}"""
            "chore:c-garage" -> """{"source":"chore","id":"c-garage","emoji":"🧹","label":"Sweep the garage","detail":"open since Wednesday"}"""
            "chore:c-homework" -> """{"source":"routine","id":"c-homework","emoji":"🎒","label":"Homework","detail":null}"""
            "chore:c-vacuum" -> """{"source":"routine","id":"c-vacuum","emoji":"🧹","label":"Vacuum the lounge","detail":null}"""
            else -> null
        }

        fun forwardSnapshot(key: String): String? = when (key) {
            "event:e-party" -> """{"eventId":"e-party","emoji":"🎉","label":"Ezra’s party","when":"Sat"}"""
            "event:e-soccer" -> """{"eventId":"e-soccer","emoji":"📅","label":"Soccer practice","when":"Tue"}"""
            else -> null
        }

        fun customFocus(label: String) = """{"source":"custom","id":null,"emoji":"✨","label":"$label","detail":null}"""
        fun customForward(label: String) = """{"eventId":null,"emoji":"✨","label":"$label","when":""}"""

        fun viewJson(
            wallyFocus: String = "null",
            wallyForward: String = "null",
            lottieFocus: String = "null",
            lottieForward: String = "null",
            canRepeat: Boolean = true,
        ) = """
        {"weekStart":"$WEEK",
         "sources":{"goals":true,"chores":true,"rewards":true},
         "canRepeat":$canRepeat,
         "kids":[
          {"personId":"$WALLY","name":"Wally Sites","avatarEmoji":"🧒","colorHex":"#25A368",
           "age":8,"stars":42,"starsSymbol":"⭐",
           "week":[
             {"id":"e-soccer","title":"Soccer practice","when":"Tue 4:00 PM",
              "startsAt":"2026-09-08T16:00:00.000Z","allDay":false},
             {"id":"e-party","title":"Ezra’s party","when":"Sat",
              "startsAt":"2026-09-12T00:00:00.000Z","allDay":true}
           ],
           "chores":[
             {"id":"c-homework","title":"Homework","emoji":"🎒","when":"every day","late":false},
             {"id":"c-garage","title":"Sweep the garage","emoji":"🧹","when":"open since Wednesday","late":true}
           ],
           "focusOptions":[
             {"key":"chore:c-garage","source":"chore","id":"c-garage","emoji":"🧹",
              "label":"Sweep the garage","detail":"open since Wednesday","routed":true,"goal":null},
             {"key":"goal:g-read","source":"goal","id":"g-read","emoji":"📚",
              "label":"Read together","detail":"2 of 5 this week","routed":false,
              "goal":$READ_GOAL},
             {"key":"chore:c-homework","source":"routine","id":"c-homework","emoji":"🎒",
              "label":"Homework","detail":null,"routed":false,"goal":null}
           ],
           "forwardOptions":[
             {"key":"event:e-party","eventId":"e-party","emoji":"🎉","label":"Ezra’s party","when":"Sat"},
             {"key":"event:e-soccer","eventId":"e-soccer","emoji":"📅","label":"Soccer practice","when":"Tue"}
           ],
           "focus":$wallyFocus,"forward":$wallyForward,
           "settled":${wallyFocus != "null" && wallyForward != "null"}},
          {"personId":"$LOTTIE","name":"Lottie Sites","avatarEmoji":"🎀","colorHex":"#E0548B",
           "age":null,"stars":null,"starsSymbol":null,
           "week":[],
           "chores":[
             {"id":"c-vacuum","title":"Vacuum the lounge","emoji":"🧹","when":"Sat","late":false}
           ],
           "focusOptions":[
             {"key":"chore:c-vacuum","source":"routine","id":"c-vacuum","emoji":"🧹",
              "label":"Vacuum the lounge","detail":null,"routed":false,"goal":null}
           ],
           "forwardOptions":[],
           "focus":$lottieFocus,"forward":$lottieForward,
           "settled":${lottieFocus != "null" && lottieForward != "null"}}
         ]}
        """

        fun decoded(
            wallyFocus: String = "null",
            wallyForward: String = "null",
            lottieFocus: String = "null",
            lottieForward: String = "null",
            canRepeat: Boolean = true,
        ): PlanningKidsView = WaffledJson.decodeFromString(
            viewJson(wallyFocus, wallyForward, lottieFocus, lottieForward, canRepeat),
        )
    }

    private class Rejected : Exception()

    private data class Answer(val personId: String, val focus: PlanningKidPick, val forward: PlanningKidPick)

    /** A stand-in server that MERGES the way `answerKid` does, or the draft test proves nothing. */
    private class Feed {
        var wallyFocus = "null"
        var wallyForward = "null"
        var lottieFocus = "null"
        var lottieForward = "null"
        var canRepeat = true
        var fetchFails = false
        var writeFails = false
        var fetchCount = 0
        val answers = mutableListOf<Answer>()
        var repeats = 0

        fun snapshot() = Fx.decoded(wallyFocus, wallyForward, lottieFocus, lottieForward, canRepeat)

        fun merge(personId: String, focus: PlanningKidPick, forward: PlanningKidPick) {
            resolve(focus, Fx::focusSnapshot, Fx::customFocus)?.let {
                if (personId == Fx.WALLY) wallyFocus = it else lottieFocus = it
            }
            resolve(forward, Fx::forwardSnapshot, Fx::customForward)?.let {
                if (personId == Fx.WALLY) wallyForward = it else lottieForward = it
            }
        }

        private fun resolve(pick: PlanningKidPick, snapshot: (String) -> String?, custom: (String) -> String): String? =
            when (pick) {
                PlanningKidPick.Absent -> null
                PlanningKidPick.Clear -> "null"
                is PlanningKidPick.Key -> snapshot(pick.key)
                is PlanningKidPick.Text -> custom(pick.text)
            }

        fun model() = PlanningKidsStepModel(
            fetchKids = { _, _ ->
                fetchCount++
                if (fetchFails) throw Rejected()
                snapshot()
            },
            answerKid = { _, personId, _, focus, forward ->
                answers += Answer(personId, focus, forward)
                if (writeFails) throw Rejected()
                merge(personId, focus, forward)
                snapshot()
            },
            repeatAnswers = { _, _ ->
                repeats++
                if (writeFails) throw Rejected()
                wallyFocus = Fx.focusSnapshot("goal:g-read")!!
                wallyForward = Fx.forwardSnapshot("event:e-party")!!
                snapshot()
            },
        )
    }

    private suspend fun PlanningKidsStepModel.answerWally(
        focus: PlanningKidPick = PlanningKidPick.Absent,
        forward: PlanningKidPick = PlanningKidPick.Absent,
    ) = answer(Fx.SESSION, Fx.WALLY, Fx.WEEK, focus, forward)

    private fun PlanningKidsStepModel.card(personId: String) = state.value.kids.first { it.personId == personId }

    // ---- 1. The four-state answer ----

    private fun body(focus: PlanningKidPick = PlanningKidPick.Absent, forward: PlanningKidPick = PlanningKidPick.Absent) =
        PlanningKidsApi.answerBody(Fx.SESSION, Fx.WALLY, Fx.WEEK, focus, forward)

    @Test fun `absent puts no key in the body at all`() {
        val sent = body(focus = PlanningKidPick.Key("goal:g-read"))
        assertFalse("forward" in sent)
        assertEquals(buildJsonObject { put("key", "goal:g-read") }, sent["focus"])
    }

    @Test fun `clear puts an explicit null in the body`() {
        val sent = body(focus = PlanningKidPick.Clear)
        assertTrue("focus" in sent)
        assertEquals(JsonNull, sent["focus"])
    }

    @Test fun `a picked option is sent as its key`() {
        val sent = body(forward = PlanningKidPick.Key("event:e-party"))
        assertEquals(buildJsonObject { put("key", "event:e-party") }, sent["forward"])
        assertFalse("focus" in sent)
    }

    @Test fun `free text is sent as text, not as a key`() {
        assertEquals(buildJsonObject { put("text", "Be kind to Lottie") }, body(focus = PlanningKidPick.Text("Be kind to Lottie"))["focus"])
    }

    @Test fun `both answers together still send both`() {
        val sent = body(focus = PlanningKidPick.Clear, forward = PlanningKidPick.Text("Grandma’s"))
        assertEquals(JsonNull, sent["focus"])
        assertEquals(buildJsonObject { put("text", "Grandma’s") }, sent["forward"])
    }

    @Test fun `the body always names the session and the person`() {
        val sent = body()
        assertEquals(JsonPrimitive(Fx.SESSION), sent["sessionId"])
        assertEquals(JsonPrimitive(Fx.WALLY), sent["personId"])
        assertEquals(JsonPrimitive(Fx.WEEK), sent["weekStart"])
        assertEquals(3, sent.size)
    }

    @Test fun `an empty weekStart is omitted rather than sent blank`() {
        val sent = PlanningKidsApi.answerBody(Fx.SESSION, Fx.WALLY, "", PlanningKidPick.Absent, PlanningKidPick.Absent)
        assertFalse("weekStart" in sent)
    }

    @Test fun `the four states are four distinct wire values`() {
        assertNull(PlanningKidPick.Absent.wireValue)
        assertEquals(JsonNull, PlanningKidPick.Clear.wireValue)
        assertEquals(buildJsonObject { put("key", "k") }, PlanningKidPick.Key("k").wireValue)
        assertEquals(buildJsonObject { put("text", "t") }, PlanningKidPick.Text("t").wireValue)
    }

    @Test fun `the clearing null actually reaches the wire`() = runTest {
        // `explicitNulls = false` must not swallow a JsonNull inside a JsonObject body.
        val harness = ApiTestHarness().apply { start() }
        try {
            val api = PlanningKidsApi(app.waffled.feature.planning.api.PlanningHttp(
                WaffledHttp.client(harness.tokens, harness.serverAddress), harness.tokens,
            ))
            harness.enqueueJson(Fx.viewJson())
            api.answer(Fx.SESSION, Fx.WALLY, Fx.WEEK, focus = PlanningKidPick.Clear)
            val req = harness.takeRequest()
            assertEquals("PUT", req.method)
            assertEquals("/api/weekly-planning/kids/answer", req.path)
            val sent = Json.parseToJsonElement(req.body.readUtf8()).jsonObject
            assertEquals(JsonNull, sent["focus"])
            assertFalse("forward" in sent)

            harness.enqueueJson(Fx.viewJson())
            api.kids(Fx.SESSION, Fx.WEEK)
            assertEquals("/api/weekly-planning/kids?sessionId=${Fx.SESSION}&weekStart=${Fx.WEEK}", harness.takeRequest().path)

            harness.enqueueJson(Fx.viewJson())
            api.repeat(Fx.SESSION, Fx.WEEK)
            val rep = harness.takeRequest()
            assertEquals("/api/weekly-planning/kids/repeat", rep.path)
            assertEquals("POST", rep.method)
        } finally {
            harness.stop()
        }
    }

    // ---- 2. The unsaved draft ----

    @Test fun `an unsaved typed draft survives changing your mind`() = runTest {
        val feed = Feed()
        val model = feed.model()
        model.load(Fx.SESSION, Fx.WEEK)

        model.beginTyping(Fx.WALLY, KidsQuestion.Focus)
        assertTrue(model.isTyping(Fx.WALLY, KidsQuestion.Focus))
        model.answerWally(focus = PlanningKidPick.Key("goal:g-read"))
        assertFalse(model.isTyping(Fx.WALLY, KidsQuestion.Focus))

        model.recordDraft(Fx.WALLY, KidsQuestion.Focus, "Be kind to Lottie")

        val card = model.card(Fx.WALLY)
        val read = card.focusOptions.first { it.key == "goal:g-read" }
        val homework = card.focusOptions.first { it.key == "chore:c-homework" }
        assertTrue(PlanningKidsChoice.focusChosen(card, read))
        assertFalse(PlanningKidsChoice.focusChosen(card, homework))
        assertFalse(PlanningKidsChoice.focusIsCustom(card))
        assertEquals("Be kind to Lottie", model.typeInSeed(card, KidsQuestion.Focus))
    }

    @Test fun `a draft belongs to one kid and one question`() = runTest {
        val model = Feed().model()
        model.load(Fx.SESSION, Fx.WEEK)
        model.recordDraft(Fx.WALLY, KidsQuestion.Focus, "Be kind to Lottie")

        assertEquals("Be kind to Lottie", model.typeInSeed(model.card(Fx.WALLY), KidsQuestion.Focus))
        assertEquals("", model.typeInSeed(model.card(Fx.WALLY), KidsQuestion.Forward))
        assertEquals("", model.typeInSeed(model.card(Fx.LOTTIE), KidsQuestion.Focus))
    }

    @Test fun `reopening a chosen custom answer shows what they said`() = runTest {
        val model = Feed().model()
        model.load(Fx.SESSION, Fx.WEEK)
        model.answerWally(focus = PlanningKidPick.Text("Be kind to Lottie"))

        val card = model.card(Fx.WALLY)
        assertTrue(PlanningKidsChoice.focusIsCustom(card))
        assertEquals("Be kind to Lottie", card.focus?.label)
        assertTrue(card.focusOptions.none { PlanningKidsChoice.focusChosen(card, it) })
        assertEquals("Be kind to Lottie", model.typeInSeed(card, KidsQuestion.Focus))
    }

    @Test fun `a typed forward answer reads as chosen and names no event`() = runTest {
        val model = Feed().model()
        model.load(Fx.SESSION, Fx.WEEK)
        model.answerWally(forward = PlanningKidPick.Text("Grandma’s"))

        val card = model.card(Fx.WALLY)
        assertTrue(PlanningKidsChoice.forwardIsCustom(card))
        assertTrue(card.forwardOptions.none { PlanningKidsChoice.forwardChosen(card, it) })
    }

    @Test fun `with nothing answered no chip reads as chosen`() = runTest {
        val model = Feed().model()
        model.load(Fx.SESSION, Fx.WEEK)

        val card = model.card(Fx.WALLY)
        assertTrue(card.focusOptions.none { PlanningKidsChoice.focusChosen(card, it) })
        assertTrue(card.forwardOptions.none { PlanningKidsChoice.forwardChosen(card, it) })
        assertFalse(PlanningKidsChoice.focusIsCustom(card))
        assertFalse(PlanningKidsChoice.forwardIsCustom(card))
    }

    // ---- Decoding, and the goal's axis ----

    @Test fun `the cards decode from the server's own shape`() {
        val view = Fx.decoded()
        assertEquals("2026-09-06", view.weekStart)
        assertTrue(view.sources.goals && view.sources.chores && view.sources.rewards)
        assertTrue(view.canRepeat)
        assertEquals(2, view.kids.size)
        val wally = view.kids[0]
        assertEquals("Wally Sites", wally.name)
        assertEquals(8, wally.age)
        assertEquals(42, wally.stars)
        assertEquals(2, wally.week.size)
        assertEquals("Tue 4:00 PM", wally.week[0].`when`)
        assertFalse(wally.week[0].allDay)
        assertTrue(wally.chores[1].late)
        assertFalse(wally.settled)
    }

    @Test fun `a kid with no birthday and no economy drops both rather than showing zero`() {
        val lottie = Fx.decoded().kids[1]
        assertNull(lottie.stars)
        assertNull(lottie.starsSymbol)
        assertNull(lottie.age)
    }

    @Test fun `a goal-sourced option reads this period's count, not its lifetime total`() {
        val read = Fx.decoded().kids[0].focusOptions.first { it.key == "goal:g-read" }
        val goal = assertNotNull(read.goal)
        assertEquals(340.0, goal.totalProgress)
        assertEquals(2.0, GoalDisplay.progress(goal))
        assertEquals(5.0, GoalDisplay.target(goal))
        assertEquals(0.4, GoalDisplay.fraction(goal))
        assertEquals("2 of 5 this week", read.detail)
    }

    @Test fun `a standing chore has no detail line, and that absence is the design`() {
        val wally = Fx.decoded().kids[0]
        val homework = wally.focusOptions.first { it.source == "routine" }
        assertNull(homework.detail)
        assertNull(homework.goal)
        val garage = wally.focusOptions.first { it.key == "chore:c-garage" }
        assertTrue(garage.routed)
        assertEquals("open since Wednesday", garage.detail)
    }

    @Test fun `the crumb mirrors the answers the server stored`() {
        val view = Fx.decoded(
            wallyFocus = Fx.focusSnapshot("goal:g-read")!!,
            wallyForward = Fx.forwardSnapshot("event:e-party")!!,
        )
        val kids = PlanningKidsCrumb.decision(view)["kids"] as JsonObject
        assertEquals(1, kids.size)
        val entry = kids[Fx.WALLY] as JsonObject
        val focus = entry["focus"] as JsonObject
        assertEquals(JsonPrimitive("goal"), focus["source"])
        assertEquals(JsonPrimitive("Read together"), focus["label"])
        assertEquals(JsonPrimitive("g-read"), focus["id"])
        assertEquals(JsonPrimitive("2 of 5 this week"), focus["detail"])
        val forward = entry["forward"] as JsonObject
        assertEquals(JsonPrimitive("e-party"), forward["eventId"])
        assertEquals(JsonPrimitive("Sat"), forward["when"])
    }

    @Test fun `a custom answer is mirrored with explicit nulls the server reads back`() {
        val view = Fx.decoded(wallyFocus = Fx.customFocus("Be kind"))
        val entry = (PlanningKidsCrumb.decision(view)["kids"] as JsonObject)[Fx.WALLY] as JsonObject
        val focus = entry["focus"] as JsonObject
        assertEquals(JsonNull, focus["id"])
        assertEquals(JsonNull, focus["detail"])
        assertEquals(JsonNull, entry["forward"])
    }

    // ---- The model ----

    @Test fun `a failed read keeps the cards it had and still counts as loaded`() = runTest {
        val feed = Feed()
        val model = feed.model()
        model.load(Fx.SESSION, Fx.WEEK)
        feed.fetchFails = true
        model.load(Fx.SESSION, Fx.WEEK)
        assertEquals(2, model.state.value.kids.size)
        assertTrue(model.state.value.loaded)
    }

    @Test fun `no crumb is offered before a read has landed`() = runTest {
        val feed = Feed().apply { fetchFails = true }
        val model = feed.model()
        model.load(Fx.SESSION, Fx.WEEK)
        assertTrue(model.state.value.loaded)
        assertNull(model.state.value.crumb)
    }

    @Test fun `a failed answer leaves the last good one on screen and does not refetch`() = runTest {
        val feed = Feed()
        val model = feed.model()
        model.load(Fx.SESSION, Fx.WEEK)
        model.answerWally(focus = PlanningKidPick.Key("goal:g-read"))
        val rev = model.state.value.rev
        feed.writeFails = true

        model.answerWally(focus = PlanningKidPick.Key("chore:c-homework"))

        assertEquals(1, feed.fetchCount)
        assertNotNull(model.state.value.errorMessage)
        assertEquals("g-read", model.card(Fx.WALLY).focus?.id)
        assertFalse(model.state.value.isFrozen(shellBusy = false))
        assertEquals(rev, model.state.value.rev)
    }

    @Test fun `answering one question does not touch the other`() = runTest {
        val feed = Feed()
        val model = feed.model()
        model.load(Fx.SESSION, Fx.WEEK)
        model.answerWally(forward = PlanningKidPick.Key("event:e-party"))
        model.answerWally(focus = PlanningKidPick.Key("goal:g-read"))

        val card = model.card(Fx.WALLY)
        assertEquals("Read together", card.focus?.label)
        assertEquals("Ezra’s party", card.forward?.label)
        assertTrue(card.settled)
        assertEquals(PlanningKidPick.Absent, feed.answers[1].forward)
    }

    @Test fun `the read-back waits until every card has both answers`() = runTest {
        val model = Feed().model()
        model.load(Fx.SESSION, Fx.WEEK)
        assertFalse(model.state.value.isReadBack)

        model.answerWally(focus = PlanningKidPick.Key("goal:g-read"), forward = PlanningKidPick.Key("event:e-party"))
        assertFalse(model.state.value.isReadBack)

        model.answer(Fx.SESSION, Fx.LOTTIE, Fx.WEEK, PlanningKidPick.Key("chore:c-vacuum"), PlanningKidPick.Text("Baking with Mum"))
        assertTrue(model.state.value.isReadBack)

        model.beginChanging()
        assertFalse(model.state.value.isReadBack)
        model.answerWally(focus = PlanningKidPick.Key("chore:c-homework"))
        assertTrue(model.state.value.isReadBack)
    }

    @Test fun `clearing an answer takes the step back out of its read-back`() = runTest {
        val feed = Feed().apply {
            wallyFocus = Fx.focusSnapshot("goal:g-read")!!
            wallyForward = Fx.forwardSnapshot("event:e-party")!!
            lottieFocus = Fx.focusSnapshot("chore:c-vacuum")!!
            lottieForward = Fx.customForward("Baking with Mum")
        }
        val model = feed.model()
        model.load(Fx.SESSION, Fx.WEEK)
        assertTrue(model.state.value.isReadBack)

        model.answerWally(focus = PlanningKidPick.Clear)

        val card = model.card(Fx.WALLY)
        assertNull(card.focus)
        assertEquals("Ezra’s party", card.forward?.label)
        assertFalse(card.settled)
        assertFalse(model.state.value.isReadBack)
    }

    @Test fun `same as last week is gated on the server saying there is a last week`() = runTest {
        val feed = Feed().apply { canRepeat = false }
        val model = feed.model()
        model.load(Fx.SESSION, Fx.WEEK)
        model.repeatLastWeek(Fx.SESSION, Fx.WEEK)
        assertFalse(model.state.value.canRepeat)
        assertEquals(0, feed.repeats)
    }

    @Test fun `same as last week copies the answers forward`() = runTest {
        val feed = Feed()
        val model = feed.model()
        model.load(Fx.SESSION, Fx.WEEK)
        model.repeatLastWeek(Fx.SESSION, Fx.WEEK)
        assertEquals(1, feed.repeats)
        assertEquals("Read together", model.card(Fx.WALLY).focus?.label)
        assertEquals("Ezra’s party", model.card(Fx.WALLY).forward?.label)
    }

    @Test fun `the heading is the kids' own names, not the catalog's word`() = runTest {
        val model = Feed().model()
        model.load(Fx.SESSION, Fx.WEEK)
        assertEquals("Wally Sites and Lottie Sites", model.state.value.heading)
    }

    @Test fun `the card they are standing at survives a write`() = runTest {
        val model = Feed().model()
        model.load(Fx.SESSION, Fx.WEEK)
        model.select(Fx.LOTTIE)
        model.answer(Fx.SESSION, Fx.LOTTIE, Fx.WEEK, focus = PlanningKidPick.Key("chore:c-vacuum"))
        assertEquals(Fx.LOTTIE, model.state.value.activePersonId)
    }
}

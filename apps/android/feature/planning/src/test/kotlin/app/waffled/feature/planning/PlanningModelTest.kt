package app.waffled.feature.planning

import app.waffled.core.auth.KeyValueStore
import app.waffled.feature.planning.api.PlanningConfigPatch
import app.waffled.feature.planning.api.PlanningListCandidate
import app.waffled.feature.planning.api.PlanningSession
import app.waffled.feature.planning.api.PlanningStep
import app.waffled.feature.planning.api.PlanningStepHandoff
import app.waffled.feature.planning.api.WeeklyPlanningCompletion
import app.waffled.feature.planning.api.WeeklyPlanningConfig
import app.waffled.feature.planning.api.WeeklyPlanningConfigView
import app.waffled.feature.planning.api.WeeklyPlanningView
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Port of `PlanningModelTests.swift`: the shell's model against a fake feed. Locks the
 * loading contract, a crumb that must not follow you onto the next step, and "Leave for
 * now" actually leaving.
 */
class PlanningModelTest {

    private class Rejected : Exception()

    private fun handoff(id: String, note: String) = PlanningStepHandoff(id, note, null)

    private fun step(
        key: String,
        number: Int,
        act: String = "Frame the week",
        title: String? = null,
        requiresModule: String? = null,
        available: Boolean = true,
        status: String = "pending",
        parked: List<PlanningStepHandoff>? = emptyList(),
    ) = PlanningStep(
        key = key,
        number = number,
        title = title ?: key.replaceFirstChar { it.uppercase() },
        ask = "What about $key?",
        primary = "Done",
        act = act,
        requiresModule = requiresModule,
        available = available,
        status = status,
        data = JsonObject(emptyMap()),
        decidedAt = null,
        parked = parked,
    )

    private fun session(
        id: String = "session-1",
        weekStart: String = "2026-09-06",
        status: String = "active",
        currentStep: String? = "looseEnds",
        completedAt: String? = null,
    ) = PlanningSession(
        id = id,
        weekStart = weekStart,
        status = status,
        currentStep = currentStep,
        driverPersonId = null,
        startedAt = "2026-09-06T17:00:00.000Z",
        completedAt = completedAt,
    )

    private fun defaultSteps() = listOf(
        step("looseEnds", 1, act = "Intake"),
        step("calendar", 2, act = "Frame the week"),
        step("meals", 3, act = "Run the household", requiresModule = "meals", available = false),
        step("recap", 4, act = "Close"),
    )

    private data class Decision(val sessionId: String, val stepKey: String, val status: String, val data: JsonObject?)
    private data class Patch(val id: String, val currentStep: String?, val status: String?)
    private data class Resolve(val kind: String, val id: String, val action: String, val sessionId: String?)
    private data class Park(val note: String, val stepKey: String?, val sessionId: String?)

    private inner class Feed(var currentSession: PlanningSession? = null) {
        var steps: List<PlanningStep> = defaultSteps()
        var weekStart = "2026-09-06"
        var defaultWeekStart = "2026-09-06"
        var minWeekStart = "2026-08-30"
        var config = WeeklyPlanningConfig(dayOfWeek = 0, time = "17:00", steps = emptyMap(), showOnToday = true)

        var fetchFails = false
        var decideFails = false
        var sessionsByWeek: Map<String, PlanningSession>? = null
        var holdDefaultFetch = false
        var held: CompletableDeferred<Unit>? = null
        var parkFails = false

        var fetchCount = 0
        val fetchedWeeks = mutableListOf<String?>()
        val starts = mutableListOf<String?>()
        val patches = mutableListOf<Patch>()
        val decisions = mutableListOf<Decision>()
        val completes = mutableListOf<String>()
        val discards = mutableListOf<String>()
        val resolves = mutableListOf<Resolve>()
        val parks = mutableListOf<Park>()
        val configSaves = mutableListOf<PlanningConfigPatch>()
        val listCandidates = listOf(
            PlanningListCandidate("l1", "Repairs", "🔧", true),
            PlanningListCandidate("l2", "Someday", "💭", true),
        )

        fun snapshot(week: String?): WeeklyPlanningView {
            val byWeek = sessionsByWeek
                ?: return WeeklyPlanningView(config, weekStart, defaultWeekStart, minWeekStart, currentSession, steps)
            val start = week ?: defaultWeekStart
            return WeeklyPlanningView(config, start, defaultWeekStart, minWeekStart, byWeek[start], steps)
        }

        fun setStatus(key: String, status: String) {
            steps = steps.map { if (it.key == key) it.copy(status = status, decidedAt = "2026-09-06T17:05:00.000Z") else it }
        }
    }

    private class MemoryStore : KeyValueStore {
        val values = mutableMapOf<String, String>()
        override fun getString(key: String): String? = values[key]
        override fun putString(key: String, value: String) { values[key] = value }
        override fun remove(key: String) { values.remove(key) }
    }

    private fun makeModel(feed: Feed, store: KeyValueStore = MemoryStore()) = PlanningModel(
        fetchView = { week ->
            feed.fetchCount++
            feed.fetchedWeeks += week
            if (feed.fetchFails) throw Rejected()
            if (feed.holdDefaultFetch && week == null) {
                feed.holdDefaultFetch = false
                val gate = CompletableDeferred<Unit>()
                feed.held = gate
                gate.await()
            }
            feed.snapshot(week)
        },
        fetchConfig = { WeeklyPlanningConfigView(feed.config, emptyList(), feed.listCandidates) },
        saveConfig = { patch ->
            feed.configSaves += patch
            feed.config
        },
        startSession = { week ->
            feed.starts += week
            val started = session(weekStart = week ?: feed.defaultWeekStart)
            feed.currentSession = started
            started
        },
        patchSession = { id, currentStep, status ->
            feed.patches += Patch(id, currentStep, status)
            val updated = session(
                id = id,
                weekStart = feed.weekStart,
                status = status ?: feed.currentSession?.status ?: "active",
                currentStep = currentStep ?: feed.currentSession?.currentStep,
                completedAt = feed.currentSession?.completedAt,
            )
            feed.currentSession = updated
            updated
        },
        decideStep = { sessionId, stepKey, status, data ->
            feed.decisions += Decision(sessionId, stepKey, status, data)
            if (feed.decideFails) throw Rejected()
            feed.setStatus(stepKey, status)
            feed.steps
        },
        completeSession = { id ->
            feed.completes += id
            val done = session(
                id = id, weekStart = feed.weekStart, status = "completed",
                currentStep = feed.currentSession?.currentStep,
                completedAt = "2026-09-06T17:32:00.000Z",
            )
            feed.currentSession = done
            WeeklyPlanningCompletion(done, feed.steps)
        },
        discardSession = { id ->
            feed.discards += id
            feed.currentSession = null
        },
        resolveLooseEnd = { kind, id, action, sessionId -> feed.resolves += Resolve(kind, id, action, sessionId) },
        parkNote = { note, stepKey, sessionId ->
            if (feed.parkFails) throw Rejected()
            feed.parks += Park(note, stepKey, sessionId)
        },
        store = store,
    )

    private val PlanningModel.s get() = state.value
    private val crumb = buildJsonObject { put("autofilled", 3) }

    // ---- loading ----

    @Test fun `failed refresh keeps the last good view and stays loaded`() = runTest {
        val feed = Feed(session())
        val model = makeModel(feed)
        model.load()
        assertEquals(3, model.s.runnable.size)

        feed.fetchFails = true
        model.load()

        assertTrue(model.s.loaded)
        assertEquals(3, model.s.runnable.size)
        assertEquals("2026-09-06", model.s.view?.weekStart)
    }

    @Test fun `a first fetch that fails still counts as loaded`() = runTest {
        val feed = Feed().apply { fetchFails = true }
        val model = makeModel(feed)
        model.load()
        assertTrue(model.s.loaded)
        assertNull(model.s.view)
    }

    @Test fun `the counter skips a step whose module is off`() = runTest {
        val model = makeModel(Feed(session()))
        model.load()
        assertEquals(1, model.s.stepNumbers["looseEnds"])
        assertEquals(2, model.s.stepNumbers["calendar"])
        assertNull(model.s.stepNumbers["meals"])
        assertEquals(3, model.s.stepNumbers["recap"])
        assertEquals(3, model.s.runnable.size)
    }

    @Test fun `acts group in catalog order`() = runTest {
        val model = makeModel(Feed(session()))
        model.load()
        assertEquals(listOf("Intake", "Frame the week", "Close"), model.s.actGroups.map { it.act })
    }

    // ---- starting ----

    @Test fun `starting asks for the week on screen and lands on the session pointer`() = runTest {
        val feed = Feed()
        val model = makeModel(feed)
        model.load()

        model.start()

        assertEquals(listOf<String?>("2026-09-06"), feed.starts)
        assertEquals("looseEnds", model.s.askedStep)
        assertEquals("session-1", model.s.session?.id)
    }

    // ---- answering ----

    @Test fun `answering sends the crumb then moves the session pointer on`() = runTest {
        val feed = Feed(session())
        val model = makeModel(feed)
        model.load()
        model.setDecisionData(crumb)

        model.answer("done")

        assertEquals(1, feed.decisions.size)
        val decision = feed.decisions.first()
        assertEquals("session-1", decision.sessionId)
        assertEquals("looseEnds", decision.stepKey)
        assertEquals("done", decision.status)
        assertEquals(crumb, decision.data)

        val patch = assertNotNull(feed.patches.firstOrNull())
        assertEquals("calendar", patch.currentStep)
        assertNull(patch.status)
        assertEquals("calendar", model.s.askedStep)
        assertTrue(feed.completes.isEmpty())
    }

    @Test fun `skipping is a real answer`() = runTest {
        val feed = Feed(session())
        val model = makeModel(feed)
        model.load()

        model.answer("skipped")

        assertEquals("skipped", feed.decisions.first().status)
        assertEquals("calendar", model.s.askedStep)
    }

    @Test fun `a crumb is not carried onto the next step's answer`() = runTest {
        val feed = Feed(session())
        val model = makeModel(feed)
        model.load()
        model.setDecisionData(crumb)

        model.answer("done")
        model.answer("done")

        assertEquals(2, feed.decisions.size)
        assertEquals("calendar", feed.decisions[1].stepKey)
        assertNull(feed.decisions[1].data)
    }

    @Test fun `a crumb set on one step is ignored once another is on screen`() = runTest {
        val model = makeModel(Feed(session()))
        model.load()
        model.setDecisionData(crumb)

        model.jump("calendar")

        assertNull(model.crumbForCurrentStep)
    }

    @Test fun `answering the last step completes instead of patching`() = runTest {
        val feed = Feed(session(currentStep = "recap"))
        val model = makeModel(feed)
        model.load()
        assertEquals("recap", model.s.current?.key)

        model.answer("done")

        assertEquals(listOf("session-1"), feed.completes)
        assertTrue(feed.patches.isEmpty())
        assertNull(model.s.askedStep)
        assertTrue(model.s.showsRecord)
        assertNotNull(model.s.savedAtLabel)
    }

    // ---- the record yields to a step you ask for by name ----

    @Test fun `asking for a step by name leaves the record`() = runTest {
        val feed = Feed(session(status = "completed", completedAt = "2026-09-04T21:50:00.000Z"))
        val model = makeModel(feed)
        model.load()
        assertTrue(model.s.showsRecord)

        model.show("calendar")

        assertFalse(model.s.showsRecord)
        assertEquals("calendar", model.s.current?.key)
        assertTrue(feed.patches.isEmpty())
    }

    @Test fun `a pointer at a step that cannot run keeps you on the record`() = runTest {
        val model = makeModel(Feed(session(status = "completed", completedAt = "2026-09-04T21:50:00.000Z")))
        model.load()
        model.show("meals")
        assertTrue(model.s.showsRecord)
    }

    @Test fun `leaving puts you back on the record rather than the paused screen`() = runTest {
        val model = makeModel(Feed(session(status = "completed", completedAt = "2026-09-04T21:50:00.000Z")))
        model.load()
        model.show("calendar")
        assertFalse(model.s.showsRecord)

        model.leave()

        assertTrue(model.s.showsRecord)
        assertFalse(model.s.isPaused)
    }

    @Test fun `a failed answer does not move the session on`() = runTest {
        val feed = Feed(session()).apply { decideFails = true }
        val model = makeModel(feed)
        model.load()

        model.answer("done")

        assertEquals(1, feed.decisions.size)
        assertTrue(feed.patches.isEmpty())
        assertTrue(feed.completes.isEmpty())
        assertNotNull(model.s.errorMessage)
        assertFalse(model.s.busy)
    }

    // ---- the agenda sheet ----

    @Test fun `jumping moves the session pointer so another device resumes here`() = runTest {
        val feed = Feed(session())
        val model = makeModel(feed)
        model.load()

        model.jump("recap")

        assertEquals("recap", model.s.askedStep)
        assertEquals("recap", model.s.current?.key)
        val patch = assertNotNull(feed.patches.firstOrNull())
        assertEquals("recap", patch.currentStep)
        assertNull(patch.status)
    }

    @Test fun `discarding deletes the session and nothing else`() = runTest {
        val feed = Feed(session())
        val model = makeModel(feed)
        model.load()
        model.leave()

        model.discard()

        assertEquals(listOf("session-1"), feed.discards)
        assertTrue(feed.decisions.isEmpty())
        assertTrue(feed.completes.isEmpty())
        assertNull(model.s.askedStep)
        assertNull(model.s.pausedSessionId)
        assertNull(model.s.session)
    }

    // ---- the record ----

    @Test fun `reopening sends only the status`() = runTest {
        val feed = Feed(session(status = "completed", currentStep = "calendar", completedAt = "2026-09-06T17:32:00.000Z"))
        val model = makeModel(feed)
        model.load()
        assertTrue(model.s.showsRecord)

        model.reopen()

        val patch = assertNotNull(feed.patches.firstOrNull())
        assertEquals("active", patch.status)
        assertNull(patch.currentStep)
        assertEquals("calendar", model.s.askedStep)
    }

    // ---- leaving, and coming back ----

    @Test fun `leaving writes nothing to the server`() = runTest {
        val feed = Feed(session())
        val model = makeModel(feed)
        model.load()
        val fetchesBefore = feed.fetchCount

        model.leave()

        assertTrue(feed.discards.isEmpty())
        assertTrue(feed.decisions.isEmpty())
        assertTrue(feed.patches.isEmpty())
        assertTrue(feed.completes.isEmpty())
        assertEquals(fetchesBefore, feed.fetchCount)
        assertTrue(model.s.isPaused)
        assertEquals(true, model.s.session?.isActive)
    }

    @Test fun `the pause intent suppresses auto-resume on a fresh screen`() = runTest {
        val store = MemoryStore()
        val feed = Feed(session())
        val first = makeModel(feed, store)
        first.load()
        first.leave()

        val second = makeModel(feed, store)
        second.load()

        assertEquals("session-1", second.s.pausedSessionId)
        assertTrue(second.s.isPaused)
    }

    @Test fun `an explicitly asked-for step overrides the pause`() = runTest {
        val model = makeModel(Feed(session()))
        model.load()
        model.leave()
        assertTrue(model.s.isPaused)

        model.jump("calendar")

        assertFalse(model.s.isPaused)
        assertEquals("calendar", model.s.current?.key)
        assertEquals("session-1", model.s.pausedSessionId)
    }

    @Test fun `resuming clears the pause and lands on the session's own pointer`() = runTest {
        val store = MemoryStore()
        val model = makeModel(Feed(session(currentStep = "calendar")), store)
        model.load()
        model.leave()

        model.resume()

        assertFalse(model.s.isPaused)
        assertNull(model.s.pausedSessionId)
        assertNull(store.getString(PlanningModel.PAUSED_KEY))
        assertEquals("calendar", model.s.askedStep)
    }

    @Test fun `a pause left behind by a discarded session is inert`() = runTest {
        val store = MemoryStore().apply { putString(PlanningModel.PAUSED_KEY, "session-from-last-week") }
        val model = makeModel(Feed(session()), store)
        model.load()
        assertFalse(model.s.isPaused)
    }

    @Test fun `completing clears the pause so the record is not shadowed`() = runTest {
        val model = makeModel(Feed(session(currentStep = "recap")))
        model.load()
        model.leave()
        model.jump("recap")

        model.answer("done")

        assertNull(model.s.pausedSessionId)
        assertTrue(model.s.showsRecord)
    }

    // ---- the week stepper ----

    @Test fun `stepping to another week drops the step and asks for that week`() = runTest {
        val feed = Feed(session())
        val model = makeModel(feed)
        model.load()
        model.jump("calendar")

        feed.weekStart = "2026-09-13"
        model.goNextWeek()

        assertNull(model.s.askedStep)
        assertEquals("2026-09-13", model.s.requestedWeek)
        assertEquals("2026-09-13", feed.fetchedWeeks.last())
    }

    @Test fun `a refresh of this week landing late cannot pull the stepper back`() = runTest {
        val feed = Feed(session()).apply { sessionsByWeek = mapOf("2026-09-06" to session()) }
        val model = makeModel(feed)
        model.load()
        assertNotNull(model.s.session)

        feed.holdDefaultFetch = true
        val refresh = launch { model.load() }
        runCurrent()
        assertNotNull(feed.held)
        model.goNextWeek()
        feed.held?.complete(Unit)
        refresh.join()

        assertEquals("2026-09-13", model.s.view?.weekStart)
        assertNull(model.s.session)
    }

    @Test fun `a week that won't load says so and keeps the stepper on the week shown`() = runTest {
        val feed = Feed(session())
        val model = makeModel(feed)
        model.load()

        feed.fetchFails = true
        model.goNextWeek()

        assertNotNull(model.s.errorMessage)
        assertNull(model.s.requestedWeek)
        assertEquals("2026-09-06", model.s.view?.weekStart)
    }

    @Test fun `stepping back to the default week stops pinning a week`() = runTest {
        val feed = Feed(session())
        val model = makeModel(feed)
        model.load()
        feed.weekStart = "2026-09-13"
        model.goNextWeek()
        assertEquals("2026-09-13", model.s.requestedWeek)

        feed.weekStart = "2026-09-06"
        model.goPreviousWeek()

        assertNull(model.s.requestedWeek)
        assertTrue(feed.fetchedWeeks.isNotEmpty())
        assertNull(feed.fetchedWeeks.last())
    }

    @Test fun `the stepper floors at the household's current week`() = runTest {
        val feed = Feed(session()).apply {
            weekStart = "2026-08-30"
            minWeekStart = "2026-08-30"
        }
        val model = makeModel(feed)
        model.load()

        assertFalse(model.s.canGoBack)
        model.goPreviousWeek()
        assertEquals(1, feed.fetchedWeeks.size)
    }

    // ---- parked notes ----

    @Test fun `settling a parked note resolves it against this session`() = runTest {
        val feed = Feed(session()).apply {
            steps = listOf(
                step("looseEnds", 1, act = "Intake"),
                step("calendar", 2, parked = listOf(handoff("note-1", "Book the dentist"))),
                step("recap", 3, act = "Close"),
            )
        }
        val model = makeModel(feed)
        model.load()

        val ok = model.resolveParked("note-1", "done")

        assertTrue(ok)
        assertEquals(Resolve("parked", "note-1", "done", "session-1"), feed.resolves.first())
    }

    // ---- the park bar on every step ----

    private fun parkSteps() = listOf(
        step("looseEnds", 1, act = "Intake"),
        step("calendar", 2),
        step("horizon", 3, title = "Horizon scan"),
        step("familyNight", 4, requiresModule = "familyNight", available = false),
        step("tasks", 5, title = "Tasks"),
        step("recap", 6, act = "Close"),
    )

    @Test fun `the park bar offers only the steps still ahead that can raise it`() = runTest {
        val feed = Feed(session(currentStep = "calendar")).apply { steps = parkSteps() }
        val model = makeModel(feed)
        model.load()

        assertTrue(model.s.showsParkBar)
        assertEquals(listOf("horizon", "tasks"), model.s.parkTags.map { it.stepKey })
        assertEquals(listOf("Horizon scan", "Tasks"), model.s.parkTags.map { it.label })
    }

    @Test fun `the park bar is left to the steps that have their own`() = runTest {
        for (key in listOf("looseEnds", "horizon")) {
            val feed = Feed(session(currentStep = key)).apply { steps = parkSteps() }
            val model = makeModel(feed)
            model.load()
            assertFalse(model.s.showsParkBar, "$key has its own bar")
        }
    }

    @Test fun `parking a note sends its tag and this session then refreshes`() = runTest {
        val feed = Feed(session(currentStep = "calendar")).apply { steps = parkSteps() }
        val model = makeModel(feed)
        model.load()
        val fetched = feed.fetchCount

        val ok = model.parkNote("pack for camping", "horizon")

        assertTrue(ok)
        assertEquals(Park("pack for camping", "horizon", "session-1"), feed.parks.first())
        assertEquals(fetched + 1, feed.fetchCount)
    }

    @Test fun `a refused park says so and keeps the composer open`() = runTest {
        val feed = Feed(session(currentStep = "calendar")).apply {
            steps = parkSteps()
            parkFails = true
        }
        val model = makeModel(feed)
        model.load()

        assertFalse(model.parkNote("pack for camping", null))
        assertNotNull(model.s.parkError)
    }

    @Test fun `parking between sessions sends no session and no tag then refreshes`() = runTest {
        val feed = Feed(session(status = "completed", completedAt = "2026-09-06T17:32:00.000Z"))
        val model = makeModel(feed)
        model.load()
        val fetched = feed.fetchCount
        val rev = model.s.parkedBetweenRevision

        assertTrue(model.parkBetweenSessions("book the cabin"))

        assertEquals(Park("book the cabin", null, null), feed.parks.first())
        assertEquals(fetched + 1, feed.fetchCount)
        assertEquals(rev + 1, model.s.parkedBetweenRevision)
    }

    @Test fun `parking between sessions works before any session exists`() = runTest {
        val feed = Feed()
        val model = makeModel(feed)
        model.load()
        assertTrue(model.parkBetweenSessions("fix the gate"))
        assertNull(feed.parks.first().sessionId)
    }

    @Test fun `a refused park between sessions says so`() = runTest {
        val feed = Feed().apply { parkFails = true }
        val model = makeModel(feed)
        model.load()
        assertFalse(model.parkBetweenSessions("fix the gate"))
        assertNotNull(model.s.parkError)
    }

    // ---- config ----

    @Test fun `saving one step toggle sends only that step`() = runTest {
        val feed = Feed(session())
        val model = makeModel(feed)
        model.load()

        model.saveConfig(PlanningConfigPatch(steps = mapOf("calendar" to false)))

        assertEquals(PlanningConfigPatch(steps = mapOf("calendar" to false)), feed.configSaves.first())
    }

    @Test fun `ruling one list out sends only that list`() = runTest {
        val feed = Feed(session())
        val model = makeModel(feed)
        model.load()

        model.saveConfig(PlanningConfigPatch(lists = mapOf("l2" to false)))

        assertEquals(PlanningConfigPatch(lists = mapOf("l2" to false)), feed.configSaves.first())
    }

    @Test fun `the config read carries the lists it could ask about`() = runTest {
        val model = makeModel(Feed(session()))
        model.loadListCandidates()
        assertEquals(listOf("Repairs", "Someday"), model.s.listCandidates.map { it.name })
    }

    @Test fun `a list nobody has ruled on is still asked about`() {
        val ruled = WeeklyPlanningConfig(0, "17:00", emptyMap(), true, mapOf("l2" to false))
        assertFalse(ruled.asksAbout("l2"))
        assertTrue(ruled.asksAbout("l1"))
        val silent = WeeklyPlanningConfig(0, "17:00", emptyMap(), true, null)
        assertTrue(silent.asksAbout("l1"))
    }

    @Test fun `saving the day leaves the step map alone`() = runTest {
        val feed = Feed(session())
        val model = makeModel(feed)
        model.load()

        model.saveConfig(PlanningConfigPatch(dayOfWeek = 4))

        val save = feed.configSaves.first()
        assertEquals(4, save.dayOfWeek)
        assertNull(save.steps)
    }
}

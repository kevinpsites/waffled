package app.waffled.feature.planning

import app.waffled.feature.planning.api.LooseEndRoute
import app.waffled.feature.planning.api.PlanningStepHandoff
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import app.waffled.core.network.WaffledJson
import kotlinx.serialization.json.put
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The shell-owned helpers several steps share. Ported from the sections of
 * `PlanningLooseEndsTests.swift` (`PlanningSentHereTests`), `PlanningHorizonTests.swift`
 * (the window) and `PlanningGoalsStepTests.swift` (the pace tone) that test them.
 */
class PlanningSharedLogicTest {

    private val parkedId = "33333333-3333-4333-8333-333333333333"

    private fun route(kind: String, id: String, title: String, to: String) =
        LooseEndRoute(kind = kind, id = id, title = title, source = "notDone", to = to)

    // ---- what arrives at the destination step ----

    @Test fun `only the routes addressed to this step`() {
        val routes = listOf(
            route("chore", "c1", "Bins", "calendar"),
            route("list", "l1", "Pack the tent", "calendar"),
            route("rhythm", "g1", "Book the dentist", "goals"),
        )
        assertEquals(listOf("c1", "l1"), PlanningRouteSeed.sentHere("calendar", routes, null, emptySet()).map { it.id })
        assertEquals(listOf("g1"), PlanningRouteSeed.sentHere("goals", routes, null, emptySet()).map { it.id })
        assertTrue(PlanningRouteSeed.sentHere("meals", routes, null, emptySet()).isEmpty())
    }

    @Test fun `a parked note routed here is not offered twice`() {
        val routes = listOf(
            route("parked", parkedId, "Ask about the school trip", "calendar"),
            route("chore", "c1", "Bins", "calendar"),
        )
        val parked = listOf(PlanningStepHandoff(parkedId, "Ask about the school trip", "Kevin · today"))
        assertEquals(listOf("c1"), PlanningRouteSeed.sentHere("calendar", routes, parked, emptySet()).map { it.id })
    }

    @Test fun `a parked route with no note on screen is still offered`() {
        val routes = listOf(route("parked", parkedId, "Ask about the school trip", "calendar"))
        val someoneElse = listOf(PlanningStepHandoff("other", "Buy stamps", null))
        assertEquals(listOf(parkedId), PlanningRouteSeed.sentHere("calendar", routes, null, emptySet()).map { it.id })
        assertEquals(listOf(parkedId), PlanningRouteSeed.sentHere("calendar", routes, someoneElse, emptySet()).map { it.id })
    }

    @Test fun `steps that draw their own routed rows are left alone`() {
        val routes = listOf(route("chore", "c1", "Bins", "kids"), route("chore", "c2", "Homework", "looseEnds"))
        assertTrue(PlanningRouteSeed.sentHere("kids", routes, null, emptySet()).isEmpty())
        assertTrue(PlanningRouteSeed.sentHere("looseEnds", routes, null, emptySet()).isEmpty())
    }

    @Test fun `a route already acted on stops being offered`() {
        val routes = listOf(route("chore", "c1", "Bins", "calendar"), route("list", "l1", "Pack the tent", "calendar"))
        assertEquals("chore:c1", PlanningRouteSeed.key(routes[0]))
        assertEquals(
            listOf("l1"),
            PlanningRouteSeed.sentHere("calendar", routes, null, setOf(PlanningRouteSeed.key(routes[0]))).map { it.id },
        )
    }

    @Test fun `nothing routed here is the normal case`() {
        assertTrue(PlanningRouteSeed.sentHere("calendar", emptyList(), null, emptySet()).isEmpty())
        assertTrue(
            PlanningRouteSeed.sentHere("calendar", listOf(route("chore", "c1", "Bins", "tasks")), null, emptySet()).isEmpty(),
        )
    }

    @Test fun `the routes are decoded tolerantly`() {
        val decoded = PlanningRouteSeed.decode(
            buildJsonArray {
                add(
                    buildJsonObject {
                        put("kind", "chore"); put("id", "c1"); put("title", "Bins")
                        put("source", "notDone"); put("to", "calendar")
                    },
                )
                add(buildJsonObject { put("kind", "parked"); put("id", "p1"); put("to", "calendar") })
                add(JsonPrimitive("nonsense"))
            },
        )
        assertEquals(listOf("c1", "p1"), decoded.map { it.id })
        assertEquals("", decoded.last().title)
        assertEquals("parked", decoded.last().source)
        assertEquals("notDone", PlanningRouteSeed.decode(buildJsonArray {
            add(buildJsonObject { put("kind", "chore"); put("id", "c9"); put("to", "tasks") })
        }).single().source)

        assertTrue(PlanningRouteSeed.decode(null).isEmpty())
        assertTrue(PlanningRouteSeed.decode(JsonNull).isEmpty())
        assertTrue(PlanningRouteSeed.decode(buildJsonObject { put("routes", "not an array") }).isEmpty())
    }

    @Test fun `a route written back keeps every key even when it holds the default`() {
        // Step 1 re-sends routes through decideStep, which replaces the row's data.
        val encoded = WaffledJson.encodeToJsonElement(
            LooseEndRoute.serializer(),
            LooseEndRoute(kind = "chore", id = "c1", to = "tasks"),
        ).jsonObject
        assertEquals(setOf("kind", "id", "title", "source", "to"), encoded.keys)
        assertEquals(JsonPrimitive("notDone"), encoded["source"])
    }

    // ---- the Horizon window ----

    @Test fun `the horizon window starts on the planned week and steps four weeks`() {
        assertEquals("2026-09-06", PlanningHorizonWindow.start("2026-09-06", 0))
        assertEquals("2026-10-04", PlanningHorizonWindow.start("2026-09-06", 1))
        assertEquals("2027-01-24", PlanningHorizonWindow.start("2026-12-27", 1))
        assertNull(PlanningHorizonWindow.start("not-a-date", 0))
    }

    @Test fun `the horizon window is labelled by its first and last day`() {
        assertEquals("Sep 6 – Oct 3", PlanningHorizonWindow.label("2026-09-06"))
        assertEquals("Dec 27 – Jan 23", PlanningHorizonWindow.label("2026-12-27"))
        assertEquals("", PlanningHorizonWindow.label(""))
    }

    // ---- the pace tone ----

    @Test fun `an unknown tone reads neutral rather than alarming`() {
        assertEquals(PlanningPaceTone.Kind.Ok, PlanningPaceTone.kind("ok"))
        assertEquals(PlanningPaceTone.Kind.Behind, PlanningPaceTone.kind("behind"))
        assertEquals(PlanningPaceTone.Kind.Neutral, PlanningPaceTone.kind("flat"))
        assertEquals(PlanningPaceTone.Kind.Neutral, PlanningPaceTone.kind("euphoric"))
    }
}

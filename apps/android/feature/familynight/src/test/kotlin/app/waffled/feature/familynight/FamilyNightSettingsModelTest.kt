package app.waffled.feature.familynight

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Port of the Family Night cases in `AdminSettingsMutationTests.swift`. */
class FamilyNightSettingsModelTest {

    private class Rejected : Exception()

    private fun config(day: Int = 1, time: String = "19:00", eventId: String? = null, label: String = "Activity") =
        FamilyNightApi.Config(
            parts = listOf(FamilyNightApi.Part(id = "activity", label = label, emoji = "🎲", rotates = true)),
            dayOfWeek = day,
            time = time,
            eventId = eventId,
        )

    private fun view(c: FamilyNightApi.Config) = FamilyNightApi.View(
        config = c,
        members = emptyList(),
        next = FamilyNightApi.Next(date = "2026-08-03", status = "planned"),
    )

    @Test
    fun `failed schedule rolls back day and time`() = runTest {
        val original = config(day = 1, time = "19:00")
        val model = FamilyNightSettingsModel(
            fetch = { view(original) },
            setConfig = { throw Rejected() },
            schedule = { "event-1" },
            unschedule = {},
        )
        model.load()

        model.setDay(5)

        assertEquals(1, model.state.value.dayOfWeek)
        assertEquals("19:00", model.state.value.time)
        assertTrue(model.state.value.errorMessage!!.contains("wasn’t saved"))
    }

    @Test
    fun `failed calendar refresh keeps the confirmed new schedule`() = runTest {
        val model = FamilyNightSettingsModel(
            fetch = { view(config(day = 1, eventId = "event-1")) },
            setConfig = { config(day = 5, eventId = "event-1") },
            schedule = { throw Rejected() },
            unschedule = {},
        )
        model.load()

        model.setDay(5)

        assertEquals(5, model.state.value.dayOfWeek)
        val msg = model.state.value.errorMessage!!
        assertTrue(msg.contains("was saved"))
        assertTrue(msg.contains("calendar event"))
    }

    @Test
    fun `time picker persists its latest queued value`() = runTest {
        val requests = mutableListOf<JsonObject>()
        val firstRequest = CompletableDeferred<FamilyNightApi.Config>()
        val model = FamilyNightSettingsModel(
            fetch = { view(config()) },
            setConfig = { body ->
                requests += body
                if (requests.size == 1) firstRequest.await() else config(day = 1, time = "20:00")
            },
            schedule = { "event-1" },
            unschedule = {},
        )
        model.load()

        val first = async { model.setTime("19:30") }
        runCurrent()
        val latest = async { model.setTime("20:00") }
        runCurrent()
        firstRequest.complete(config(day = 1, time = "19:30"))
        first.await()
        latest.await()

        assertEquals(2, requests.size)
        assertEquals(JsonPrimitive("20:00"), requests[1]["time"])
        assertEquals("20:00", model.state.value.time)
        assertFalse(model.state.value.busySchedule)
    }

    @Test
    fun `failed calendar toggle rolls back`() = runTest {
        val original = config(eventId = null)
        val model = FamilyNightSettingsModel(
            fetch = { view(original) },
            setConfig = { original },
            schedule = { throw Rejected() },
            unschedule = {},
        )
        model.load()

        model.setCalendar(true)

        assertFalse(model.state.value.onCalendar)
        assertNotNull(model.state.value.errorMessage)
    }

    @Test
    fun `failed agenda save preserves the draft for retry`() = runTest {
        val model = FamilyNightSettingsModel(
            fetch = { view(config(label = "Activity")) },
            setConfig = { throw Rejected() },
            schedule = { "event-1" },
            unschedule = {},
        )
        model.load()
        model.updatePart("activity") { it.copy(label = "Board game") }

        model.saveAgenda()

        assertEquals("Board game", model.state.value.parts[0].label)
        assertTrue(model.state.value.errorMessage!!.contains("edits are still here"))
    }

    // ---- beyond the iOS suite: the agenda payload and part editing ----

    @Test
    fun `agenda save sends every part and fills a blank emoji`() = runTest {
        var sent: JsonObject? = null
        val model = FamilyNightSettingsModel(
            fetch = { view(config()) },
            setConfig = { body -> sent = body; config(label = "Board game") },
            schedule = { "event-1" },
            unschedule = {},
        )
        model.load()
        model.updatePart("activity") { it.copy(emoji = "") }

        model.saveAgenda()

        assertEquals(
            """{"parts":[{"id":"activity","label":"Activity","emoji":"⭐","rotates":true}]}""",
            sent.toString(),
        )
        assertEquals("Board game", model.state.value.parts[0].label)
    }

    @Test
    fun `a new part starts rotating with a star and can be removed`() = runTest {
        val model = FamilyNightSettingsModel(
            fetch = { view(config()) },
            setConfig = { config() },
            schedule = { "e" },
            unschedule = {},
        )
        model.load()
        model.addPart()
        val added = model.state.value.parts.last()
        assertEquals("New part", added.label)
        assertEquals("⭐", added.emoji)
        assertTrue(added.rotates)

        model.removePart(added.id)
        assertEquals(1, model.state.value.parts.size)
    }

    @Test
    fun `a load failure says so and stays unloaded`() = runTest {
        val model = FamilyNightSettingsModel(
            fetch = { throw Rejected() },
            setConfig = { config() },
            schedule = { "e" },
            unschedule = {},
        )
        model.load()
        assertFalse(model.state.value.loaded)
        assertFalse(model.state.value.loading)
        assertTrue(model.state.value.errorMessage!!.startsWith("Couldn’t load Family Night settings"))
    }
}

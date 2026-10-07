package app.waffled.feature.capture

import app.waffled.core.network.WaffledJson
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import java.time.LocalDate
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Decoding the server's intent, plus the copied recurrence subset the parser labels with. */
class CaptureIntentTest {

    private fun decode(json: String) = CaptureIntent.fromJson(WaffledJson.parseToJsonElement(json))

    @Test fun `event decodes with defaults for the optional labels`() {
        val e = decode("""{"kind":"event","title":"Soccer","startsAt":"2026-06-16T22:00:00Z","personName":"Wally"}""")
        assertEquals(CaptureIntent.Event("Soccer", "2026-06-16T22:00:00Z", false, "Wally", null, "", ""), e)
    }

    @Test fun `goal falls back to habit and shared_total`() {
        val g = decode("""{"kind":"goal","title":"Read","targetValue":20}""") as CaptureIntent.Goal
        assertEquals("habit", g.goalType)
        assertEquals("shared_total", g.trackingMode)
        assertEquals(20.0, g.targetValue)
    }

    @Test fun `mutate reads target description and args`() {
        val m = decode(
            """{"kind":"mutate","verb":"log","targetKind":"goal","target":{"description":"reading"},"args":{"minutes":20}}""",
        ) as CaptureIntent.Mutate
        assertEquals("reading", m.description)
        assertEquals(JsonPrimitive(20), m.args["minutes"])
    }

    @Test fun `mutate accepts the legacy mutateArgs alias`() {
        val m = decode(
            """{"kind":"mutate","verb":"reassign","target":{"description":"dishes"},"mutateArgs":{"personName":"Wally"}}""",
        ) as CaptureIntent.Mutate
        assertEquals(JsonPrimitive("Wally"), m.args["personName"])
        assertNull(m.targetKind)
    }

    @Test fun `unknown kind or missing required field is null not a crash`() {
        assertNull(decode("""{"kind":"spaceship","title":"x"}"""))
        assertNull(decode("""{"kind":"event","title":"no start"}"""))
        assertNull(CaptureIntent.fromJson(null))
    }

    @Test fun `empty resolve copy never claims a missing item when the action is unsupported`() {
        assertEquals("Quick-add can't do that yet.", MutateLabels.emptyHint(true, null, "goal"))
        assertEquals("Goals is off", MutateLabels.emptyHint(true, "Goals is off", "goal"))
        assertEquals("Couldn't find a list item like that", MutateLabels.emptyHint(false, null, "listItem"))
        assertEquals("Couldn't find a goal like that — Goals is off", MutateLabels.emptyHint(false, "Goals is off", "goal"))
    }

    @Test fun `repeat menu round-trips the presets and keeps anything else verbatim`() {
        val tue = LocalDate.of(2026, 6, 16)
        assertEquals(CaptureRepeatFreq.None, CaptureRepeat.parse(null).freq)
        assertEquals(CaptureRepeatFreq.Weekdays, CaptureRepeat.parse("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR").freq)
        assertEquals("FREQ=WEEKLY;BYDAY=TU,TH", CaptureRepeat.parse("FREQ=WEEKLY;BYDAY=TU,TH").rrule(tue))
        assertEquals("FREQ=WEEKLY;BYDAY=TU", CaptureRepeat(CaptureRepeatFreq.Weekly).rrule(tue))
        assertEquals("FREQ=YEARLY", CaptureRepeat.parse("FREQ=YEARLY").rrule(tue))
        val other = CaptureRepeat.parse("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU")
        assertEquals(CaptureRepeatFreq.Custom, other.freq)
        assertEquals("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", other.rrule(tue))
        assertNull(CaptureRepeat().rrule(tue))
    }

    @Test fun `describe matches the calendar wording`() {
        val d = LocalDate.of(2026, 6, 16)
        assertEquals("Every day", CaptureRecurrence.describeRrule("FREQ=DAILY", d))
        assertEquals("Every 2 weeks on Tue", CaptureRecurrence.describeRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", d))
        assertEquals("Every weekday (Mon–Fri)", CaptureRecurrence.describeRrule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", d))
        assertEquals("Every month on the second Friday", CaptureRecurrence.describeRrule("FREQ=MONTHLY;BYDAY=2FR", d))
        assertTrue(CaptureRecurrence.describeRrule("FREQ=HOURLY", d).startsWith("FREQ"))
    }
}

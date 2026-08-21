package app.waffled.feature.calendar

import org.junit.Test
import java.time.LocalDate
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Kotlin port of `apps/ios/Tests/RecurrenceTests.swift`, which is itself a mirror of
 * the web's `apps/web/src/kiosk/components/recurrence.test.ts`.
 *
 * The picker's RRULE build / parse / describe logic must stay byte-identical across all
 * three clients, so an event made recurring on one surface round-trips on the others.
 *
 * The Swift suite pins a UTC calendar to keep weekday derivation deterministic. Kotlin
 * needs no such rig: [Recurrence] takes a `LocalDate`, which carries no zone at all.
 */
class RecurrenceTest {

    // Reference dates: a Monday, a Wednesday, and the 2nd Tuesday of June 2026.
    private val mon = LocalDate.of(2026, 6, 22)
    private val wed = LocalDate.of(2026, 6, 10)
    private val tue2nd = LocalDate.of(2026, 6, 9)

    // ---- build -----------------------------------------------------------------

    @Test
    fun buildsThePresetRules() {
        assertNull(Recurrence.buildRrule(RepeatState(freq = RepeatFreq.None), mon))
        assertEquals("FREQ=DAILY", Recurrence.buildRrule(RepeatState(freq = RepeatFreq.Daily), mon))
        assertEquals(
            "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
            Recurrence.buildRrule(RepeatState(freq = RepeatFreq.Weekdays), mon),
        )
        // An empty byday defaults to the START's weekday.
        assertEquals(
            "FREQ=WEEKLY;BYDAY=WE",
            Recurrence.buildRrule(RepeatState(freq = RepeatFreq.Weekly), wed),
        )
        assertEquals(
            "FREQ=WEEKLY;BYDAY=MO,TH",
            Recurrence.buildRrule(RepeatState(freq = RepeatFreq.Weekly, byday = listOf("MO", "TH")), wed),
        )
        assertEquals("FREQ=MONTHLY", Recurrence.buildRrule(RepeatState(freq = RepeatFreq.Monthly), mon))
    }

    @Test
    fun buildsTheFriendlyCustomRules() {
        assertEquals(
            "FREQ=DAILY;INTERVAL=3",
            Recurrence.buildRrule(custom(unit = CustomUnit.Day, interval = 3), mon),
        )
        assertEquals(
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH",
            Recurrence.buildRrule(custom(unit = CustomUnit.Week, interval = 2, byday = listOf("TU", "TH")), mon),
        )
        assertEquals(
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
            Recurrence.buildRrule(custom(unit = CustomUnit.Week, interval = 2), mon),
        )
        assertEquals(
            "FREQ=MONTHLY;INTERVAL=2",
            Recurrence.buildRrule(custom(unit = CustomUnit.Month, interval = 2), tue2nd),
        )
        assertEquals("FREQ=YEARLY;INTERVAL=2", Recurrence.buildRrule(custom(unit = CustomUnit.Year, interval = 2), mon))
        // Interval 1 emits no INTERVAL clause at all.
        assertEquals("FREQ=DAILY", Recurrence.buildRrule(custom(unit = CustomUnit.Day, interval = 1), mon))
        assertEquals(
            "FREQ=WEEKLY;BYDAY=MO",
            Recurrence.buildRrule(custom(unit = CustomUnit.Week, interval = 1), mon),
        )
    }

    @Test
    fun buildsAnyOrdinalForMonthlyNthWeekday() {
        fun nth(ordinal: Int) = Recurrence.buildRrule(
            custom(unit = CustomUnit.Month, interval = 1, monthlyMode = MonthlyMode.NthWeekday, ordinal = ordinal),
            tue2nd,
        )
        assertEquals("FREQ=MONTHLY;BYDAY=1TU", nth(1))
        assertEquals("FREQ=MONTHLY;BYDAY=2TU", nth(2))
        assertEquals("FREQ=MONTHLY;BYDAY=-1TU", nth(-1))
        // Ordinal 0 falls back to the start date's own nth (2026-06-09 is the 2nd Tuesday).
        assertEquals("FREQ=MONTHLY;BYDAY=2TU", nth(0))
    }

    @Test
    fun anAdvancedRawRuleOverridesTheBuilder() {
        assertEquals(
            "FREQ=WEEKLY;COUNT=5;BYDAY=TU",
            Recurrence.buildRrule(
                RepeatState(freq = RepeatFreq.Custom, custom = "RRULE:FREQ=WEEKLY;COUNT=5;BYDAY=TU"),
                mon,
            ),
        )
    }

    // ---- parse -----------------------------------------------------------------

    @Test
    fun parsesNothingAsNone() {
        assertEquals(RepeatState.NONE, Recurrence.parseRepeat(null))
        assertEquals(RepeatState.NONE, Recurrence.parseRepeat(""))
    }

    @Test
    fun parsesThePresets() {
        assertEquals(RepeatState(freq = RepeatFreq.Daily), Recurrence.parseRepeat("FREQ=DAILY"))
        assertEquals(
            RepeatState(freq = RepeatFreq.Weekdays),
            Recurrence.parseRepeat("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"),
        )
        assertEquals(
            RepeatState(freq = RepeatFreq.Weekly, byday = listOf("MO", "TH")),
            Recurrence.parseRepeat("FREQ=WEEKLY;BYDAY=MO,TH"),
        )
        assertEquals(RepeatState(freq = RepeatFreq.Monthly), Recurrence.parseRepeat("FREQ=MONTHLY"))
    }

    @Test
    fun parsesIntervalAndNthWeekdayRulesOntoTheCustomBuilder() {
        assertEquals(
            custom(unit = CustomUnit.Day, interval = 3),
            Recurrence.parseRepeat("FREQ=DAILY;INTERVAL=3"),
        )
        assertEquals(
            custom(unit = CustomUnit.Week, interval = 2, byday = listOf("TU", "TH")),
            Recurrence.parseRepeat("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH"),
        )
        assertEquals(
            custom(unit = CustomUnit.Month, interval = 2),
            Recurrence.parseRepeat("FREQ=MONTHLY;INTERVAL=2"),
        )
        assertEquals(
            custom(unit = CustomUnit.Month, interval = 1, monthlyMode = MonthlyMode.NthWeekday, ordinal = 1),
            Recurrence.parseRepeat("FREQ=MONTHLY;BYDAY=1TH"),
        )
        assertEquals(
            custom(unit = CustomUnit.Month, interval = 1, monthlyMode = MonthlyMode.NthWeekday, ordinal = 2),
            Recurrence.parseRepeat("FREQ=MONTHLY;BYDAY=2TU"),
        )
        assertEquals(
            custom(unit = CustomUnit.Month, interval = 1, monthlyMode = MonthlyMode.NthWeekday, ordinal = -1),
            Recurrence.parseRepeat("FREQ=MONTHLY;BYDAY=-1TU"),
        )
        assertEquals(
            custom(unit = CustomUnit.Year, interval = 2),
            Recurrence.parseRepeat("FREQ=YEARLY;INTERVAL=2"),
        )
    }

    @Test
    fun preservesBoundedRulesVerbatimAsAdvanced() {
        // COUNT / UNTIL are beyond the friendly builder, so the raw rule is kept whole —
        // that is what stops an imported rule being silently rewritten on save.
        val parsed = Recurrence.parseRepeat("FREQ=WEEKLY;COUNT=5;BYDAY=TU")
        assertEquals(RepeatFreq.Custom, parsed.freq)
        assertEquals("FREQ=WEEKLY;COUNT=5;BYDAY=TU", parsed.custom)
    }

    @Test
    fun everySupportedRuleRoundTrips() {
        val rules = listOf(
            "FREQ=DAILY",
            "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
            "FREQ=WEEKLY;BYDAY=MO,TH",
            "FREQ=MONTHLY",
            "FREQ=DAILY;INTERVAL=3",
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH",
            "FREQ=MONTHLY;INTERVAL=2",
            "FREQ=MONTHLY;BYDAY=2TU",
            "FREQ=MONTHLY;BYDAY=-1TU",
            "FREQ=YEARLY;INTERVAL=2",
        )
        for (rule in rules) {
            assertEquals(rule, Recurrence.buildRrule(Recurrence.parseRepeat(rule), tue2nd), "round trip: $rule")
        }
    }

    // ---- describe --------------------------------------------------------------

    @Test
    fun describesARuleInPlainEnglish() {
        assertEquals("Does not repeat", Recurrence.describeRrule(null, mon))
        assertEquals("Every day", Recurrence.describeRrule("FREQ=DAILY", mon))
        assertEquals("Every 3 days", Recurrence.describeRrule("FREQ=DAILY;INTERVAL=3", mon))
        assertEquals("Every weekday (Mon–Fri)", Recurrence.describeRrule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", mon))
        assertEquals("Every 2 weeks on Tue, Thu", Recurrence.describeRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH", mon))
        assertEquals("Every month on the first Thursday", Recurrence.describeRrule("FREQ=MONTHLY;BYDAY=1TH", mon))
        assertEquals("Every month on the second Tuesday", Recurrence.describeRrule("FREQ=MONTHLY;BYDAY=2TU", mon))
        assertEquals("Every month on the last Friday", Recurrence.describeRrule("FREQ=MONTHLY;BYDAY=-1FR", mon))
        assertEquals("Every 2 years", Recurrence.describeRrule("FREQ=YEARLY;INTERVAL=2", mon))
    }

    @Test
    fun appendsACountAndFallsBackToTheRawRule() {
        assertEquals("Every day, 5 times", Recurrence.describeRrule("FREQ=DAILY;COUNT=5", mon))
        // Unrecognised shapes show the raw rule — never an empty summary for a real rule.
        assertEquals("FREQ=HOURLY", Recurrence.describeRrule("FREQ=HOURLY", mon))
    }

    // ---- helpers ---------------------------------------------------------------

    @Test
    fun derivesTheWeekdayCode() {
        assertEquals("MO", Recurrence.weekdayCode(mon))
        assertEquals("WE", Recurrence.weekdayCode(wed))
        assertEquals("TU", Recurrence.weekdayCode(tue2nd))
    }

    @Test
    fun derivesWhichNthWeekdayOfItsMonthADateIs() {
        assertEquals(2, Recurrence.nthWeekdayOfMonth(tue2nd))
        assertEquals(1, Recurrence.nthWeekdayOfMonth(LocalDate.of(2026, 6, 2)))
    }

    @Test
    fun readsTheOrdinalOutOfASingleBydayToken() {
        assertEquals(2, Recurrence.nthWeekdayOrdinal("2TU"))
        assertEquals(-1, Recurrence.nthWeekdayOrdinal("-1FR"))
        assertNull(Recurrence.nthWeekdayOrdinal("TU"))
        assertNull(Recurrence.nthWeekdayOrdinal("MO,TU"))
    }

    // ---- the recurring-edit policy ---------------------------------------------

    private val original = RecurringEventSeriesFields(
        allDay = false,
        isCountdown = false,
        participantIds = listOf("person-a"),
        goalId = "goal-a",
        goalStepId = "step-a",
        rrule = "FREQ=WEEKLY;BYDAY=MO",
        recurrenceEndAt = null,
    )

    @Test
    fun singleOccurrenceAcceptsOnlyUnchangedSeriesFields() {
        assertTrue(RecurringEventEditPolicy.canApplyToSingleOccurrence(original, original))
        assertFalse(
            RecurringEventEditPolicy.canApplyToSingleOccurrence(
                original,
                original.copy(isCountdown = true),
            ),
        )
    }

    @Test
    fun participantOrderDoesNotChangeTheSeries() {
        val twoPeople = original.copy(
            participantIds = listOf("person-a", "person-b"),
            goalId = null,
            goalStepId = null,
        )
        val reordered = twoPeople.copy(participantIds = listOf("person-b", "person-a"))
        assertTrue(RecurringEventEditPolicy.canApplyToSingleOccurrence(twoPeople, reordered))
    }

    private fun custom(
        unit: CustomUnit,
        interval: Int,
        byday: List<String> = emptyList(),
        monthlyMode: MonthlyMode = MonthlyMode.DayOfMonth,
        ordinal: Int = 1,
    ) = RepeatState(
        freq = RepeatFreq.Custom,
        byday = byday,
        interval = interval,
        unit = unit,
        monthlyMode = monthlyMode,
        monthlyOrdinal = ordinal,
    )
}

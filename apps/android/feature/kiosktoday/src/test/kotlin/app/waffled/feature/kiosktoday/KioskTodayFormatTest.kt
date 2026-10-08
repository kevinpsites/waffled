package app.waffled.feature.kiosktoday

import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.family.FamilyApi
import app.waffled.feature.today.TodayApi
import java.time.LocalDate
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals

/** The iPad Today's display strings and the agenda's week grouping. */
class KioskTodayFormatTest {

    private val today = LocalDate.of(2026, 7, 16)
    private fun ev(id: String) = SyncedEvent(id = id, householdId = "h", title = id, startsAt = null)

    /** iOS `Agenda.upcoming(...).prefix(7)`: days from today on, ascending, at most seven. */
    @Test
    fun weekIsTheNextSevenDaysWithEventsFromToday() {
        val byDay = (-2..9).associate { today.plusDays(it.toLong()) to listOf(ev("e$it")) }
        val week = KioskTodayFormat.week(byDay, today)
        assertEquals(7, week.size)
        assertEquals(today, week.first().first)
        assertEquals(today.plusDays(6), week.last().first)
    }

    @Test
    fun dayLabels() {
        assertEquals("TODAY", KioskTodayFormat.dayLabel(today, today, Locale.US))
        assertEquals("TOMORROW", KioskTodayFormat.dayLabel(today.plusDays(1), today, Locale.US))
        assertEquals("SATURDAY · JUL 18", KioskTodayFormat.dayLabel(today.plusDays(2), today, Locale.US))
    }

    @Test
    fun dayShortReadsTheEntryDateAndToleratesGarbage() {
        assertEquals("Thu", KioskTodayFormat.dayShort("2026-07-16", Locale.US))
        assertEquals("", KioskTodayFormat.dayShort("nope", Locale.US))
    }

    /** iOS `WeekEntryDTO.displayTitle`: recipe → plate → free text → "Planned meal". */
    @Test
    fun dinnerTitleFallbacks() {
        val base = TodayApi.WeekEntry(id = "1", date = "2026-07-16", mealType = "dinner")
        assertEquals("Planned meal", KioskTodayFormat.dinnerTitle(base))
        assertEquals("Fish", KioskTodayFormat.dinnerTitle(base.copy(title = "Fish")))
        assertEquals("BBQ", KioskTodayFormat.dinnerTitle(base.copy(title = "Fish", meal = TodayApi.MealSlot(id = "m", name = "BBQ"))))
        assertEquals(
            "Curry",
            KioskTodayFormat.dinnerTitle(
                base.copy(title = "Fish", recipe = TodayApi.RecipeInfo(title = "Curry"), meal = TodayApi.MealSlot(id = "m", name = "BBQ")),
            ),
        )
    }

    @Test
    fun approvalsPreviewNamesRedemptionsThenChoresUpToThree() {
        val red = listOf(FamilyApi.Redemption(id = "r", personName = "June", title = "Ice cream"))
        val ch = listOf(
            FamilyApi.ChoreInstance(id = "c1", choreTitle = "Dishes", personName = null),
            FamilyApi.ChoreInstance(id = "c2", choreTitle = "Trash", personName = "Rex"),
            FamilyApi.ChoreInstance(id = "c3", choreTitle = "Beds", personName = "Ann"),
        )
        assertEquals(
            "June’s Ice cream · Someone’s Dishes · Rex’s Trash — your OK awards the stars.",
            KioskTodayFormat.approvalsSubtitle(red, ch),
        )
        assertEquals("Your OK awards the stars.", KioskTodayFormat.approvalsSubtitle(emptyList(), emptyList()))
    }

    @Test
    fun reviewSubtitle() {
        assertEquals("A · B · C — each ties to a goal.", KioskTodayFormat.reviewSubtitle(listOf("A", "B", "C", "D")))
        assertEquals("Each ties to a goal.", KioskTodayFormat.reviewSubtitle(emptyList()))
    }
}

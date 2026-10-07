package app.waffled.core.model

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.TemporalAdjusters

/**
 * The household's first-day-of-week preference (`households.week_start`), as opposed to
 * the DEVICE's locale setting. The two are independent and routinely disagree — a Monday
 * household on a US phone — and the server cuts grocery weeks, habit periods and planner
 * weeks on this one. Twin of iOS `HouseholdWeekStart` + the household overloads in `Cal`.
 *
 * Read the live value from `SyncManager.householdWeekStart` and [parse] it; never derive
 * a week boundary from the device locale for a household-keyed screen.
 */
enum class HouseholdWeekStart {
    Sunday,
    Monday,
    ;

    /** The day the household's week opens on. */
    val dayOfWeek: DayOfWeek
        get() = if (this == Monday) DayOfWeek.MONDAY else DayOfWeek.SUNDAY

    /** Start of the household week containing [date]. */
    fun weekStart(date: LocalDate): LocalDate =
        date.with(TemporalAdjusters.previousOrSame(dayOfWeek))

    /** Any 7-item weekday row (Sunday-first), rotated to open on this day. */
    fun <T> rotated(sundayFirst: List<T>): List<T> {
        if (sundayFirst.size != 7) return sundayFirst
        val offset = if (this == Monday) 1 else 0
        return List(7) { sundayFirst[(it + offset) % 7] }
    }

    /** Blank cells before the 1st in a month grid cut on this day. */
    fun monthLeadCells(monthStart: LocalDate): Int {
        val weekday = monthStart.dayOfWeek.value % 7 // 0 = Sunday
        val offset = if (this == Monday) 1 else 0
        return (weekday - offset + 7) % 7
    }

    companion object {
        /**
         * Lenient: the value arrives as free text off the synced `households` row. Sunday
         * is the server's default, so unrecognised or absent text reads as Sunday.
         *
         * This is the PARSER, not the "haven't synced yet" answer — absent-because-nothing-
         * has-synced is a `null` [HouseholdWeekStart] (see [of]).
         */
        fun parse(raw: String?): HouseholdWeekStart =
            if (raw?.trim()?.lowercase() == "monday") Monday else Sunday

        /** The preference for a household row that has actually arrived, or null when none has. */
        fun of(household: Household?): HouseholdWeekStart? = household?.let { parse(it.weekStart) }
    }
}

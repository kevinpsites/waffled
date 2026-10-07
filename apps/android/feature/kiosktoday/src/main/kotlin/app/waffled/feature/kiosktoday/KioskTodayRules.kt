package app.waffled.feature.kiosktoday

import app.waffled.core.network.RestState
import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.family.FamilyApi
import app.waffled.feature.goals.GoalsApi
import app.waffled.feature.today.TodayApi
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/** One of the dashboard's three columns. */
enum class KioskColumn { Agenda, Meals, ChoreGrocery, Goal }

/**
 * The per-device layout presets — iOS `DashLayout`. [raw] matches the iOS stored value so
 * the pref means the same thing on both platforms.
 */
enum class DashLayout(val raw: String, val label: String) {
    Balanced("balanced", "Balanced"),
    Agenda("agenda", "Agenda-focused"),
    Meals("meals", "Meals-focused"),
    Goal("goal", "Goal-focused");

    /** Left-to-right columns with their relative widths (`KioskDashboard.dashRow`). */
    val columns: List<Pair<KioskColumn, Float>>
        get() = when (this) {
            Balanced -> listOf(KioskColumn.Agenda to 1f, KioskColumn.Meals to 1f, KioskColumn.ChoreGrocery to 1f)
            Agenda -> listOf(KioskColumn.Agenda to 1.7f, KioskColumn.Meals to 0.95f, KioskColumn.ChoreGrocery to 0.95f)
            Meals -> listOf(KioskColumn.Meals to 1.5f, KioskColumn.Agenda to 1f, KioskColumn.ChoreGrocery to 1f)
            Goal -> listOf(KioskColumn.Goal to 1.5f, KioskColumn.Agenda to 1f, KioskColumn.ChoreGrocery to 1f)
        }

    companion object {
        fun parse(raw: String?): DashLayout = entries.firstOrNull { it.raw == raw } ?: Balanced
    }
}

/** The two per-device dashboard prefs the host persists. Empty [pinnedGoalId] = auto. */
data class KioskDashPrefs(val layout: DashLayout, val pinnedGoalId: String) {
    /** Pinning re-asserts the goal layout, so a pick can't drift the wall off the goal view. */
    fun pinning(goalId: String): KioskDashPrefs = KioskDashPrefs(DashLayout.Goal, goalId)
}

object KioskGoalPick {
    /**
     * Pinned if it still exists → Spotlight → Pinned tier (isFeatured) → a goal every
     * member is in (multi-member households only) → the first goal.
     */
    fun featured(goals: List<GoalsApi.Goal>, pinnedId: String, memberIds: Set<String>): GoalsApi.Goal? {
        if (pinnedId.isNotEmpty()) goals.firstOrNull { it.id == pinnedId }?.let { return it }
        (goals.firstOrNull { it.isSpotlight == true } ?: goals.firstOrNull { it.isFeatured })?.let { return it }
        if (memberIds.size > 1) {
            goals.firstOrNull { g -> g.participants.mapTo(HashSet()) { it.personId }.containsAll(memberIds) }
                ?.let { return it }
        }
        return goals.firstOrNull()
    }
}

/** The card-visibility and copy rules from `KioskDashboard`, kept out of the composables. */
object KioskTodayRules {
    /** The goal column shows tonight unless a fresh answer said there is none. */
    fun goalColumnShowsTonight(hasTonight: Boolean, mealsState: RestState): Boolean =
        hasTonight || !mealsState.isAuthoritative

    fun showsGoalCard(hasGoals: Boolean, goalsState: RestState): Boolean =
        hasGoals || goalsState.isAuthoritative || goalsState == RestState.Loading

    /** "N to buy" once a count has ever been confirmed; unknown otherwise. */
    fun groceryTrailing(count: Int, state: RestState): String? =
        if (state.isAuthoritative || state.updatedAt != null) "$count to buy" else null

    /** Empty copy only on an authoritative answer; a failure leaves the notice to speak. */
    fun emptyCopy(state: RestState, empty: String): String? = when {
        state.isAuthoritative -> empty
        state == RestState.Loading -> "Loading…"
        else -> null
    }
}

object KioskTodayFormat {
    private val formatters = ConcurrentHashMap<Pair<String, Locale>, DateTimeFormatter>()

    private fun formatter(pattern: String, locale: Locale): DateTimeFormatter =
        formatters.getOrPut(pattern to locale) { DateTimeFormatter.ofPattern(pattern, locale) }

    /** The agenda column: days from [today] on, ascending, at most seven. */
    fun week(byDay: Map<LocalDate, List<SyncedEvent>>, today: LocalDate): List<Pair<LocalDate, List<SyncedEvent>>> =
        byDay.keys.filter { it >= today }.sorted().take(7).map { it to byDay[it].orEmpty() }

    fun dayLabel(day: LocalDate, today: LocalDate, locale: Locale = Locale.getDefault()): String = when (day) {
        today -> "TODAY"
        today.plusDays(1) -> "TOMORROW"
        else -> formatter("EEEE · MMM d", locale).format(day).uppercase(locale)
    }

    /** "Thu" for a `yyyy-MM-dd` entry date; blank when it doesn't parse. */
    fun dayShort(date: String, locale: Locale = Locale.getDefault()): String = try {
        formatter("EEE", locale).format(LocalDate.parse(date))
    } catch (_: DateTimeParseException) {
        ""
    }

    /** iOS `WeekEntryDTO.displayTitle`. */
    fun dinnerTitle(entry: TodayApi.WeekEntry): String =
        entry.recipe?.title ?: entry.meal?.name ?: entry.title ?: "Planned meal"

    fun approvalsSubtitle(redemptions: List<FamilyApi.Redemption>, chores: List<FamilyApi.ChoreInstance>): String {
        val names = redemptions.map { "${it.personName ?: "Someone"}’s ${it.title}" } +
            chores.map { "${it.personName ?: "Someone"}’s ${it.choreTitle}" }
        val preview = names.take(3).joinToString(" · ")
        return if (preview.isEmpty()) "Your OK awards the stars." else "$preview — your OK awards the stars."
    }

    fun reviewSubtitle(titles: List<String>): String {
        val preview = titles.take(3).joinToString(" · ")
        return if (preview.isEmpty()) "Each ties to a goal." else "$preview — each ties to a goal."
    }
}

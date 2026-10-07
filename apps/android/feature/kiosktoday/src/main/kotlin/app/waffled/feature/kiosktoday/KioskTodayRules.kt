package app.waffled.feature.kiosktoday

import app.waffled.core.network.RestState
import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.family.FamilyApi
import app.waffled.feature.goals.GoalsApi
import app.waffled.feature.today.TodayApi
import java.time.LocalDate
import java.util.Locale

enum class KioskColumn { Agenda, Meals, ChoreGrocery, Goal }

enum class DashLayout(val raw: String, val label: String) {
    Balanced("", ""), Agenda("", ""), Meals("", ""), Goal("", "");

    val columns: List<Pair<KioskColumn, Float>> get() = emptyList()

    companion object {
        fun parse(raw: String?): DashLayout = Meals
    }
}

data class KioskDashPrefs(val layout: DashLayout, val pinnedGoalId: String) {
    fun pinning(goalId: String): KioskDashPrefs = this
}

object KioskGoalPick {
    fun featured(goals: List<GoalsApi.Goal>, pinnedId: String, memberIds: Set<String>): GoalsApi.Goal? = null
}

object KioskTodayRules {
    fun goalColumnShowsTonight(hasTonight: Boolean, mealsState: RestState): Boolean = false
    fun showsGoalCard(hasGoals: Boolean, goalsState: RestState): Boolean = false
    fun groceryTrailing(count: Int, state: RestState): String? = "?"
    fun emptyCopy(state: RestState, empty: String): String? = "?"
}

object KioskTodayFormat {
    fun week(byDay: Map<LocalDate, List<SyncedEvent>>, today: LocalDate): List<Pair<LocalDate, List<SyncedEvent>>> = emptyList()
    fun dayLabel(day: LocalDate, today: LocalDate, locale: Locale = Locale.getDefault()): String = ""
    fun dayShort(date: String, locale: Locale = Locale.getDefault()): String = "?"
    fun dinnerTitle(entry: TodayApi.WeekEntry): String = ""
    fun approvalsSubtitle(redemptions: List<FamilyApi.Redemption>, chores: List<FamilyApi.ChoreInstance>): String = ""
    fun reviewSubtitle(titles: List<String>): String = ""
}

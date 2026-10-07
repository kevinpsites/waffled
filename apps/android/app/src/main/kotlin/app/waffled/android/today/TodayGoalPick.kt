package app.waffled.android.today

import app.waffled.feature.goals.GoalsApi

/**
 * Which goal the Today hero shows — the port of iOS `KioskDashboard.featuredGoal`.
 *
 * Lives in `app` because the card is drawn by `feature:goals` while Today owns the slot;
 * neither module sees the other.
 */
object TodayGoalPick {

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

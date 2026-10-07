package app.waffled.android.today

import app.waffled.feature.goals.GoalsApi
import app.waffled.feature.today.TodayApi

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

    /** The picker draws Today's lean shape; the count stands in for the participant JSON. */
    fun toToday(g: GoalsApi.Goal): TodayApi.Goal = TodayApi.Goal(
        id = g.id,
        title = g.title,
        goalListId = g.goalListId,
        emoji = g.emoji,
        category = g.category,
        goalType = g.goalType,
        unit = g.unit,
        isFeatured = g.isFeatured,
        isSpotlight = g.isSpotlight,
        trackingMode = g.trackingMode,
        target = g.target,
        totalProgress = g.totalProgress,
        streakDays = g.streakDays,
        habitPeriod = g.habitPeriod,
        habitTargetPerPeriod = g.habitTargetPerPeriod,
        periodDone = g.periodDone,
        stepTotal = g.stepTotal,
        stepDone = g.stepDone,
        targetBasis = g.targetBasis,
        participantCount = g.participantCount,
    )

    fun toToday(l: GoalsApi.GoalList): TodayApi.GoalList = TodayApi.GoalList(
        id = l.id,
        name = l.name,
        emoji = l.emoji,
        colorHex = l.colorHex,
        goalCount = l.goalCount,
        members = l.members.map { TodayApi.GoalListMember(it.personId, it.name, it.avatarEmoji, it.colorHex) },
    )
}

package app.waffled.android.shell

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.android.AppContainer
import app.waffled.android.today.TodayGoalPick
import app.waffled.core.network.RefreshDomain
import app.waffled.feature.calendar.CountdownsCard
import app.waffled.feature.goals.GoalHeroCard
import app.waffled.feature.goals.GoalsApi
import app.waffled.feature.lists.TodayListCard
import app.waffled.feature.meals.MealDTO as MealsMeal
import app.waffled.feature.pantry.PantryTodayCard
import app.waffled.feature.recipes.RecipeSummary
import app.waffled.feature.today.TodayCards
import app.waffled.feature.today.TodayScreen

/**
 * The phone home — `feature:today` with every card slot the other features own.
 *
 * The iOS `TodayView` + its `HubDestination` pushes; pushes land on the Today tab's own
 * stack so Back returns to the dashboard.
 */
@Composable
fun TodayHost(container: AppContainer, actions: ShellActions, modifier: Modifier = Modifier) {
    val sync = container.syncManager
    val eventsByDay by sync.eventsByDay.collectAsStateWithLifecycle()
    val zone by sync.householdZone.collectAsStateWithLifecycle()
    val modules by sync.modules.collectAsStateWithLifecycle()
    val members by sync.members.collectAsStateWithLifecycle()
    val viewer by container.identity.viewer.collectAsStateWithLifecycle()
    val surfaceRev by container.surfaceRev.collectAsStateWithLifecycle()
    val revisions by container.refreshBus.state.collectAsStateWithLifecycle()

    var chorePick by remember { mutableStateOf(container.devicePrefs.todayChorePersonId) }
    val memberIds = remember(members) { members.mapTo(HashSet()) { it.id } }

    // The goals hero draws a goals-feature Goal; Today's own fetch is a thinner shape, so
    // the host reads the full list for the card (re-read on pull-down and on a goals write).
    val heroGoals by produceState<List<GoalsApi.Goal>?>(null, surfaceRev, revisions[RefreshDomain.Goals]) {
        value = runCatching { container.goalsApi.goalsIn(null) }.getOrNull() ?: value
    }

    val cards: Map<String, @Composable () -> Unit> = mapOf(
        TodayCards.COUNTDOWNS to {
            CountdownsCard(
                model = container.countdownsModel,
                onOpenEvent = { actions.selectTab(TAB_CALENDAR) },
            )
        },
        TodayCards.LISTS to {
            TodayListCard(
                model = container.todayListModel,
                onOpen = { actions.push(AppRoute.ListDetail(it)) },
                refreshKey = surfaceRev to revisions[RefreshDomain.Lists],
            )
        },
        TodayCards.PANTRY to {
            PantryTodayCard(
                model = container.pantryModel,
                onOpen = { actions.push(AppRoute.Pantry) },
                refreshKey = surfaceRev to revisions[RefreshDomain.Pantry],
            )
        },
        TodayCards.GOALS to {
            val goals = heroGoals.orEmpty()
            GoalHeroCard(
                goal = TodayGoalPick.featured(goals, container.devicePrefs.todayGoalId, memberIds),
                goalsLoaded = heroGoals != null,
                householdMemberIds = memberIds,
                myPersonId = viewer?.id,
                onOpen = { actions.push(AppRoute.Goal(it)) },
                onSeeAll = { actions.push(AppRoute.Goals) },
                // Logging lives on the detail screen; goals exposes no standalone log host.
                onLog = { actions.push(AppRoute.Goal(it)) },
            )
        },
    )

    TodayScreen(
        dash = container.dashboardModel,
        layout = container.todayLayoutModel,
        eventsByDay = eventsByDay,
        zone = zone,
        modules = modules,
        members = members,
        currentPersonId = viewer?.id,
        modifier = modifier,
        refreshBus = container.refreshBus,
        cardContent = cards,
        onOpenCalendar = { actions.selectTab(TAB_CALENDAR) },
        onOpenEvent = { actions.selectTab(TAB_CALENDAR) },
        onOpenChores = { actions.push(AppRoute.Chores) },
        onOpenGrocery = { actions.push(AppRoute.GROCERY) },
        onOpenReviewEvents = { actions.push(AppRoute.ReviewEvents) },
        onOpenRecipe = { r ->
            actions.push(AppRoute.Recipe(r.asSummary()))
        },
        onCookRecipe = { r -> actions.push(AppRoute.Recipe(r.asSummary(), autoCook = true)) },
        onOpenMeal = { m ->
            m.mealId?.let { actions.push(AppRoute.Meal(MealsMeal.placeholder(id = it, name = m.title))) }
        },
        onCookMeal = { m -> m.mealId?.let { id -> actions.cook { startPlate(id) } } },
        chorePick = chorePick,
        onChorePick = {
            chorePick = it
            container.devicePrefs.todayChorePersonId = it
        },
        onRefreshSurfaces = { container.refreshSurfaces() },
    )
}

private fun app.waffled.feature.today.TonightRecipe.asSummary() = RecipeSummary(
    id = id,
    title = title,
    emoji = emoji,
    category = category,
    cookTimeMinutes = cookTimeMinutes,
    servings = servings,
)

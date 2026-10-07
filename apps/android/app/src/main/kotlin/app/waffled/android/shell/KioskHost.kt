package app.waffled.android.shell

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.android.AppContainer
import app.waffled.core.model.WaffledModule
import app.waffled.feature.family.canApprove
import app.waffled.feature.goals.GoalLogHost
import app.waffled.feature.kiosk.KioskFamilyView
import app.waffled.feature.kiosk.KioskListsView
import app.waffled.feature.kiosk.KioskNav
import app.waffled.feature.kiosk.KioskPage
import app.waffled.feature.kiosk.KioskPageContent
import app.waffled.feature.kiosk.KioskRoot
import app.waffled.feature.kioskcalendar.KioskCalendarPage
import app.waffled.feature.kiosktoday.KioskTodayScreen
import app.waffled.feature.lists.ListDetailModel
import app.waffled.feature.lists.ListDetailScreen
import app.waffled.feature.meals.MealDTO as MealsMeal
import app.waffled.feature.recipes.RecipeSummary
import kotlinx.coroutines.launch
import java.time.LocalDate

/**
 * The tablet shell — `feature:kiosk`'s rail + pages, every page supplied here. Each page
 * keeps its drill-in stack in [ShellViewModel.kioskStacks], above `KioskRoot`, so leaving
 * a page and coming back restores it. Port of the iOS iPad `KioskShell` wiring.
 */
@Composable
fun KioskHost(container: AppContainer, shell: ShellViewModel, actions: ShellActions, onCapture: () -> Unit) {
    val sync = container.syncManager
    val modules by sync.modules.collectAsStateWithLifecycle()
    val rewardsSub by container.identity.rewardsEnabled.collectAsStateWithLifecycle()
    val rewardsOn = modules.rewardsOn(rewardsSub)

    fun page(nav: KioskNav, root: @Composable (ShellActions, KioskPage) -> Unit): KioskPageContent = { p ->
        KioskPageBody(container, shell, actions, nav, p, root)
    }

    val pages: Map<KioskNav, KioskPageContent> = mapOf(
        KioskNav.Today to page(KioskNav.Today) { a, p -> KioskTodayPage(container, a, p.navigate) },
        KioskNav.Calendar to page(KioskNav.Calendar) { _, _ ->
            KioskCalendarPage(
                model = container.calendarModel,
                countdowns = container.countdownsModel,
                api = container.calendarApi,
                kioskApi = container.kioskCalendarApi,
                openEventId = shell.pendingEventId,
                onOpenEventConsumed = { shell.pendingEventId = null },
            )
        },
        KioskNav.Tasks to page(KioskNav.Tasks) { a, _ -> RouteHost(AppRoute.Chores, container, a, showBack = false) },
        KioskNav.Rewards to page(KioskNav.Rewards) { a, _ -> RouteHost(AppRoute.Rewards, container, a, showBack = false) },
        KioskNav.Goals to page(KioskNav.Goals) { a, _ -> RouteHost(AppRoute.Goals, container, a, showBack = false) },
        KioskNav.Family to page(KioskNav.Family) { a, _ -> KioskFamilyPage(container, a) },
        KioskNav.Meals to page(KioskNav.Meals) { a, _ -> MealsHost(container, a) },
        KioskNav.Lists to page(KioskNav.Lists) { a, _ -> KioskListsPage(container, a) },
        KioskNav.Pantry to page(KioskNav.Pantry) { a, _ -> RouteHost(AppRoute.Pantry, container, a, showBack = false) },
        KioskNav.Rhythms to page(KioskNav.Rhythms) { a, _ -> RouteHost(AppRoute.Rhythms, container, a, showBack = false) },
        KioskNav.Photos to page(KioskNav.Photos) { a, _ -> RouteHost(AppRoute.Photos, container, a, showBack = false) },
        KioskNav.Planning to page(KioskNav.Planning) { a, _ -> RouteHost(AppRoute.Planning, container, a, showBack = false) },
        KioskNav.Settings to page(KioskNav.Settings) { a, _ -> RouteHost(AppRoute.Settings(), container, a, showBack = false) },
    )

    KioskRoot(
        sync = sync,
        kiosk = container.kioskMode,
        railStore = container.kioskRailStore,
        rewardsOn = rewardsOn,
        screensaver = container.screensaverModel,
        baseUrl = container.serverAddress.baseUrl(),
        pages = pages,
        onCapture = onCapture,
        onRetry = { container.restartSync() },
        onSignOut = actions.signOut,
        requestedNav = shell.kioskNavRequest,
        onRequestedNavConsumed = { shell.kioskNavRequest = null },
    )
}

/** One rail page: its root, or the top of its drill-in stack, with Back popping that stack. */
@Composable
private fun KioskPageBody(
    container: AppContainer,
    shell: ShellViewModel,
    actions: ShellActions,
    nav: KioskNav,
    page: KioskPage,
    root: @Composable (ShellActions, KioskPage) -> Unit,
) {
    val stacks = shell.kioskStacks.observeReset(nav, page.resetKey)
    if (stacks != shell.kioskStacks) SideEffect { shell.kioskStacks = stacks }

    val pageActions = remember(nav, page, actions) {
        ShellActions(
            push = { shell.kioskStacks = shell.kioskStacks.push(nav, it) },
            pop = { shell.kioskStacks = shell.kioskStacks.pop(nav) },
            replaceTop = { shell.kioskStacks = shell.kioskStacks.replaceTop(nav, it) },
            selectTab = { tab -> page.navigate(if (tab == TAB_CALENDAR) KioskNav.Calendar else KioskNav.Today) },
            cook = actions.cook,
            capture = actions.capture,
            signOut = actions.signOut,
            reloadApprovals = actions.reloadApprovals,
            openEvent = {
                shell.pendingEventId = it
                page.navigate(KioskNav.Calendar)
            },
            isKiosk = true,
        )
    }
    val top = stacks.top(nav)
    BackHandler(enabled = top != null) { pageActions.pop() }
    if (top == null) root(pageActions, page) else RouteHost(top, container, pageActions)
}

@Composable
private fun KioskTodayPage(container: AppContainer, actions: ShellActions, navigateTo: (KioskNav) -> Unit) {
    val sync = container.syncManager
    val eventsByDay by sync.eventsByDay.collectAsStateWithLifecycle()
    val zone by sync.householdZone.collectAsStateWithLifecycle()
    val modules by sync.modules.collectAsStateWithLifecycle()
    val members by sync.members.collectAsStateWithLifecycle()
    val viewer by container.identity.viewer.collectAsStateWithLifecycle()
    val rewardsSub by container.identity.rewardsEnabled.collectAsStateWithLifecycle()
    val sessionScope by container.sessionScope.collectAsStateWithLifecycle()
    var layoutRaw by remember { mutableStateOf(container.devicePrefs.kioskDashLayout) }
    var pinnedGoalId by remember { mutableStateOf(container.devicePrefs.kioskGoalId) }
    var logging by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    KioskTodayScreen(
        model = container.kioskTodayModel,
        eventsByDay = eventsByDay,
        zone = zone,
        modules = modules,
        members = members,
        currentPersonId = viewer?.id,
        layoutRaw = layoutRaw,
        pinnedGoalId = pinnedGoalId,
        onPrefsChange = { raw, goal ->
            layoutRaw = raw
            pinnedGoalId = goal
            container.devicePrefs.kioskDashLayout = raw
            container.devicePrefs.kioskGoalId = goal
        },
        navigate = { navigateTo(kioskNavFor(it)) },
        refreshBus = container.refreshBus,
        approvals = container.approvals,
        canApprove = canApprove(viewer),
        rewardsOn = modules.rewardsOn(rewardsSub),
        // The SAME key the shell loads the shared approvals queue under.
        dataScope = sessionScope,
        countdowns = container.countdownsModel,
        pantry = if (modules.isOn(WaffledModule.Pantry)) container.pantryModel(zone) else null,
        rhythms = if (modules.isOn(WaffledModule.Rhythms)) container.rhythmsModel else null,
        familyNight = container.familyNightModel,
        onCapture = { actions.capture(false) },
        onDictate = { actions.capture(true) },
        onOpenEvent = { actions.openEvent(it.id) },
        onOpenEventId = actions.openEvent,
        onOpenRecipe = { r -> actions.push(AppRoute.Recipe(r.asKioskSummary())) },
        onCookRecipe = { r -> actions.push(AppRoute.Recipe(r.asKioskSummary(), autoCook = true)) },
        onOpenMeal = { m -> m.mealId?.let { actions.push(AppRoute.Meal(MealsMeal.placeholder(id = it, name = m.title))) } },
        onCookMeal = { m -> m.mealId?.let { id -> actions.cook { startPlate(id) } } },
        onOpenGoal = { actions.push(AppRoute.Goal(it)) },
        onLogGoal = { logging = it.id },
        onOpenApprovals = { actions.push(AppRoute.Approvals) },
        onOpenReview = { actions.push(AppRoute.ReviewEvents) },
        onRefreshSurfaces = { container.refreshSurfaces() },
    )

    logging?.let { id ->
        GoalLogHost(
            goalId = id,
            api = container.goalsApi,
            onDone = { logging = null },
            meId = viewer?.id,
            refreshBus = container.refreshBus,
        )
    }
}

@Composable
private fun KioskFamilyPage(container: AppContainer, actions: ShellActions) {
    val sync = container.syncManager
    val members by sync.members.collectAsStateWithLifecycle()
    val eventsByDay by sync.eventsByDay.collectAsStateWithLifecycle()
    val zone by sync.householdZone.collectAsStateWithLifecycle()
    val modules by sync.modules.collectAsStateWithLifecycle()
    val revisions by container.refreshBus.state.collectAsStateWithLifecycle()
    KioskFamilyView(
        model = container.kioskFamilyModel,
        members = members,
        todayEvents = eventsByDay[LocalDate.now(zone)].orEmpty(),
        zone = zone,
        choresEnabled = modules.isOn(WaffledModule.Chores),
        onOpenPerson = { actions.push(AppRoute.Person(it)) },
        refreshKey = revisions,
    )
}

@Composable
private fun KioskListsPage(container: AppContainer, actions: ShellActions) {
    val context = LocalContext.current
    val revisions by container.refreshBus.state.collectAsStateWithLifecycle()
    KioskListsView(
        model = container.listsModel,
        detail = { summary ->
            val model = remember(summary.id) { ListDetailModel(summary, container.listsApi, container.refreshBus) }
            ListDetailScreen(
                model = model,
                onBack = {},
                onShare = { subject, text -> shareText(context, subject, text) },
                onCopy = { copyText(context, it) },
            )
        },
        refreshKey = revisions[app.waffled.core.network.RefreshDomain.Lists],
    )
}

private fun app.waffled.feature.today.TonightRecipe.asKioskSummary() = RecipeSummary(
    id = id,
    title = title,
    emoji = emoji,
    category = category,
    cookTimeMinutes = cookTimeMinutes,
    servings = servings,
)

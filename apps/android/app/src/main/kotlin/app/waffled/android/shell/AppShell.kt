package app.waffled.android.shell

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.android.AppContainer
import app.waffled.core.design.WF
import app.waffled.feature.recipes.CookModeScreen
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.lifecycle.viewmodel.compose.viewModel
import app.waffled.android.auth.SessionViewModel
import app.waffled.core.model.WaffledModule
import app.waffled.core.network.RefreshDomain
import app.waffled.feature.capture.CaptureEnvironment
import app.waffled.feature.capture.CaptureSheet
import app.waffled.feature.capture.rememberCaptureModel
import app.waffled.feature.settings.ServerUpdateModal
import kotlinx.coroutines.launch

/** Something the Activity's intent asks the shell to open. */
sealed interface LaunchRequest {
    /** A debug deep link: land on [tab] already pushed into [route]. */
    data class Route(val tab: String, val route: AppRoute) : LaunchRequest

    /** A tapped cook-timer notification: Cook Mode is already resumed, just raise it. */
    data object Cook : LaunchRequest

    /** A tapped event reminder. Calendar has no open-by-id hook yet, so it lands on the tab. */
    data class Event(val eventId: String) : LaunchRequest
}

/**
 * The phone shell: four tabs (+ the capture FAB), one push stack per tab, and Cook Mode
 * raised over everything — the iOS `AppRoot`.
 */
@Composable
fun AppShell(
    container: AppContainer,
    session: SessionViewModel,
    launch: LaunchRequest?,
    onLaunchHandled: () -> Unit,
) {
    val sync = container.syncManager
    val modules by sync.modules.collectAsStateWithLifecycle()
    val members by sync.members.collectAsStateWithLifecycle()
    val zone by sync.householdZone.collectAsStateWithLifecycle()
    val viewer by container.identity.viewer.collectAsStateWithLifecycle()
    val rewardsSub by container.identity.rewardsEnabled.collectAsStateWithLifecycle()
    val sessionScope by container.sessionScope.collectAsStateWithLifecycle()
    val revisions by container.refreshBus.state.collectAsStateWithLifecycle()
    val tabs = remember(modules) { FlexSlot.tabs(modules) }
    val shell: ShellViewModel = viewModel()
    var nav by shell::nav
    var cookShown by rememberSaveable { mutableStateOf(false) }
    // null = closed; otherwise whether the mic starts on open.
    var capture by rememberSaveable { mutableStateOf<Boolean?>(null) }
    val activity = LocalActivity.current
    val cook by container.cookStore.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val saveable = rememberSaveableStateHolder()

    // Only the synced tables go through PowerSync; identity + module flags are REST.
    LaunchedEffect(Unit) { container.syncManager.start() }
    LaunchedEffect(Unit) { container.refreshSurfaces() }
    // Touching it binds reminders to sync once per process.
    LaunchedEffect(Unit) { container.eventReminders }
    // A theme flip recreates the Activity; only a real exit (sign-out, session end) clears.
    DisposableEffect(Unit) {
        onDispose { if (activity?.isChangingConfigurations != true) container.identity.clear() }
    }

    val choresOn = modules.isOn(WaffledModule.Chores)
    val rewardsOn = modules.rewardsOn(rewardsSub)
    suspend fun loadApprovals() = container.approvals.load(sessionScope, choresOn, rewardsOn)
    // The one approvals queue feeds the hub badges, Today's banner and the screen — load
    // it here so none of them waits for a pull-to-refresh.
    LaunchedEffect(sessionScope, choresOn, rewardsOn, revisions[RefreshDomain.Chores], revisions[RefreshDomain.Rewards]) {
        loadApprovals()
    }

    LaunchedEffect(launch) {
        when (launch) {
            is LaunchRequest.Route -> nav = nav.open(launch.tab, launch.route)
            LaunchRequest.Cook -> cookShown = true
            is LaunchRequest.Event -> if (nav.tab != TAB_CALENDAR) nav = nav.select(TAB_CALENDAR)
            null -> return@LaunchedEffect
        }
        onLaunchHandled()
    }

    val actions = remember(sessionScope, choresOn, rewardsOn) {
        ShellActions(
            push = { nav = nav.push(it) },
            pop = { nav = nav.pop() ?: nav },
            replaceTop = { nav = nav.replaceTop(it) },
            selectTab = { nav = nav.select(it) },
            cook = { start ->
                scope.launch {
                    container.cookStore.start()
                    cookShown = true
                }
            },
            capture = { capture = it },
            signOut = {
                container.eventReminders.clearEventReminders()
                container.identity.clear()
                container.newSessionScope()
                session.signOut()
            },
            reloadApprovals = { loadApprovals() },
        )
    }

    // Back leaves Cook Mode running (iOS minimises it the same way); the session ends only
    // from Cook Mode's own ✕ / Finish.
    BackHandler(enabled = cookShown && cook.session != null) { cookShown = false }
    BackHandler(enabled = !cookShown && nav.top != null) { actions.pop() }

    Box(
        Modifier
            .fillMaxSize()
            .background(WF.colors.canvas),
    ) {
        Box(Modifier.fillMaxSize().statusBarsPadding()) {
            val stack = nav.stackOf(nav.tab)
            val top = nav.top
            // Each tab root and each pushed screen gets its own saveable-state slot, so the
            // Meals segment, a list's scroll position… survive a push/pop or a tab switch
            // the way an iOS NavigationStack keeps them. Keyed by the route too, so a new
            // screen at the same depth never inherits a popped one's state.
            val slot = if (top == null) "root/${nav.tab}" else "route/${nav.tab}/${stack.size}/$top"
            key(slot) {
                saveable.SaveableStateProvider(slot) {
                    if (top == null) TabRoot(nav.tab, container, actions) else RouteHost(top, container, actions)
                }
            }
        }

        WaffledTabBar(
            tabs = tabs,
            selected = tabs.firstOrNull { it.id == nav.tab } ?: tabs.first(),
            onSelect = { actions.selectTab(it.id) },
            onCapture = { capture = false },
            modifier = Modifier.align(Alignment.BottomCenter),
        )

        if (cookShown && cook.session != null) {
            CookModeScreen(
                store = container.cookStore,
                modifier = Modifier.fillMaxSize().background(WF.colors.canvas),
            )
        }
    }

    val captureModel = rememberCaptureModel(container.captureApi, container.refreshBus)
    capture?.let { dictate ->
        CaptureSheet(
            model = captureModel,
            environment = CaptureEnvironment(
                members = members,
                currentPersonId = viewer?.id,
                zone = zone,
                goalsOn = modules.isOn(WaffledModule.Goals),
                pantryOn = modules.isOn(WaffledModule.Pantry),
                rewardsOn = rewardsOn,
            ),
            onDismiss = { capture = null },
            autoDictate = dictate,
        )
    }

    // App-wide: the "newer server available" modal can appear over any screen.
    ServerUpdateModal(container.settingsApi, container.updateDismissal)
}

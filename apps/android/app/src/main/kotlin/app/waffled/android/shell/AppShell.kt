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
import kotlinx.coroutines.launch

/** Something the Activity's intent asks the shell to open. */
sealed interface LaunchRequest {
    /** A debug deep link: land on [tab] already pushed into [route]. */
    data class Route(val tab: String, val route: AppRoute) : LaunchRequest

    /** A tapped cook-timer notification: Cook Mode is already resumed, just raise it. */
    data object Cook : LaunchRequest
}

/**
 * The phone shell: four tabs (+ the capture FAB), one push stack per tab, and Cook Mode
 * raised over everything — the iOS `AppRoot`.
 */
@Composable
fun AppShell(
    container: AppContainer,
    launch: LaunchRequest?,
    onLaunchHandled: () -> Unit,
) {
    val modules by container.syncManager.modules.collectAsStateWithLifecycle()
    val tabs = remember(modules) { FlexSlot.tabs(modules) }
    var nav by remember { mutableStateOf(NavState<AppRoute>(tab = TAB_TODAY)) }
    var cookShown by remember { mutableStateOf(false) }
    val cook by container.cookStore.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val saveable = rememberSaveableStateHolder()

    // Only the synced tables go through PowerSync; identity + module flags are REST.
    LaunchedEffect(Unit) { container.syncManager.start() }
    LaunchedEffect(Unit) { container.refreshSurfaces() }
    DisposableEffect(Unit) { onDispose { container.identity.clear() } }

    LaunchedEffect(launch) {
        when (launch) {
            is LaunchRequest.Route -> nav = nav.open(launch.tab, launch.route)
            LaunchRequest.Cook -> cookShown = true
            null -> return@LaunchedEffect
        }
        onLaunchHandled()
    }

    val actions = remember {
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
            // The capture sheet is Wave C.
            onCapture = {},
            modifier = Modifier.align(Alignment.BottomCenter),
        )

        if (cookShown && cook.session != null) {
            CookModeScreen(
                store = container.cookStore,
                modifier = Modifier.fillMaxSize().background(WF.colors.canvas),
            )
        }
    }
}

package app.waffled.android.shell

import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.android.AppContainer
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.model.WaffledModule
import app.waffled.feature.calendar.CalendarScreen
import app.waffled.feature.chores.ChoresScreen
import app.waffled.feature.lists.ListsIndexScreen
import app.waffled.feature.photos.PhotosScreen
import app.waffled.feature.rewards.RewardsScreen

/**
 * Maps a tab to the screen that renders it.
 *
 * This file is why **device verification is the integrator's job, not a feature agent's**.
 * An agent can prove its screens compile and its logic is tested, but it cannot navigate
 * to them — nothing reaches a feature until it is wired here, and the `app` module is
 * outside every feature's ownership. Each merged feature gets composed on a real device from this
 * file before it counts as done.
 *
 * Features not yet ported render an honest placeholder rather than a blank tab.
 */
@Composable
fun FeatureHost(
    tab: TabSlot,
    container: AppContainer,
    modifier: Modifier = Modifier,
) {
    val bottom = Modifier.padding(bottom = WF.spacing.tabBarClearance)
    val members by container.syncManager.members.collectAsStateWithLifecycle()
    val viewer by container.syncManager.currentPerson.collectAsStateWithLifecycle()

    when (tab.id) {
        WaffledModule.Chores.key -> ChoresScreen(
            model = container.choresModel,
            members = members,
            viewer = viewer,
            modifier = modifier.then(bottom),
        )

        "calendar" -> CalendarScreen(
            model = container.calendarModel,
            countdowns = container.countdownsModel,
            api = container.calendarApi,
            modifier = modifier.then(bottom),
        )

        WaffledModule.Lists.key -> ListsIndexScreen(
            model = container.listsModel,
            // Opening a list is Wave B's navigation work; the index stands alone today.
            onOpen = {},
            modifier = modifier.then(bottom),
        )

        // TEMPORARY: composes the goal charts before the Goals feature lands, so the
        // drawing can be looked at. Removed once Goals owns this route.
        WaffledModule.Meals.key -> GoalChartPreview(modifier = modifier.then(bottom))

        "rewards" -> RewardsScreen(
            model = container.rewardsModel,
            me = viewer,
            modifier = modifier.then(bottom),
        )

        // ⚠️ TEMPORARY: the Family tab hosts Photos so the port had something real to
        // verify end to end. Family is its own 1,705-LOC feature — its agent reclaims
        // this tab, and Photos moves behind its own route.
        "family" -> PhotosScreen(
            model = container.photosModel,
            modifier = modifier.then(bottom),
        )

        else -> WaffledEmptyState(
            emoji = "🚧",
            title = "${tab.label} isn't ported yet",
            message = "This screen lands in a later wave.",
            modifier = modifier.then(bottom),
        )
    }
}

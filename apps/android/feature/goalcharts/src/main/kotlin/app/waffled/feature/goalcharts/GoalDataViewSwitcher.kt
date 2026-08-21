package app.waffled.feature.goalcharts

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledMenuPill
import app.waffled.core.design.wfField
import app.waffled.core.model.GoalSeries
import java.time.LocalDate
import java.time.YearMonth

/**
 * The goal-detail data-view switcher: offers only the views that fit this goal, remembers
 * which one is showing, and hosts the day / month drill-down sheets.
 *
 * **This module is pure presentation.** It fetches nothing and owns no ViewModel — a
 * [GoalSeries] goes in and a chart comes out. The Goals feature owns loading, membership
 * and logging; the two meet at `core:model` and neither depends on the other's module.
 *
 * ### What is optional and why
 *
 * [series] is the entire data contract. [title], [personNames] and [personEmoji] are
 * presentation labels `GoalSeries` does not carry (see the module's reported gaps) and
 * every chart renders correctly without them. [goalType] narrows the offered set to
 * iOS's own archetype table when the caller knows it; without it the set is derived from
 * the series' cadence, target, people and range.
 *
 * [selectedView] / [onSelectView] are hoisted so the Goals feature can persist the last
 * choice per goal (iOS keeps it in `UserDefaults` under `waffled.goalView.<goalId>`);
 * left alone, the choice simply lives for as long as the screen does.
 *
 * [today] is a parameter rather than `LocalDate.now()` on purpose — the household's
 * timezone is the caller's knowledge, and every bucket in here depends on getting it right.
 */
@Composable
fun GoalDataViewSwitcher(
    series: GoalSeries,
    modifier: Modifier = Modifier,
    today: LocalDate = LocalDate.now(),
    title: String = "",
    goalType: String? = null,
    personNames: Map<String, String> = emptyMap(),
    personEmoji: Map<String, String> = emptyMap(),
    selectedView: GoalViewKey? = null,
    onSelectView: (GoalViewKey) -> Unit = {},
) {
    val offered = remember(series, today, goalType) { offeredViews(series, today, goalType) }
    // A checklist-shaped goal has no meaningful visualisation; the existing steps card
    // already covers it, so draw nothing rather than an empty frame.
    if (offered.isEmpty()) return

    val chart = rememberGoalChart(series, today, title, personNames, personEmoji)
    var localView by remember(series, goalType) {
        mutableStateOf(defaultView(series, today, goalType))
    }
    val current = selectedView?.takeIf { it in offered }
        ?: localView?.takeIf { it in offered }
        ?: offered.first()

    var selectedDay by remember { mutableStateOf<LocalDate?>(null) }
    var selectedMonth by remember { mutableStateOf<YearMonth?>(null) }

    val pick: (GoalViewKey) -> Unit = { key ->
        localView = key
        onSelectView(key)
    }
    val menu: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {
        ViewMenu(offered = offered, current = current, onPick = pick)
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .wfField()
            .padding(WF.spacing.xxl),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.lg),
    ) {
        when (current) {
            GoalViewKey.Week -> WeekHeatmapView(chart, onDayTap = { selectedDay = it }, headerRight = menu)
            GoalViewKey.Month -> MonthHeatmapView(chart, onDayTap = { selectedDay = it }, headerRight = menu)
            GoalViewKey.Pace -> PaceChartView(chart, headerRight = menu)
            GoalViewKey.Year -> YearGridView(chart, onDayTap = { selectedDay = it }, headerRight = menu)
            GoalViewKey.ByPerson -> ByPersonBarsView(
                chart,
                onMonthTap = { y, m -> selectedMonth = YearMonth.of(y, m + 1) },
                headerRight = menu,
            )
            GoalViewKey.YearRing -> YearRingView(
                chart,
                onMonthTap = { y, m -> selectedMonth = YearMonth.of(y, m + 1) },
                headerRight = menu,
            )
            GoalViewKey.Collection -> CollectionGridView(chart, headerRight = menu)
            GoalViewKey.Consistency -> ConsistencyCalendarView(
                chart,
                onDayTap = { selectedDay = it },
                headerRight = menu,
            )
        }
    }

    selectedDay?.let { day ->
        GoalDayDetailSheet(chart = chart, day = day, onDismiss = { selectedDay = null })
    }
    selectedMonth?.let { month ->
        GoalMonthDetailSheet(chart = chart, month = month, onDismiss = { selectedMonth = null })
    }
}

/**
 * The view picker.
 *
 * A menu rather than a segmented control, for the reason iOS documents: this can offer up
 * to six labels, which no segmented control fits on a phone, and a horizontally scrolling
 * strip with a hidden scrollbar reads as broken rather than as scrollable. Uses the
 * app-wide [WaffledMenuPill] trigger — one of the two sanctioned menu families, not a third.
 */
@Composable
private fun ViewMenu(offered: List<GoalViewKey>, current: GoalViewKey, onPick: (GoalViewKey) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        WaffledMenuPill(
            text = current.label,
            modifier = Modifier.clickable { open = true },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            offered.forEach { key ->
                DropdownMenuItem(
                    text = { Text(key.label, color = WF.colors.ink) },
                    leadingIcon = if (key == current) {
                        { Icon(Icons.Filled.Check, contentDescription = null, tint = WF.colors.primary) }
                    } else {
                        null
                    },
                    onClick = {
                        open = false
                        onPick(key)
                    },
                )
            }
        }
    }
}

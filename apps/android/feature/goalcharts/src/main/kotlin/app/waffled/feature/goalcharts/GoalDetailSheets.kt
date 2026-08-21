package app.waffled.feature.goalcharts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.WF
import java.time.LocalDate
import java.time.YearMonth

/**
 * Tapping a day cell opens this: what was logged that day, broken down by person.
 *
 * iOS also lists the individual log entries (note, amount, who) from `goal.recent`.
 * `GoalSeries` carries no per-entry log — see the module's reported gaps — so this is the
 * per-person totals view iOS itself falls back to for days older than its recent window.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GoalDayDetailSheet(chart: GoalChart, day: LocalDate, onDismiss: () -> Unit) {
    val totals = chart.stats.byDay[day]
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(),
        containerColor = WF.colors.card,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(WF.spacing.xxl),
            verticalArrangement = Arrangement.spacedBy(WF.spacing.xl),
        ) {
            Text(longDay(day), style = WF.type.title, color = WF.colors.ink)
            Text(
                text = "${amount(totals?.total ?: 0, chart.unit)} logged",
                style = WF.type.size(13.sp, FontWeight.SemiBold),
                color = WF.colors.ink2,
            )
            if (totals == null) {
                // The absent-vs-zero distinction, spelled out: nothing was tracked here.
                Text(
                    "Nothing was tracked on this day.",
                    style = WF.type.size(13.sp, FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            } else if (totals.total == 0) {
                Text(
                    "Logged, but nothing counted toward the goal.",
                    style = WF.type.size(13.sp, FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
            PersonBreakdown(chart, totals?.perPerson.orEmpty())
            Spacer(Modifier.padding(bottom = WF.spacing.xxl))
        }
    }
}

/**
 * Tapping a by-person column or a year-ring wedge opens this. Those views are
 * MONTH-scoped — a segment is a whole month — so this shows the month's total and its
 * per-person split, not a single synthesised day.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GoalMonthDetailSheet(chart: GoalChart, month: YearMonth, onDismiss: () -> Unit) {
    val index = month.monthValue - 1
    val sameYear = month.year == chart.today.year
    val total = if (sameYear) chart.stats.byMonth[index] else 0
    val perPerson = if (sameYear) chart.stats.byMonthPerPerson[index] else emptyMap()

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(),
        containerColor = WF.colors.card,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(WF.spacing.xxl),
            verticalArrangement = Arrangement.spacedBy(WF.spacing.xl),
        ) {
            Text("${monthName(index)} ${month.year}", style = WF.type.title, color = WF.colors.ink)
            Text(
                text = "${amount(total, chart.unit)} logged",
                style = WF.type.size(13.sp, FontWeight.SemiBold),
                color = WF.colors.ink2,
            )
            if (total == 0) {
                Text(
                    "No activity logged this month.",
                    style = WF.type.size(13.sp, FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
            PersonBreakdown(chart, perPerson)
            Spacer(Modifier.padding(bottom = WF.spacing.xxl))
        }
    }
}

@Composable
private fun PersonBreakdown(chart: GoalChart, perPerson: Map<String, Int>) {
    val rows = chart.stats.personOrder.filter { (perPerson[it] ?: 0) > 0 }
    if (rows.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.md)) {
        rows.forEach { personId ->
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(WF.spacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AvatarFromHex(
                    colorHex = chart.series.personColors[personId],
                    emoji = chart.personEmoji[personId] ?: "🙂",
                    size = 26.dp,
                )
                Text(
                    chart.name(personId),
                    modifier = Modifier.weight(1f),
                    style = WF.type.size(13.sp, FontWeight.Bold),
                    color = WF.colors.ink,
                )
                Text(
                    amount(perPerson[personId] ?: 0, chart.unit),
                    style = WF.type.size(12.sp, FontWeight.Bold),
                    color = WF.colors.ink2,
                )
            }
        }
    }
}

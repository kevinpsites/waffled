package app.waffled.feature.planning

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.feature.planning.api.WeeklyPlanningView
import java.time.LocalDate

/** The Today card's state. Anything but these three renders nothing. */
enum class PlanningTodayPrompt {
    /** Today is the household's session day and nothing is started. */
    Due,

    /** A session is open — what makes a week somebody stepped out of findable. */
    InProgress,

    /** The session is saved: one quiet line. */
    Decided,
    Quiet;

    companion object {
        /**
         * [todayDow] is 0 = Sunday … 6 = Saturday in the HOUSEHOLD's zone, so a device a day
         * ahead of the house doesn't move the prompt. Nothing is decided before the first
         * fetch: a card that flashed "due" and then vanished is worse than a late one.
         */
        fun of(view: WeeklyPlanningView?, todayDow: Int): PlanningTodayPrompt {
            if (view == null || !view.config.showOnToday) return Quiet
            val session = view.session
            if (session != null) return if (session.isCompleted) Decided else InProgress
            return if (todayDow == ((view.config.dayOfWeek % 7) + 7) % 7) Due else Quiet
        }
    }
}

/**
 * Today card for Weekly Planning — the nudge, and the way back into a half-done week.
 * Port of iOS `PlanningTodayCard`. iOS renders it on the KIOSK dashboard only (meals
 * column, appended last), with no Today layout key; gate it on the `weeklyPlanning`
 * module at the call site. [onOpen] navigates: the card doesn't, because its hosts differ.
 */
@Composable
fun PlanningTodayCard(
    env: PlanningEnvironment,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
    kiosk: Boolean = false,
    /** Re-fetches when it changes — the host's refresh signal. */
    refreshKey: Any? = Unit,
) {
    val model = remember(env) { env.newModel() }
    val state by model.state.collectAsStateWithLifecycle()
    val zone by env.sync.householdZone.collectAsStateWithLifecycle()
    // Stays attached whatever the prompt, or a session started elsewhere can't appear.
    LaunchedEffect(model, refreshKey) { model.load() }

    // `DayOfWeek.value` is 1 = Monday … 7 = Sunday; `% 7` makes Sunday 0.
    val todayDow = LocalDate.now(zone).dayOfWeek.value % 7
    val prompt = PlanningTodayPrompt.of(state.view, todayDow)
    if (prompt == PlanningTodayPrompt.Quiet) return

    val total = state.runnable.size
    val headline = when (prompt) {
        PlanningTodayPrompt.Due -> "${state.sessionDayName}’s session"
        PlanningTodayPrompt.InProgress -> "The week is part-planned"
        else -> "The week is decided"
    }
    val detail = when (prompt) {
        PlanningTodayPrompt.Due -> "$total ${if (total == 1) "step" else "steps"}. Jump anywhere, leave whenever the week is decided."
        PlanningTodayPrompt.InProgress -> "${state.settledCount} of $total steps decided — pick it up whenever."
        else -> state.savedAtLabel?.let { "Saved $it." } ?: "Saved."
    }

    val body: @Composable () -> Unit = {
        Column(verticalArrangement = Arrangement.spacedBy(if (kiosk) 10.dp else 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "🗓️ Weekly planning",
                    style = if (kiosk) {
                        TextStyle(fontSize = 16.sp, fontWeight = FontWeight.ExtraBold)
                    } else {
                        TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold)
                    },
                    color = if (kiosk) WF.colors.ink else WF.colors.ink2,
                )
                Spacer(Modifier.weight(1f))
                Text(state.weekLabel, style = TextStyle(fontSize = if (kiosk) 13.sp else 12.sp), color = WF.colors.ink3)
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = WF.colors.ink3,
                    modifier = Modifier.size(if (kiosk) 18.dp else 16.dp),
                )
            }
            Text(
                headline,
                style = TextStyle(fontSize = if (kiosk) 19.sp else 15.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
            )
            Text(detail, style = TextStyle(fontSize = if (kiosk) 15.sp else 13.sp), color = WF.colors.ink3)
            if (prompt == PlanningTodayPrompt.InProgress && total > 0) {
                PlanningProgressBar(
                    value = state.progress,
                    height = if (kiosk) 7.dp else 5.dp,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
    }

    val tappable = modifier.clickable(onClick = onOpen)
    if (kiosk) {
        PlanningKioskCard(tappable) { body() }
    } else {
        WaffledCard(tappable, padding = 15.dp) { body() }
    }
}

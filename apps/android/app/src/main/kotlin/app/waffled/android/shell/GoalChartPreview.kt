package app.waffled.android.shell

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.waffled.core.model.GoalCadence
import app.waffled.core.model.GoalPoint
import app.waffled.core.model.GoalSeries
import app.waffled.feature.goalcharts.GoalDataViewSwitcher
import java.time.LocalDate

/**
 * TEMPORARY. Composes the goal visualisations with synthetic data so they can actually be
 * looked at — drawing code compiles cleanly and still looks wrong, and the agent that
 * built them could not render them. Delete once the Goals feature owns this route.
 */
@Composable
fun GoalChartPreview(modifier: Modifier = Modifier) {
    val today = remember { LocalDate.of(2026, 8, 21) }
    val series = remember {
        // A sparse-ish 90 days, so the quiet-vs-absent distinction is visible, with two
        // people so the per-person breakdown has something to draw.
        val points = (0..89).mapNotNull { back ->
            val day = today.minusDays(back.toLong())
            when {
                back % 7 == 3 -> null                     // never logged
                back % 5 == 0 -> GoalPoint(day, 0, "alice")  // logged, counted nothing
                back % 3 == 0 -> GoalPoint(day, 4 + back % 7, "bob")
                else -> GoalPoint(day, 1 + back % 9, "alice")
            }
        }
        GoalSeries(
            points = points,
            target = 500,
            cadence = GoalCadence.Daily,
            rangeStart = today.minusDays(89),
            rangeEnd = today,
            unit = "pages",
            personColors = mapOf("alice" to "#2F7FED", "bob" to "#E0548B"),
        )
    }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        GoalDataViewSwitcher(
            series = series,
            today = today,
            title = "Reading",
            personNames = mapOf("alice" to "Elaine", "bob" to "George"),
            personEmoji = mapOf("alice" to "\uD83D\uDC69", "bob" to "\uD83D\uDE01"),
        )
    }
}

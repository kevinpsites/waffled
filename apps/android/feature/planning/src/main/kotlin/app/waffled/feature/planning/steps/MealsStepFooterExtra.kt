package app.waffled.feature.planning.steps

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.feature.planning.PlanningStepProps
import kotlinx.coroutines.launch

/**
 * The Meals step's footer control: "✨ Plan the rest", which becomes "Undo the three" once a
 * fill has landed. It WRITES NOTHING itself — it opens the shared planner, which the BODY
 * presents (this control swaps mid-write). Same model as the body, via the store; the body,
 * not this view, reports busy, and no read is started here.
 */
@Composable
fun MealsStepFooterExtra(props: PlanningStepProps) {
    val storeKey = PlanningMealsStepStore.key(props.sessionId, props.weekStart)
    val model = remember(storeKey) { mealsStepModel(props) }
    val state by model.state.collectAsState()
    val scope = rememberCoroutineScope()
    if (state.view == null) return

    if (state.filled.isEmpty()) {
        val empties = state.emptyDates.size
        val off = props.busy || state.busy || empties == 0
        Row(
            Modifier
                // Nothing to fill is not an error, so the control states it rather than lying.
                .alpha(if (empties == 0) 0.5f else 1f)
                .clip(RoundedCornerShape(WF.radius.pill))
                .background(WF.colors.ai.copy(alpha = 0.10f))
                .clickable(enabled = !off) { model.openPlanner() }
                .semantics {
                    contentDescription = if (empties == 0) "Every night is planned" else PlanningMealsText.fillTitle(empties)
                }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (state.busy) {
                CircularProgressIndicator(Modifier.size(13.dp), color = WF.colors.ai, strokeWidth = 2.dp)
            } else {
                Text("✨", fontSize = 13.sp)
            }
            // Shorter than the web's label: three controls share one phone-width row.
            Text("Plan the rest", style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.Bold), color = WF.colors.aiD, maxLines = 1)
        }
    } else {
        Row(
            Modifier
                .clickable(enabled = !props.busy && !state.busy) {
                    scope.launch { if (model.undoTheFill(props.weekStart)) props.refresh() }
                }
                .padding(horizontal = 6.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (state.busy) CircularProgressIndicator(Modifier.size(13.dp), color = WF.colors.ink3, strokeWidth = 2.dp)
            Text(
                "Undo the ${PlanningMealsText.countWord(state.filled.size)}",
                style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink3,
                maxLines = 1,
            )
        }
    }
}

package app.waffled.feature.planning.steps

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.wfField
import app.waffled.feature.calendar.CalendarApi
import app.waffled.feature.calendar.CalendarModel
import app.waffled.feature.planning.PlanningEnvironment

// Pieces shared by the steps in this file set (Loose ends, Calendar, Horizon, Connection).

/** The server's own cap on a parked note (`parkItem`'s MAX_NOTE). */
internal const val PLANNING_NOTE_MAX = 500

/**
 * A one-line capture bar: a leading glyph, the field, and a trailing slot. Not disabled
 * while a write is in flight — focus on a disabled field is a silent no-op, and the bar
 * puts the cursor back after every note.
 */
@Composable
internal fun PlanningCaptureBar(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    glyph: String,
    onSubmit: () -> Unit,
    focus: FocusRequester,
    trailing: @Composable () -> Unit,
) {
    val style = TextStyle(fontSize = 15.sp, color = WF.colors.ink)
    Row(
        Modifier.wfField().padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(glyph, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Black), color = WF.colors.ink3)
        BasicTextField(
            value = value,
            onValueChange = { onValueChange(it.take(PLANNING_NOTE_MAX)) },
            singleLine = true,
            textStyle = style,
            cursorBrush = SolidColor(WF.colors.primary),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onSubmit() }),
            modifier = Modifier.weight(1f).focusRequester(focus),
            decorationBox = { inner ->
                Box {
                    if (value.isEmpty()) Text(placeholder, style = style.copy(color = WF.colors.ink3), maxLines = 1)
                    inner()
                }
            },
        )
        trailing()
    }
}

/** A bold text action, tinted, that greys out when [enabled] is false. */
@Composable
internal fun PlanningTextAction(label: String, enabled: Boolean, tint: androidx.compose.ui.graphics.Color, onClick: () -> Unit) {
    Text(
        label,
        modifier = Modifier.clickable(enabled = enabled, onClick = onClick),
        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
        color = if (enabled) tint else WF.colors.ink3,
    )
}

/**
 * The calendar's own derived model for one step's lifetime: the palette, members and zone
 * the Calendar tab paints with. `PlanningEnvironment` carries no calendar model, so each
 * step that draws events builds one from the synced flows and refreshes its REST half.
 */
@Composable
internal fun rememberPlanningCalendarModel(env: PlanningEnvironment): CalendarModel {
    val scope = rememberCoroutineScope()
    val model = remember(env) { CalendarModel(env.sync.eventsByDay, scope, env.sync.householdWeekStart) }
    val members by env.sync.members.collectAsState()
    val zone by env.sync.householdZone.collectAsState()
    LaunchedEffect(model, members) { model.setMembers(members) }
    LaunchedEffect(model, zone) { model.setZone(zone) }
    LaunchedEffect(model) { model.refresh(CalendarApi(env.client, env.tokens)) }
    return model
}

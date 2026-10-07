package app.waffled.feature.bites

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.wfField

/**
 * A capsule chip button — presets, sound/tone options, sleep-timer choices. Hand-rolled
 * as on iOS: `Pill` isn't tappable and `WeekdayToggleChip` is fixed-width, wrong for
 * variable-width labels. White on the filled state is the saturated-fill exception.
 */
@Composable
internal fun WBChip(
    label: String,
    modifier: Modifier = Modifier,
    filled: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Text(
        text = label,
        modifier = modifier
            .background(if (filled) WF.colors.primary else WF.colors.panel, RoundedCornerShape(WF.radius.pill))
            .clip(RoundedCornerShape(WF.radius.pill))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
        color = if (filled) Color.White else WF.colors.ink2,
    )
}

/**
 * A wrapping row of [WBChip]s. Coming-soon keys show dimmed and disabled rather than
 * hidden: a chip that taps fine and then does nothing reads as a broken device.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun WBChipFlow(
    items: List<String>,
    label: (String) -> String,
    isSelected: (String) -> Boolean,
    comingSoon: Set<String>,
    onSelect: (String) -> Unit,
) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items.forEach { key ->
            val soon = key in comingSoon
            WBChip(
                label = if (soon) "${label(key)} (soon)" else label(key),
                filled = isSelected(key),
                enabled = !soon,
                modifier = Modifier.alpha(if (soon) 0.45f else 1f),
            ) { onSelect(key) }
        }
    }
}

@Composable
internal fun WBToggleRow(
    label: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
    enabled: Boolean = true,
    style: TextStyle = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
    color: Color = WF.colors.ink,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = style, color = color, modifier = Modifier.weight(1f))
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            enabled = enabled,
            colors = SwitchDefaults.colors(checkedTrackColor = WF.colors.primary),
        )
    }
}

/**
 * The iOS `Stepper`: a label with − / + buttons. Material3 has no stepper control, so
 * this is hand-rolled on the panel chip shape.
 */
@Composable
internal fun WBStepper(
    label: String,
    value: Int,
    range: IntRange,
    step: Int = 1,
    onChange: (Int) -> Unit,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            label,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink2,
            modifier = Modifier.weight(1f),
        )
        Row(
            Modifier.background(WF.colors.panel, RoundedCornerShape(WF.radius.xs)),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StepButton(enabled = value > range.first, decrement = true) {
                onChange((value - step).coerceIn(range))
            }
            Box(Modifier.size(width = 1.dp, height = 18.dp).background(WF.colors.hair))
            StepButton(enabled = value < range.last, decrement = false) {
                onChange((value + step).coerceIn(range))
            }
        }
    }
}

@Composable
private fun StepButton(enabled: Boolean, decrement: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            if (decrement) Icons.Filled.Remove else Icons.Filled.Add,
            contentDescription = if (decrement) "Decrease" else "Increase",
            tint = if (enabled) WF.colors.ink else WF.colors.ink3,
            modifier = Modifier.size(18.dp),
        )
    }
}

/** The iOS compact `DatePicker(.hourAndMinute)`: a time field that opens a picker. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WBTimeField(minutes: Int, enabled: Boolean = true, onChange: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Text(
        WaffledBiteFormat.amPm(minutes),
        modifier = Modifier
            .wfField(radius = WF.radius.xs, fill = WF.colors.panel)
            .clickable(enabled = enabled) { open = true }
            .padding(horizontal = 12.dp, vertical = 7.dp),
        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
        color = WF.colors.ink,
    )
    if (open) {
        val state = rememberTimePickerState(initialHour = minutes / 60, initialMinute = minutes % 60)
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton(onClick = {
                    open = false
                    onChange(state.hour * 60 + state.minute)
                }) { Text("Done", color = WF.colors.primary) }
            },
            dismissButton = {
                TextButton(onClick = { open = false }) { Text("Cancel", color = WF.colors.ink2) }
            },
            containerColor = WF.colors.card,
            text = { Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { TimePicker(state = state) } },
        )
    }
}

/** A full-width status line on a tinted fill — device status and the wake-light state. */
@Composable
internal fun WBBanner(text: String, fg: Color, bg: Color) {
    Text(
        text,
        modifier = Modifier
            .fillMaxWidth()
            .background(bg, RoundedCornerShape(WF.radius.sm))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.Bold),
        color = fg,
    )
}

/** A nightlight colour swatch; the device's own LED colour, so a literal is correct. */
@Composable
internal fun WBSwatch(hex: Int, selected: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .size(34.dp)
            .background(Color(0xFF000000 or hex.toLong()), CircleShape)
            .then(if (selected) Modifier.border(2.5.dp, WF.colors.ink, CircleShape) else Modifier)
            .clip(CircleShape)
            .clickable(onClick = onClick),
    )
}

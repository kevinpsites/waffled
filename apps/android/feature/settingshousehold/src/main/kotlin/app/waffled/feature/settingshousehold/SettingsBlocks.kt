package app.waffled.feature.settingshousehold

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.FlowRowScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledSettingsMenuLabel
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/*
 * The building blocks every household panel shares — the Kotlin twins of the private
 * `card` / `rowLabel` / `menuRow` / `settingRow` helpers that each iOS Settings view
 * re-declares. They live here once instead of seven times.
 */

/** The scrolling page every panel sits in: canvas ground, 16pt gutter, tab-bar clearance. */
@Composable
internal fun SettingsPage(
    modifier: Modifier = Modifier,
    spacing: Dp = 16.dp,
    horizontal: Dp = 16.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(WF.colors.canvas)
            .verticalScroll(rememberScrollState())
            .padding(start = horizontal, end = horizontal, top = 16.dp, bottom = WF.spacing.tabBarClearance),
        verticalArrangement = Arrangement.spacedBy(spacing),
        content = content,
    )
}

/**
 * The flat settings card: card fill, md radius, hairline border, no shadow. Not
 * `WaffledCard` — that one is lg-radius with a drop shadow, which is the Today look;
 * the iOS settings panels draw this flatter card on purpose.
 */
@Composable
internal fun HairlineCard(
    modifier: Modifier = Modifier,
    padding: Dp = 14.dp,
    radius: Dp = WF.radius.md,
    fill: Color = WF.colors.card,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(radius)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(fill, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .padding(padding),
        content = content,
    )
}

@Composable
internal fun HairDivider() = HorizontalDivider(thickness = 1.dp, color = WF.colors.hair)

@Composable
internal fun RowLabel(title: String, sub: String, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(title, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
        Text(sub, style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
    }
}

@Composable
internal fun Caption(text: String, modifier: Modifier = Modifier, color: Color = WF.colors.ink3, size: Float = 12f) {
    Text(text, modifier = modifier, style = TextStyle(fontSize = size.sp), color = color)
}

/** A titled row whose value opens a menu — the iOS `Menu` + `WaffledSettingsMenuLabel`. */
@Composable
internal fun SettingsMenuRow(
    title: String,
    value: String,
    options: List<Pair<String, () -> Unit>>,
    enabled: Boolean = true,
    emptyText: String? = null,
) {
    var open by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled) { open = true }
            .padding(vertical = 15.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            title,
            modifier = Modifier.weight(1f),
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium),
            color = WF.colors.ink,
        )
        Box {
            WaffledSettingsMenuLabel(value)
            OptionsMenu(open, { open = false }, options, emptyText)
        }
    }
}

/** A dropdown of labelled actions; shared by every menu trigger in these panels. */
@Composable
internal fun OptionsMenu(
    expanded: Boolean,
    onDismiss: () -> Unit,
    options: List<Pair<String, () -> Unit>>,
    emptyText: String? = null,
    destructive: Set<String> = emptySet(),
) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        if (options.isEmpty() && emptyText != null) {
            DropdownMenuItem(text = { Text(emptyText, color = WF.colors.ink3) }, onClick = onDismiss, enabled = false)
        }
        options.forEach { (label, action) ->
            DropdownMenuItem(
                text = { Text(label, color = if (label in destructive) WF.colors.danger else WF.colors.ink) },
                onClick = { onDismiss(); action() },
            )
        }
    }
}

/** Emoji tile + title/subtitle + a trailing control — the Meals and Pantry row. */
@Composable
internal fun SettingRow(
    icon: String,
    title: String,
    sub: String,
    control: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(11.dp),
        horizontalArrangement = Arrangement.spacedBy(11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(34.dp).background(WF.colors.panel, RoundedCornerShape(9.dp)),
            contentAlignment = Alignment.Center,
        ) { Text(icon, style = TextStyle(fontSize = 17.sp)) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(title, style = TextStyle(fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            Text(sub, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
        }
        Spacer(Modifier.width(8.dp))
        control()
    }
}

@Composable
internal fun WFSwitch(checked: Boolean, onCheckedChange: (Boolean) -> Unit, enabled: Boolean = true) {
    Switch(
        checked = checked,
        onCheckedChange = onCheckedChange,
        enabled = enabled,
        colors = SwitchDefaults.colors(
            checkedTrackColor = WF.colors.primary,
            checkedThumbColor = Color.White,
            checkedBorderColor = WF.colors.primary,
            uncheckedTrackColor = WF.colors.panel,
            uncheckedThumbColor = WF.colors.ink3,
            uncheckedBorderColor = WF.colors.hair,
        ),
    )
}

/** A label with a trailing switch, padded like an iOS `Toggle` row. */
@Composable
internal fun ToggleRow(title: String, sub: String, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RowLabel(title, sub, Modifier.weight(1f))
        Spacer(Modifier.width(8.dp))
        WFSwitch(checked, onChange, enabled)
    }
}

/** A square checkbox glyph + label — the iOS `checkmark.square.fill` toggle. */
@Composable
internal fun CheckToggle(
    label: String,
    checked: Boolean,
    onToggle: () -> Unit,
    enabled: Boolean = true,
    size: Float = 14f,
    weight: FontWeight = FontWeight.SemiBold,
    color: Color = WF.colors.ink,
) {
    Row(
        modifier = Modifier.clickable(enabled = enabled, onClick = onToggle),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (checked) Icons.Filled.CheckBox else Icons.Filled.CheckBoxOutlineBlank,
            contentDescription = null,
            tint = if (checked) WF.colors.primary else WF.colors.ink3,
            modifier = Modifier.size((size + 4).dp),
        )
        Text(label, style = TextStyle(fontSize = size.sp, fontWeight = weight), color = color)
    }
}

/**
 * A solid selectable capsule. Not `wfChip` — iOS fills these with solid primary (white
 * label, correct on a saturated fill) where `wfChip` is a 12% tint; the panels match iOS.
 */
@Composable
internal fun SolidChip(label: String, on: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    Text(
        label,
        modifier = Modifier
            .clip(RoundedCornerShape(WF.radius.pill))
            .background(if (on) WF.colors.primary else WF.colors.panel)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
        color = if (on) Color.White else WF.colors.ink2,
    )
}

/** iOS `ChipFlow`: Compose's native `FlowRow` does the job. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ChipFlow(
    modifier: Modifier = Modifier,
    spacing: Dp = 8.dp,
    content: @Composable FlowRowScope.() -> Unit,
) {
    FlowRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(spacing),
        verticalArrangement = Arrangement.spacedBy(spacing),
        content = content,
    )
}

/** A small panel capsule button ("Add", "Disconnect", "Sync"). */
@Composable
internal fun CapsuleButton(
    text: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    color: Color = WF.colors.ink2,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(WF.radius.pill))
            .background(WF.colors.panel)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 11.dp, vertical = 6.dp)
            .alpha(if (enabled) 1f else 0.5f),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading?.invoke()
        Text(text, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold), color = color)
        trailing?.invoke()
    }
}

private val hhmm: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

/**
 * The iOS hour-and-minute `DatePicker`: the time as a tappable field that opens the
 * Material3 time picker. Values travel as `HH:mm` because that's the wire format.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TimeField(value: String, onChange: (String) -> Unit, enabled: Boolean = true) {
    var open by remember { mutableStateOf(false) }
    val time = remember(value) { runCatching { LocalTime.parse(value, hhmm) }.getOrDefault(LocalTime.NOON) }
    Text(
        DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault()).format(time),
        modifier = Modifier
            .clip(RoundedCornerShape(WF.radius.xs))
            .background(WF.colors.panel)
            .clickable(enabled = enabled) { open = true }
            .padding(horizontal = 11.dp, vertical = 7.dp)
            .alpha(if (enabled) 1f else 0.45f),
        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium),
        color = WF.colors.ink,
    )
    if (open) {
        val state = rememberTimePickerState(initialHour = time.hour, initialMinute = time.minute)
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton(onClick = {
                    open = false
                    onChange(hhmm.format(LocalTime.of(state.hour, state.minute)))
                }) { Text("Done", color = WF.colors.primary) }
            },
            dismissButton = { TextButton(onClick = { open = false }) { Text("Cancel", color = WF.colors.ink2) } },
            text = { TimePicker(state = state) },
            containerColor = WF.colors.card,
        )
    }
}

@Composable
internal fun Gap(height: Dp) = Spacer(Modifier.height(height))

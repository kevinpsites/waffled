package app.waffled.feature.familynight

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.RemoveCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledSettingsMenuLabel
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.wfField
import kotlinx.coroutines.launch

/**
 * Settings → Family Night: which weekday and time, an optional standing weekly calendar
 * event, and the agenda parts (emoji · label · rotates). Non-admins see it read-only.
 * Port of the iOS `FamilyNightSettingsView`; the host supplies the screen title.
 */
@Composable
fun FamilyNightSettingsScreen(
    model: FamilyNightSettingsModel,
    isAdmin: Boolean,
    modifier: Modifier = Modifier,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    LaunchedEffect(model) { model.load() }

    Column(
        modifier
            .fillMaxSize()
            .background(WF.colors.canvas)
            .verticalScroll(rememberScrollState())
            .padding(16.dp)
            .padding(bottom = WF.spacing.tabBarClearance),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        if (!isAdmin) {
            Text(
                "Only an admin can change Family Night.",
                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
        }
        state.errorMessage?.let { error ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(WF.colors.primary.copy(alpha = 0.1f), RoundedCornerShape(WF.radius.md))
                    .padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    error,
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.primaryD,
                    modifier = Modifier.weight(1f),
                )
                if (!state.loaded) {
                    Text(
                        "Retry",
                        modifier = Modifier.clickable { scope.launch { model.load() } }.padding(start = 8.dp),
                        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.primary,
                    )
                }
            }
        }
        when {
            state.loading -> WaffledLoading(top = 30.dp)
            state.loaded -> {
                ScheduleCard(state, isAdmin, onDay = { scope.launch { model.setDay(it) } }) {
                    scope.launch { model.setTime(it) }
                }
                CalendarCard(state, isAdmin) { scope.launch { model.setCalendar(it) } }
                AgendaCard(state, isAdmin, model) { scope.launch { model.saveAgenda() } }
            }
        }
    }
}

@Composable
private fun ScheduleCard(
    state: FamilyNightSettingsState,
    isAdmin: Boolean,
    onDay: (Int) -> Unit,
    onTime: (String) -> Unit,
) {
    val enabled = isAdmin && !state.busySchedule
    var dayMenu by remember { mutableStateOf(false) }
    WaffledCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionLabel("Happens on")
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .wfField()
                            .clickable(enabled = enabled) { dayMenu = true }
                            .padding(horizontal = 14.dp, vertical = 11.dp),
                    ) { WaffledSettingsMenuLabel(FamilyNightFormat.weekday(state.dayOfWeek)) }
                    DropdownMenu(expanded = dayMenu, onDismissRequest = { dayMenu = false }) {
                        (0..6).forEach { d ->
                            DropdownMenuItem(
                                text = { Text(FamilyNightFormat.weekday(d)) },
                                leadingIcon = if (d == state.dayOfWeek) {
                                    { Icon(Icons.Filled.Check, null) }
                                } else {
                                    null
                                },
                                onClick = {
                                    dayMenu = false
                                    onDay(d)
                                },
                            )
                        }
                    }
                }
                TimeField(state.time, enabled) { onTime(it) }
            }
        }
    }
}

/** The iOS compact time `DatePicker`: a field that opens a Material time picker. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TimeField(hhmm: String, enabled: Boolean, onChange: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Text(
        FamilyNightFormat.timeLabel(hhmm),
        modifier = Modifier
            .wfField()
            .clickable(enabled = enabled) { open = true }
            .padding(horizontal = 14.dp, vertical = 11.dp),
        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
        color = if (enabled) WF.colors.primary else WF.colors.ink3,
    )
    if (open) {
        val minutes = FamilyNightFormat.minutes(hhmm)
        val picker = rememberTimePickerState(initialHour = minutes / 60, initialMinute = minutes % 60)
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton(onClick = {
                    open = false
                    onChange(FamilyNightFormat.hhmm(picker.hour * 60 + picker.minute))
                }) { Text("Done", color = WF.colors.primary) }
            },
            dismissButton = { TextButton(onClick = { open = false }) { Text("Cancel", color = WF.colors.ink2) } },
            containerColor = WF.colors.card,
            text = { Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { TimePicker(state = picker) } },
        )
    }
}

@Composable
private fun CalendarCard(state: FamilyNightSettingsState, isAdmin: Boolean, onToggle: (Boolean) -> Unit) {
    WaffledCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "Show on the calendar",
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink,
                )
                Text(
                    "Adds a weekly “🏡 Family Night” event; syncs to Google if connected.",
                    style = TextStyle(fontSize = 12.sp),
                    color = WF.colors.ink3,
                )
            }
            Switch(
                checked = state.onCalendar,
                onCheckedChange = onToggle,
                enabled = isAdmin && !state.busyCalendar,
                colors = SwitchDefaults.colors(checkedTrackColor = WF.colors.primary),
                modifier = Modifier.padding(start = 8.dp),
            )
        }
    }
}

@Composable
private fun AgendaCard(
    state: FamilyNightSettingsState,
    isAdmin: Boolean,
    model: FamilyNightSettingsModel,
    onSave: () -> Unit,
) {
    WaffledCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionLabel("Agenda")
            Text(
                "Each part can rotate a different person through it every week.",
                style = TextStyle(fontSize = 12.sp),
                color = WF.colors.ink3,
            )
            state.parts.forEach { part ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    WaffledTextField(
                        value = part.emoji,
                        onValueChange = { v -> model.updatePart(part.id) { it.copy(emoji = FamilyNightFormat.emojiPrefix(v)) } },
                        placeholder = "⭐",
                        enabled = isAdmin,
                        modifier = Modifier.width(56.dp),
                    )
                    WaffledTextField(
                        value = part.label,
                        onValueChange = { v -> model.updatePart(part.id) { it.copy(label = v) } },
                        placeholder = "Label",
                        enabled = isAdmin,
                        modifier = Modifier.weight(1f),
                    )
                    Switch(
                        checked = part.rotates,
                        onCheckedChange = { on -> model.updatePart(part.id) { it.copy(rotates = on) } },
                        enabled = isAdmin,
                        colors = SwitchDefaults.colors(checkedTrackColor = WF.colors.primary),
                    )
                    if (isAdmin) {
                        Icon(
                            Icons.Filled.RemoveCircle,
                            contentDescription = "Remove ${part.label}",
                            tint = WF.colors.ink3,
                            modifier = Modifier.size(22.dp).clickable { model.removePart(part.id) },
                        )
                    }
                }
            }
            if (isAdmin) {
                Row(
                    Modifier.clickable { model.addPart() }.padding(top = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(Icons.Filled.Add, null, tint = WF.colors.ai, modifier = Modifier.size(18.dp))
                    Text("Add part", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ai)
                }
                WaffledPrimaryCTA(
                    label = if (state.savingAgenda) "Saving…" else "Save agenda",
                    onClick = onSave,
                    isDisabled = state.savingAgenda || state.parts.isEmpty(),
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}

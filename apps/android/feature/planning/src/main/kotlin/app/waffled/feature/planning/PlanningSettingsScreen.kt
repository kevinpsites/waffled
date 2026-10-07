package app.waffled.feature.planning

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.wfField
import app.waffled.core.model.WaffledModule
import app.waffled.feature.planning.api.PlanningConfigPatch
import app.waffled.feature.planning.api.PlanningStep
import app.waffled.feature.planning.api.WeeklyPlanningConfig
import kotlinx.coroutines.launch
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * Settings → Weekly Planning (the `SettingsPanelId.WEEKLY_PLANNING` slot): when the session
 * happens, which steps run, which lists step 1 asks about. Port of iOS
 * `PlanningSettingsView`. Every control sends ONLY the field that changed.
 *
 * A step whose module is off isn't offered as a choice, because it isn't one; those are
 * named in prose instead.
 */
@Composable
fun PlanningSettingsScreen(
    env: PlanningEnvironment,
    isAdmin: Boolean,
    modifier: Modifier = Modifier,
    refreshKey: Any? = Unit,
) {
    val model = remember(env) { env.newModel() }
    val state by model.state.collectAsStateWithLifecycle()
    val modules by env.sync.modules.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    LaunchedEffect(model, refreshKey) {
        model.load()
        // A second read for the list NAMES only — after `load`, so the panel draws first.
        model.loadListCandidates()
    }
    val locked = !isAdmin || state.busy
    val save: (PlanningConfigPatch) -> Unit = { patch -> scope.launch { model.saveConfig(patch) } }

    Column(
        modifier
            .fillMaxSize()
            .background(WF.colors.canvas)
            .verticalScroll(rememberScrollState())
            .padding(16.dp)
            .padding(bottom = WF.spacing.tabBarClearance),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        val config = state.config
        when {
            !modules.isOn(WaffledModule.WeeklyPlanning) -> Text(
                "Weekly Planning is off. Turn it on in Settings → Modules first.",
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
            config != null -> {
                if (!isAdmin) {
                    Text(
                        "Only an admin can change Weekly Planning.",
                        style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                }
                state.errorMessage?.let { DismissibleErrorBanner(it, model::dismissError) }
                ScheduleCard(config, locked, save)
                TodayToggleCard(config, locked, save)
                StepsCard(config, state.steps, locked, save)
                UnavailableNote(config, state.steps)
                ListsCard(config, state, locked, save)
            }
            state.loaded -> Text(
                "Couldn’t load the planning settings.",
                modifier = Modifier.padding(vertical = 30.dp),
                style = TextStyle(fontSize = 14.sp),
                color = WF.colors.ink3,
            )
            else -> WaffledLoading(top = 40.dp)
        }
    }
}

@Composable
private fun ScheduleCard(config: WeeklyPlanningConfig, locked: Boolean, save: (PlanningConfigPatch) -> Unit) {
    WaffledCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionLabel("Session happens on")
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                DayMenu(config.dayOfWeek, locked, Modifier.weight(1f)) { save(PlanningConfigPatch(dayOfWeek = it)) }
                TimeField(config.time, locked) { hhmm ->
                    // Picking the time already set must not PUT the config back.
                    if (hhmm != config.time) save(PlanningConfigPatch(time = hhmm))
                }
            }
            Text(
                "When to nudge the family to sit down. The session always plans the week ahead — which seven days that is follows your household’s first day of the week.",
                style = TextStyle(fontSize = 12.sp),
                color = WF.colors.ink3,
            )
        }
    }
}

@Composable
private fun DayMenu(day: Int, locked: Boolean, modifier: Modifier, onPick: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        Row(
            Modifier
                .fillMaxWidth()
                .wfField()
                .clickable(enabled = !locked) { open = true }
                .padding(horizontal = 14.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                PlanningFormat.planningDayName(day),
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
            )
            Icon(Icons.Filled.KeyboardArrowDown, null, tint = WF.colors.ink, modifier = Modifier.size(14.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            (0..6).forEach { d ->
                DropdownMenuItem(
                    text = { Text(PlanningFormat.planningDayName(d)) },
                    trailingIcon = if (d == day) ({ Icon(Icons.Filled.Check, null) }) else null,
                    onClick = {
                        open = false
                        onPick(d)
                    },
                )
            }
        }
    }
}

/** The saved "HH:MM", shown in the device's short time style; a native picker sets it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TimeField(hhmm: String, locked: Boolean, onPick: (String) -> Unit) {
    // 17:00 is the server's own default, reached only if a stored time fails to parse.
    val time = runCatching { LocalTime.parse(hhmm) }.getOrDefault(LocalTime.of(17, 0))
    var open by remember { mutableStateOf(false) }
    Text(
        time.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)),
        modifier = Modifier
            .wfField()
            .clickable(enabled = !locked) { open = true }
            .padding(horizontal = 14.dp, vertical = 11.dp),
        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
        color = WF.colors.ink,
    )
    if (open) {
        val picker = rememberTimePickerState(initialHour = time.hour, initialMinute = time.minute)
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton(onClick = {
                    open = false
                    onPick(String.format(Locale.ROOT, "%02d:%02d", picker.hour, picker.minute))
                }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { open = false }) { Text("Cancel") } },
            text = { TimePicker(state = picker) },
        )
    }
}

@Composable
private fun TodayToggleCard(config: WeeklyPlanningConfig, locked: Boolean, save: (PlanningConfigPatch) -> Unit) {
    WaffledCard(padding = 14.dp) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "Show on the family display’s Today",
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink,
                )
                // Named for the surface it affects: the card is drawn on the kiosk only.
                Text(
                    "A card on the session day on the family display, and a way back into a week that’s part-planned. The phone reaches the session from the Family tab.",
                    style = TextStyle(fontSize = 12.sp),
                    color = WF.colors.ink3,
                )
            }
            PlanningSwitch(config.showOnToday, !locked) { save(PlanningConfigPatch(showOnToday = it)) }
        }
    }
}

/** Everything with no module behind it, module on, or already switched off by hand. */
internal fun choosableSteps(config: WeeklyPlanningConfig, steps: List<PlanningStep>): List<PlanningStep> =
    steps.filter { it.requiresModule == null || it.available || config.steps[it.key] == false }

/** Unavailable purely because its module is off — named in prose, not a dead toggle. */
internal fun stepsOffForModule(config: WeeklyPlanningConfig, steps: List<PlanningStep>): List<PlanningStep> =
    steps.filter { it.requiresModule != null && config.steps[it.key] != false && !it.available }

@Composable
private fun StepsCard(config: WeeklyPlanningConfig, steps: List<PlanningStep>, locked: Boolean, save: (PlanningConfigPatch) -> Unit) {
    WaffledCard(padding = 4.dp) {
        CardHeader("Steps", "Turn off anything your family doesn’t do — the session skips it and never counts it.")
        choosableSteps(config, steps).forEachIndexed { i, step ->
            if (i > 0) HorizontalDivider(color = WF.colors.hair)
            ToggleRow(
                title = step.title,
                checked = config.steps[step.key] != false,
                enabled = !locked,
                label = "Include ${step.title} in the session",
            ) { on -> save(PlanningConfigPatch(steps = mapOf(step.key to on))) }
        }
    }
}

@Composable
private fun UnavailableNote(config: WeeklyPlanningConfig, steps: List<PlanningStep>) {
    val off = stepsOffForModule(config, steps)
    if (off.isEmpty()) return
    Text(
        "Not in the session because the module it reads is off: ${off.joinToString(", ") { it.title }}.",
        style = TextStyle(fontSize = 12.sp),
        color = WF.colors.ink3,
    )
}

/**
 * Only LISTS get this choice: an overdue chore is late by definition, but an unchecked
 * row on a long-lived list is that list working. Hidden when there is nothing to choose.
 */
@Composable
private fun ListsCard(config: WeeklyPlanningConfig, state: PlanningState, locked: Boolean, save: (PlanningConfigPatch) -> Unit) {
    if (state.listCandidates.isEmpty()) return
    WaffledCard(padding = 4.dp) {
        CardHeader(
            "Lists it asks about",
            "The first step asks about anything still unchecked from before this week. Turn off a list that’s meant to stay open — a someday list, a wishlist — and it stops coming up every session. Your grocery list is never asked about: it rebuilds itself from the meal plan.",
        )
        state.listCandidates.forEachIndexed { i, list ->
            if (i > 0) HorizontalDivider(color = WF.colors.hair)
            ToggleRow(
                title = listOfNotNull(list.emoji, list.name).joinToString(" "),
                checked = config.asksAbout(list.id),
                enabled = !locked,
                label = "Ask about ${list.name} in the weekly planning session",
            ) { on -> save(PlanningConfigPatch(lists = mapOf(list.id to on))) }
        }
    }
}

@Composable
private fun CardHeader(title: String, subtitle: String) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(start = 11.dp, end = 11.dp, top = 11.dp, bottom = 6.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(title, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
        Text(subtitle, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
    }
}

@Composable
private fun ToggleRow(title: String, checked: Boolean, enabled: Boolean, label: String, onChange: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 11.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        Text(
            title,
            modifier = Modifier.weight(1f),
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink,
        )
        PlanningSwitch(checked, enabled, Modifier.semantics { contentDescription = label }, onChange)
    }
}

/** Native Material3 switch, coral when on — iOS `Toggle().tint(WF.primary)`. */
@Composable
private fun PlanningSwitch(
    checked: Boolean,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onChange: (Boolean) -> Unit,
) {
    Switch(
        checked = checked,
        onCheckedChange = onChange,
        enabled = enabled,
        modifier = modifier,
        colors = SwitchDefaults.colors(checkedTrackColor = WF.colors.primary),
    )
}

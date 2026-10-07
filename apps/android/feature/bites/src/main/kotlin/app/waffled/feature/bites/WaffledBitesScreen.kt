package app.waffled.feature.bites

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledFieldCard
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.WeekdayToggleChip
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * The Waffled-Bite parent control panel, pushed from a person's page. Mirrors the iOS
 * `WaffledBitesView` section for section: device status, quiet time, wake-light
 * schedule, nightlight, sound machine, morning alarm, a timer, screen, and unpair.
 *
 * Polls every 10s while the screen is at least STARTED, matching the web panel; with the
 * device's own ~5s poll that bounds device-to-parent lag at roughly 15s.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WaffledBitesScreen(
    model: WaffledBitesModel,
    personName: String,
    onUnpaired: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var refreshing by remember { mutableStateOf(false) }
    var confirmUnpair by remember { mutableStateOf(false) }

    LaunchedEffect(model) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            model.load()
            PollLoop.run(everyMillis = 10_000) { model.load() }
        }
    }
    LaunchedEffect(state.device?.id) {
        if (state.device == null) return@LaunchedEffect
        while (true) {
            delay(1_000)
            model.tick()
        }
    }

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            scope.launch {
                refreshing = true
                model.load()
                refreshing = false
            }
        },
        modifier = modifier.fillMaxSize().background(WF.colors.canvas),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(top = 8.dp, bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            val device = state.device
            when {
                state.loading -> WaffledLoading()
                device != null -> PairedPanel(
                    device = device,
                    state = state,
                    model = model,
                    onUnpair = { confirmUnpair = true },
                )
                else -> WaffledEmptyState(
                    emoji = "🧇",
                    title = "No Waffled-Bite paired yet",
                    message = "Pair $personName's Waffled-Bite from their profile page to control it here.",
                )
            }
            state.errorMessage?.let { DismissibleErrorBanner(message = it, onDismiss = model::dismissError) }
        }
    }

    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text("Unpair this Waffled-Bite?") },
            text = {
                Text("$personName will lose their nightlight, quiet-time, and wake-light settings. This can't be undone.")
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmUnpair = false
                    scope.launch { if (model.unpair()) onUnpaired() }
                }) { Text("Unpair", color = WF.colors.danger) }
            },
            dismissButton = {
                TextButton(onClick = { confirmUnpair = false }) { Text("Cancel", color = WF.colors.ink2) }
            },
            containerColor = WF.colors.card,
        )
    }
}

@Composable
private fun PairedPanel(
    device: WaffledBitesApi.Device,
    state: WaffledBitesState,
    model: WaffledBitesModel,
    onUnpair: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    fun act(block: suspend WaffledBitesModel.() -> Unit) {
        scope.launch { model.block() }
    }
    val settings = device.settings.withDefaults()

    DeviceStatusBanner(device)
    CountdownCard(
        title = "Quiet time",
        badge = true,
        countdown = device.runtimeState.quiet,
        remaining = state.quietRemaining,
        presets = WaffledBiteOptions.quietPresetsMin,
        defaultMinutes = "5",
        onStart = { m -> act { startQuiet(m) } },
        onPause = { act { pauseQuiet() } },
        onResume = { act { resumeQuiet() } },
        onAddTime = { act { addQuietTime() } },
        onEnd = { act { endQuiet() } },
    )
    WakeLightCard(device, settings.schedules) { act { setSchedules(it) } }
    NightlightCard(settings.night, ::act)
    SoundCard(settings.sound, ::act)
    AlarmCard(settings.alarm, ::act)
    CountdownCard(
        title = "Set a timer",
        badge = false,
        countdown = device.runtimeState.timer,
        remaining = state.timerRemaining,
        presets = WaffledBiteOptions.timerPresetsMin,
        defaultMinutes = "10",
        onStart = { m -> act { startTimer(m) } },
        onPause = { act { pauseTimer() } },
        onResume = { act { resumeTimer() } },
        onAddTime = { act { addTimerTime() } },
        onEnd = { act { endTimer() } },
    )
    DisplayCard(settings.display, ::act)
    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.dangerT, RoundedCornerShape(WF.radius.lg))
            .clickable(enabled = !state.busy, onClick = onUnpair)
            .padding(15.dp),
    ) {
        Text(
            "🔌 Unpair this Waffled-Bite",
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.danger,
        )
    }
}

// ---- device status --------------------------------------------------------------

@Composable
private fun DeviceStatusBanner(device: WaffledBitesApi.Device) {
    // Re-evaluated every 30s so a screen left open flips online → offline on its own.
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = Instant.now()
        }
    }
    if (WaffledBiteStatus.isOnline(device.lastSeenAt, now)) {
        WBBanner("🟢 Online", WF.colors.success, WF.colors.successT)
    } else {
        WBBanner("🔴 Offline · ${WaffledBiteFormat.lastSeen(device.lastSeenAt, now)}", WF.colors.danger, WF.colors.dangerT)
    }
}

// ---- quiet time / timer (same shape, different presets) ---------------------------

@Composable
private fun CountdownCard(
    title: String,
    badge: Boolean,
    countdown: WaffledBitesApi.Countdown,
    remaining: Int,
    presets: List<Int>,
    defaultMinutes: String,
    onStart: (Int) -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onAddTime: () -> Unit,
    onEnd: () -> Unit,
) {
    var showCustom by remember { mutableStateOf(false) }
    var hoursText by remember { mutableStateOf("0") }
    var minutesText by remember { mutableStateOf(defaultMinutes) }

    WaffledFieldCard(title = title) {
        if (badge) WaffledStatusBadge(text = "MOST USED", color = WF.colors.primary)
        if (countdown.active) {
            Text(
                WaffledBiteFormat.hms(remaining),
                style = TextStyle(fontSize = 34.sp, fontWeight = FontWeight.Black),
                color = WF.colors.ink,
            )
            Text(
                if (countdown.running) "Counting down on the device" else "Paused",
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                WBChip(if (countdown.running) "Pause" else "Resume") {
                    if (countdown.running) onPause() else onResume()
                }
                WBChip("+5 min", onClick = onAddTime)
                WBChip("End now", filled = true, onClick = onEnd)
            }
        } else {
            ChipRow {
                presets.forEach { m -> WBChip(WaffledBiteOptions.presetLabel(m)) { onStart(m) } }
            }
            if (showCustom) {
                // 180 min is the server ceiling; past it just clamps at Start.
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    HmField(hoursText, "hr", onChange = { hoursText = it }, onBlur = { hoursText = HmEntry.normalized(hoursText) })
                    HmField(
                        minutesText,
                        "min",
                        onChange = { minutesText = it },
                        onBlur = { minutesText = HmEntry.normalized(minutesText, cap = 59) },
                    )
                    WBChip("Start", filled = true) {
                        onStart(HmEntry.value(hoursText) * 60 + HmEntry.value(minutesText, cap = 59))
                    }
                }
            } else {
                WBChip("Custom ＋") { showCustom = true }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChipRow(content: @Composable () -> Unit) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) { content() }
}

@Composable
private fun HmField(text: String, unit: String, onChange: (String) -> Unit, onBlur: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        WaffledTextField(
            value = text,
            onValueChange = { v -> onChange(v.filter(Char::isDigit).take(3)) },
            placeholder = "0",
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier
                .width(64.dp)
                .onFocusChanged { f ->
                    // Observed on the wrapper, so it is the child field's focus: hasFocus.
                    if (focused && !f.hasFocus) onBlur()
                    focused = f.hasFocus
                },
        )
        Text(unit, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
    }
}

// ---- wake-light schedule ------------------------------------------------------------

/** A schedule plus a local-only id, so removing a row never edits the wrong one. */
private data class EditableSchedule(val id: Long, val schedule: WaffledBitesApi.Schedule)

private val DOW = listOf(0 to "S", 1 to "M", 2 to "T", 3 to "W", 4 to "T", 5 to "F", 6 to "S")

@Composable
private fun WakeLightCard(
    device: WaffledBitesApi.Device,
    schedules: List<WaffledBitesApi.Schedule>,
    commit: (List<WaffledBitesApi.Schedule>) -> Unit,
) {
    var nextId by remember { mutableStateOf(0L) }
    var rows by remember { mutableStateOf(emptyList<EditableSchedule>()) }
    LaunchedEffect(schedules) {
        rows = schedules.map { EditableSchedule(nextId++, it) }
    }
    fun save(updated: List<EditableSchedule>) {
        rows = updated
        commit(updated.map { it.schedule })
    }
    fun update(id: Long, mutate: (WaffledBitesApi.Schedule) -> WaffledBitesApi.Schedule) {
        if (rows.none { it.id == id }) return
        save(rows.map { if (it.id == id) it.copy(schedule = mutate(it.schedule)) else it })
    }

    WaffledFieldCard(title = "Wake-light schedule") {
        when (device.runtimeState.wakeLight.state) {
            "sleep" -> WBBanner("🌙 Asleep right now", SleepColors.ink(), SleepColors.tint())
            "warn" -> WBBanner("🟡 Almost time to wake", WF.colors.warn, WF.colors.warnT)
            "wake" -> WBBanner("🟢 Awake — can exit the wake screen", WF.colors.success, WF.colors.successT)
        }
        rows.forEachIndexed { index, row ->
            ScheduleRow(row, removable = rows.size > 1, update = ::update) {
                save(rows.filterNot { it.id == row.id })
            }
            if (index != rows.lastIndex) HorizontalDivider(color = WF.colors.hair)
        }
        if (rows.isEmpty()) {
            Text(
                "No schedule set yet",
                style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
        }
        WBChip("＋ Add another schedule") {
            save(rows + EditableSchedule(nextId++, WaffledBitesApi.Schedule(days = emptyList(), wakeMin = 7 * 60, leadMin = 10)))
        }
    }
}

@Composable
private fun ScheduleRow(
    row: EditableSchedule,
    removable: Boolean,
    update: (Long, (WaffledBitesApi.Schedule) -> WaffledBitesApi.Schedule) -> Unit,
    onRemove: () -> Unit,
) {
    val s = row.schedule
    val labelStyle = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    Column(Modifier.padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            DOW.forEach { (day, label) ->
                WeekdayToggleChip(label = label, isOn = day in s.days, onClick = {
                    update(row.id) { cur ->
                        cur.copy(days = if (day in cur.days) cur.days - day else (cur.days + day).sorted())
                    }
                })
            }
        }
        WBToggleRow(
            label = "Bedtime",
            checked = s.bedtimeMin != null,
            style = labelStyle,
            color = WF.colors.ink2,
            onChange = { on -> update(row.id) { it.copy(bedtimeMin = if (on) (it.bedtimeMin ?: 20 * 60) else null) } },
        )
        val bedtime = s.bedtimeMin
        if (bedtime != null) {
            TimeRow("Bedtime", bedtime) { m -> update(row.id) { it.copy(bedtimeMin = m) } }
        } else {
            Text(
                "No bedtime set — this rule shows the day toggle above but never locks the device.",
                style = TextStyle(fontSize = 12.sp),
                color = WF.colors.ink3,
            )
        }
        TimeRow("Okay to get up", s.wakeMin) { m -> update(row.id) { it.copy(wakeMin = m) } }
        WBStepper("Yellow warning starts ${s.leadMin} min before", s.leadMin, 0..30) { v ->
            update(row.id) { it.copy(leadMin = v) }
        }
        if (removable) {
            Text(
                "Remove",
                modifier = Modifier.clickable(onClick = onRemove),
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.danger,
            )
        }
    }
}

@Composable
private fun TimeRow(label: String, minutes: Int, onChange: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            label,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink2,
            modifier = Modifier.weight(1f),
        )
        WBTimeField(minutes, onChange = onChange)
    }
}

// ---- nightlight / sound / alarm / display -------------------------------------------

private typealias Act = (suspend WaffledBitesModel.() -> Unit) -> Unit

@Composable
private fun NightlightCard(night: WaffledBitesApi.Night, act: Act) {
    WaffledFieldCard(title = "Nightlight") {
        WBToggleRow("On", night.on, onChange = { on -> act { setNightOn(on) } })
        if (night.on) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                WaffledBiteOptions.nightColors.forEach { c ->
                    WBSwatch(c.hex, selected = night.color == c.key) { act { setNightColor(c.key) } }
                }
            }
            WBStepper("Brightness ${night.brightness}%", night.brightness, 1..100, step = 5) { v ->
                act { setNightBrightness(v) }
            }
        }
    }
}

@Composable
private fun SoundCard(sound: WaffledBitesApi.Sound, act: Act) {
    WaffledFieldCard(title = "Sound machine") {
        WBToggleRow(
            if (sound.on) WaffledBiteOptions.soundLabel(sound.sound) else "Off",
            sound.on,
            onChange = { on -> act { setSoundOn(on) } },
        )
        if (sound.on) {
            WBChipFlow(
                items = WaffledBiteOptions.sounds.map { it.key },
                label = WaffledBiteOptions::soundLabel,
                isSelected = { it == sound.sound },
                comingSoon = WaffledBiteOptions.soundsComingSoon,
            ) { key -> act { setSoundOption(key) } }
            WBStepper("Volume ${sound.volume}%", sound.volume, 0..100, step = 5) { v -> act { setSoundVolume(v) } }
            ChipRow {
                WaffledBiteOptions.sleepTimerChipsMin.forEach { m ->
                    WBChip(
                        if (m == 0) "Off" else WaffledBiteOptions.presetLabel(m),
                        filled = sound.timerMin == m,
                    ) { act { setSoundSleepTimer(m) } }
                }
            }
        }
    }
}

@Composable
private fun AlarmCard(alarm: WaffledBitesApi.Alarm, act: Act) {
    val totalMin = alarm.hour * 60 + alarm.min
    WaffledFieldCard(title = "Morning alarm") {
        WBToggleRow(
            if (alarm.on) WaffledBiteFormat.amPm(totalMin) else "Off",
            alarm.on,
            onChange = { on -> act { setAlarmOn(on) } },
        )
        if (alarm.on) {
            WBTimeField(totalMin) { m -> act { setAlarmTime(m / 60, m % 60) } }
            WBChipFlow(
                items = WaffledBiteOptions.alarmTones.map { it.key },
                label = WaffledBiteOptions::toneLabel,
                isSelected = { it == alarm.tone },
                comingSoon = WaffledBiteOptions.alarmTonesComingSoon,
            ) { key -> act { setAlarmTone(key) } }
            // Its own volume, separate from the sound machine's: a wake tone has to be
            // heard through sleep, where a sound machine has to be ignorable.
            WBStepper("Volume ${alarm.volumeOrDefault}%", alarm.volumeOrDefault, 0..100, step = 5) { v ->
                act { setAlarmVolume(v) }
            }
        }
    }
}

@Composable
private fun DisplayCard(display: WaffledBitesApi.Display, act: Act) {
    WaffledFieldCard(title = "Screen & display") {
        WBStepper("Brightness ${display.brightness}%", display.brightness, 10..100, step = 10) { v ->
            act { setDisplayBrightness(v) }
        }
        WBToggleRow("Screen goes dark at night", display.nightDim, onChange = { on -> act { setDisplayNightDim(on) } })
    }
}

/**
 * The wake-light "asleep" hue. iOS and web use a dedicated purple pair (`#4A3F73` on
 * `#E7E1F0`) that has no `WF` token; the frozen palette's AI purple is the nearest token
 * pair, used until a sleep token lands in the design system.
 */
internal object SleepColors {
    @Composable fun ink() = WF.colors.aiD

    @Composable fun tint() = WF.colors.aiT
}

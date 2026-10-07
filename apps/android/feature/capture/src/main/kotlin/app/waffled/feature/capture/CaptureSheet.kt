package app.waffled.feature.capture

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.RemoveCircle
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.WaffledIcons
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledSecondaryCTA
import app.waffled.core.design.wfChip
import app.waffled.core.design.wfField
import app.waffled.core.model.Capability
import app.waffled.core.network.RefreshBus
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/** A [CaptureModel] scoped to the caller's composition. */
@Composable
fun rememberCaptureModel(service: CaptureService, refreshBus: RefreshBus?): CaptureModel {
    val scope = rememberCoroutineScope()
    return remember(service, refreshBus) { CaptureModel(service, scope, refreshBus) }
}

/**
 * "Add anything" — type or dictate free text, see Waffled's read, confirm, and it commits.
 * The port of iOS `CaptureSheet`. Present it from the FAB or the Today capture bar; it
 * dismisses itself (via [onDismiss]) after a successful commit.
 *
 * [autoDictate] starts the mic on open (the capture bar's mic tap).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CaptureSheet(
    model: CaptureModel,
    environment: CaptureEnvironment,
    onDismiss: () -> Unit,
    autoDictate: Boolean = false,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = WF.colors.canvas,
    ) {
        CaptureSheetContent(model, environment, onDismiss, autoDictate)
    }
}

/** The sheet body without the bottom-sheet chrome — for a host that supplies its own. */
@Composable
fun CaptureSheetContent(
    model: CaptureModel,
    environment: CaptureEnvironment,
    onDismiss: () -> Unit,
    autoDictate: Boolean = false,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val inputFocus = remember { FocusRequester() }
    val dictation = remember { Dictation(context.applicationContext) }
    val listening by dictation.isListening.collectAsStateWithLifecycle()
    val transcript by dictation.transcript.collectAsStateWithLifecycle()

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) dictation.start() else dictation.markUnavailable()
    }
    fun toggleMic() {
        if (listening) return dictation.stop()
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (granted) dictation.start() else permission.launch(Manifest.permission.RECORD_AUDIO)
    }
    fun parse() {
        dictation.stop()
        focus.clearFocus()
        model.parse()
    }

    LaunchedEffect(environment) { model.updateEnvironment(environment) }
    LaunchedEffect(Unit) {
        model.updateEnvironment(environment)
        // Focus (or the mic) FIRST so the keyboard is instant; warm-up and pickers load behind it.
        if (autoDictate) toggleMic() else runCatching { inputFocus.requestFocus() }
        model.onOpen()
    }
    LaunchedEffect(transcript) { if (transcript.isNotEmpty()) model.setText(transcript) }
    LaunchedEffect(state.done) { if (state.done) onDismiss() }
    // State otherwise survives a dismiss, leaving the last parse filled in on reopen.
    DisposableEffect(Unit) { onDispose { dictation.destroy(); model.reset() } }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp)
            .padding(bottom = 20.dp)
            .navigationBarsPadding(),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Header(onCancel = onDismiss)
        state.error?.let { Text(it, style = TextStyle(fontSize = 13.sp), color = WF.colors.primaryD) }
        when (state.phase) {
            CapturePhase.Input, CapturePhase.Parsing -> InputView(
                state = state,
                listening = listening,
                inputFocus = inputFocus,
                onText = model::setText,
                onMic = ::toggleMic,
                onParse = ::parse,
            )
            CapturePhase.Preview, CapturePhase.Committing -> when {
                state.draft.kind == "mutate" -> MutatePreview(state, model, onEditText = {
                    model.editText()
                    runCatching { inputFocus.requestFocus() }
                })
                state.editing -> EditorView(state, model)
                else -> GlanceView(state, model)
            }
        }
    }
}

// ---- header & input ----------------------------------------------------------------

@Composable
private fun Header(onCancel: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(WaffledIcons.Sparkles, contentDescription = null, tint = WF.colors.ai, modifier = Modifier.size(15.dp))
        Text("Add with AI", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ai)
        Spacer(Modifier.weight(1f))
        Text(
            "Cancel",
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink2,
            modifier = Modifier.clickable(onClick = onCancel),
        )
    }
}

@Composable
private fun InputView(
    state: CaptureUiState,
    listening: Boolean,
    inputFocus: FocusRequester,
    onText: (String) -> Unit,
    onMic: () -> Unit,
    onParse: () -> Unit,
) {
    val parsing = state.phase == CapturePhase.Parsing
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(contentAlignment = Alignment.BottomEnd) {
            val shape = RoundedCornerShape(WF.radius.lg)
            val style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = WF.colors.ink)
            BasicTextField(
                value = state.text,
                onValueChange = onText,
                textStyle = style,
                minLines = 3,
                maxLines = 8,
                cursorBrush = SolidColor(WF.colors.primary),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { if (state.text.isNotBlank()) onParse() }),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(inputFocus)
                    .background(WF.colors.panel, shape)
                    .padding(16.dp)
                    .padding(end = 40.dp),
                decorationBox = { inner ->
                    if (state.text.isEmpty()) {
                        Text("Soccer practice Tuesday at 4pm for Wally…", style = style, color = WF.colors.ink3)
                    }
                    inner()
                },
            )
            // White on the saturated primary fill is correct; idle sits on card with ink2.
            Box(
                modifier = Modifier
                    .padding(10.dp)
                    .size(34.dp)
                    .background(if (listening) WF.colors.primary else WF.colors.card, CircleShape)
                    .border(1.dp, if (listening) Color.Transparent else WF.colors.hair, CircleShape)
                    .clickable(onClick = onMic),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    WaffledIcons.Mic,
                    contentDescription = if (listening) "Stop dictation" else "Dictate",
                    tint = if (listening) Color.White else WF.colors.ink2,
                    modifier = Modifier.size(15.dp),
                )
            }
        }
        WaffledPrimaryCTA(
            label = if (parsing) "Thinking…" else "Tell Waffled",
            onClick = onParse,
            tint = WF.colors.ai,
            isBusy = parsing,
            isDisabled = state.text.isBlank(),
        )
    }
}

// ---- glance ------------------------------------------------------------------------

@Composable
private fun GlanceView(state: CaptureUiState, model: CaptureModel) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GlanceCard(state)
        state.serverAlt?.let { AltRow(it, state.altProviderLabel, onUse = model::switchToAlt) }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                modifier = Modifier
                    .weight(1f)
                    .background(WF.colors.panel, RoundedCornerShape(WF.radius.md))
                    .clickable(onClick = model::startEditing)
                    .padding(vertical = 14.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Tune, contentDescription = null, tint = WF.colors.ink, modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(6.dp))
                Text("Edit", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            }
            CommitButton(state, model, Modifier.weight(1f))
        }
    }
}

@Composable
private fun CommitButton(state: CaptureUiState, model: CaptureModel, modifier: Modifier) {
    WaffledPrimaryCTA(
        label = state.addLabel,
        onClick = model::commit,
        modifier = modifier,
        isBusy = state.phase == CapturePhase.Committing,
        isDisabled = !state.canCommit,
    )
}

@Composable
private fun KindLine(label: String, trailing: @Composable () -> Unit = {}) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            label.uppercase(),
            style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.4.sp),
            color = WF.colors.ai,
        )
        trailing()
    }
}

@Composable
private fun GlanceCard(state: CaptureUiState) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .wfField(radius = WF.radius.lg)
            .padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WaffledEmojiTile(emoji = state.kindIcon)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            KindLine(state.draft.kind) {
                if (state.thinking) {
                    CircularProgressIndicator(Modifier.size(10.dp), color = WF.colors.ai, strokeWidth = 1.5.dp)
                    Text("improving…", style = micro, color = WF.colors.ai)
                } else if (state.viaLabel.isNotEmpty()) {
                    Text(state.viaLabel, style = micro, color = WF.colors.ink3)
                }
            }
            Text(
                state.draft.name.ifEmpty { state.namePlaceholder },
                style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
            )
            val detail = state.glanceDetail
            if (detail.isNotEmpty()) Text(detail, style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink2)
        }
        state.environment.member(state.draft.person)?.let { AvatarFromHex(it.colorHex, it.displayEmoji, size = 32.dp) }
    }
}

/** When the LLM and the on-device guess disagree on the kind, offer the other take. */
@Composable
private fun AltRow(alt: CaptureIntent, provider: String, onUse: () -> Unit) {
    val s = CaptureSummary.of(alt)
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(WF.colors.ai.copy(alpha = 0.08f), shape)
            .border(1.dp, WF.colors.ai.copy(alpha = 0.25f), shape)
            .clickable(onClick = onUse)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(WaffledIcons.Sparkles, contentDescription = null, tint = WF.colors.ai, modifier = Modifier.size(14.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                "$provider reads it as a ${s.kind.lowercase()}",
                style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ai,
            )
            Text(s.primary, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink, maxLines = 1)
        }
        Text("Use it", style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold), color = WF.colors.ai)
    }
}

// ---- editor ------------------------------------------------------------------------

@Composable
private fun EditorView(state: CaptureUiState, model: CaptureModel) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .wfField(radius = WF.radius.lg)
                .padding(14.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            WaffledEmojiTile(emoji = state.kindIcon)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                KindLine(state.draft.kind) {
                    if (state.viaLabel.isNotEmpty()) Text(state.viaLabel, style = micro, color = WF.colors.ink3)
                }
                InnerField(
                    value = state.draft.name,
                    onChange = { v -> model.updateDraft { it.copy(name = v) } },
                    placeholder = state.namePlaceholder,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold),
                )
                KindFields(state, model)
            }
        }
        TypeSwitcher(state.draft.kind) { k -> model.updateDraft { it.copy(kind = k) } }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            WaffledSecondaryCTA(label = "Edit text", onClick = model::editText, modifier = Modifier.weight(1f))
            CommitButton(state, model, Modifier.weight(1f))
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun KindFields(state: CaptureUiState, model: CaptureModel) {
    val d = state.draft
    val env = state.environment
    fun edit(t: (CaptureDraft) -> CaptureDraft) = model.updateDraft(t)
    when (d.kind) {
        "event" -> {
            PersonChips(state, noneLabel = "🚫 Nobody") { p -> edit { it.copy(person = p) } }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                DateChip(d.eventDate) { v -> edit { it.copy(eventDate = v) } }
                if (!d.allDay) TimeChip(d.eventTime) { v -> edit { it.copy(eventTime = v) } }
            }
            ToggleChip("All day", d.allDay) { edit { it.copy(allDay = !it.allDay) } }
            RepeatFields(d, onRepeat = { r -> edit { it.copy(repeat = r) } }, onUntilOn = { edit { it.copy(untilOn = !it.untilOn) } }) { v ->
                edit { it.copy(until = v) }
            }
        }
        "task" -> {
            PersonChips(state, noneLabel = "🙌 Up for grabs") { p -> edit { it.copy(person = p) } }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(state.rewardLabel, style = label13, color = WF.colors.ink2)
                Stepper(d.taskStars) { v -> edit { it.copy(taskStars = v) } }
                if (state.currencies.size > 1) {
                    MenuChip(
                        label = state.currencies.firstOrNull { it.key == d.taskCurrency }?.displaySymbol ?: "★",
                        options = state.currencies.map { "${it.displaySymbol} ${it.displayLabel}" to it.key },
                    ) { k -> edit { it.copy(taskCurrency = k) } }
                }
            }
        }
        "grocery" -> InnerField(d.quantity, { v -> edit { it.copy(quantity = v) } }, "quantity (optional, e.g. 2 lbs)")
        "list" -> {
            MenuChip(
                label = d.listName.ifEmpty { "Choose a list" },
                options = state.lists.map { "${it.emoji ?: "📝"} ${it.name}" to it.name },
                fill = true,
            ) { n -> edit { it.copy(listName = n) } }
            InnerField(d.quantity, { v -> edit { it.copy(quantity = v) } }, "quantity (optional)")
        }
        "meal" -> {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("breakfast", "lunch", "dinner", "snack").forEach { mt ->
                    SelectChip(mt.replaceFirstChar { it.uppercase() }, d.mealSlot == mt) { edit { it.copy(mealSlot = mt) } }
                }
            }
            DateChip(d.mealDate) { v -> edit { it.copy(mealDate = v) } }
        }
        "countdown" -> DateChip(d.countdownDate) { v -> edit { it.copy(countdownDate = v) } }
        "person" -> {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("adult" to "Adult", "teen" to "Teen", "kid" to "Kid").forEach { (key, label) ->
                    SelectChip(label, d.personType == key) { edit { it.copy(personType = key) } }
                }
            }
            if (state.personBlocked) BlockedNote("Only an adult can add family members.")
        }
        "goal" -> {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("count" to "Count", "total" to "Total", "habit" to "Habit", "checklist" to "Checklist").forEach { (key, label) ->
                    SelectChip(label, d.goalType == key) { edit { it.copy(goalType = key) } }
                }
            }
            if (d.goalType == "count" || d.goalType == "total") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    InnerField(d.goalTarget, { v -> edit { it.copy(goalTarget = v) } }, "target", Modifier.widthIn(max = 96.dp), number = true)
                    InnerField(d.goalUnit, { v -> edit { it.copy(goalUnit = v) } }, "unit (e.g. books)", Modifier.weight(1f))
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                ToggleChip("By a date", d.goalDeadlineOn) { edit { it.copy(goalDeadlineOn = !it.goalDeadlineOn) } }
                if (d.goalDeadlineOn) DateChip(d.goalDeadline) { v -> edit { it.copy(goalDeadline = v) } }
            }
            // A viewer without goal.manage (kids) can only make a just-me goal — the route
            // rejects other participants — so Everyone isn't offered.
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SelectChip("🙋 Just me", !d.goalEveryone) { edit { it.copy(goalEveryone = false) } }
                if (env.can(Capability.GOAL_MANAGE)) {
                    SelectChip("👨‍👩‍👧 Everyone", d.goalEveryone) { edit { it.copy(goalEveryone = true) } }
                }
            }
            if (state.goalBlocked) BlockedNote("Goals is turned off. Turn it on in Settings → Modules.")
        }
        "pantry" -> {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                InnerField(d.pantryAmount, { v -> edit { it.copy(pantryAmount = v) } }, "amount", Modifier.widthIn(max = 96.dp))
                InnerField(d.pantryUnit, { v -> edit { it.copy(pantryUnit = v) } }, "unit (e.g. cans)", Modifier.weight(1f))
            }
            val locations = listOf("Pantry", "Fridge", "Freezer").let { base ->
                if (d.pantryLocation.isNotEmpty() && d.pantryLocation !in base) base + d.pantryLocation else base
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                locations.forEach { loc -> SelectChip(loc, d.pantryLocation == loc) { edit { it.copy(pantryLocation = loc) } } }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                ToggleChip("Expires", d.pantryExpiresOn) { edit { it.copy(pantryExpiresOn = !it.pantryExpiresOn) } }
                if (d.pantryExpiresOn) DateChip(d.pantryExpires) { v -> edit { it.copy(pantryExpires = v) } }
            }
            if (state.pantryBlocked) BlockedNote("The Pantry module is turned off. Turn it on in Settings → Modules.")
        }
        "reward" -> {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                InnerField(d.rewardEmoji, { v -> edit { it.copy(rewardEmoji = v) } }, "emoji", Modifier.widthIn(max = 72.dp))
                InnerField(d.rewardCost, { v -> edit { it.copy(rewardCost = v) } }, "cost (stars)", Modifier.widthIn(max = 120.dp), number = true)
            }
            ToggleChip("Needs approval", d.rewardRequiresApproval == true) {
                edit { it.copy(rewardRequiresApproval = it.rewardRequiresApproval != true) }
            }
            if (state.rewardBlocked) BlockedNote(state.rewardBlockedReason)
        }
    }
}

@Composable
private fun RepeatFields(
    d: CaptureDraft,
    onRepeat: (CaptureRepeat) -> Unit,
    onUntilOn: () -> Unit,
    onUntil: (LocalDate) -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Repeats", style = label13, color = WF.colors.ink2)
        val choices = listOf(
            CaptureRepeatFreq.None, CaptureRepeatFreq.Daily, CaptureRepeatFreq.Weekdays,
            CaptureRepeatFreq.Weekly, CaptureRepeatFreq.Monthly, CaptureRepeatFreq.Yearly,
        )
        MenuChip(label = d.repeat.freq.label, options = choices.map { it.label to it.name }) { name ->
            val f = CaptureRepeatFreq.valueOf(name)
            // Weekly keeps any parsed days; every other choice starts clean.
            onRepeat(if (f == CaptureRepeatFreq.Weekly) d.repeat.copy(freq = f, custom = "") else CaptureRepeat(f))
        }
    }
    if (d.repeat.freq != CaptureRepeatFreq.None) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            ToggleChip("Ends on", d.untilOn, onUntilOn)
            if (d.untilOn) DateChip(maxOf(d.until, d.eventDate), minDate = d.eventDate, onPick = onUntil)
        }
    }
}

// ---- mutate ------------------------------------------------------------------------

@Composable
private fun MutatePreview(state: CaptureUiState, model: CaptureModel, onEditText: () -> Unit) {
    val d = state.draft
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .wfField(radius = WF.radius.lg)
                .padding(14.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WaffledEmojiTile(emoji = MutateLabels.icon(d.mutateVerb))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                KindLine(MutateLabels.verbLabel(d.mutateVerb)) {
                    Text(MutateLabels.targetLabel(d.mutateTargetKind), style = micro, color = WF.colors.ink3)
                }
                Text(d.name, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                val summary = state.mutateArgsSummary
                if (summary.isNotEmpty()) Text(summary, style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink2)
            }
        }
        val resolved = state.mutateState?.takeIf { it.forKey == state.mutateResolveKey }
        when {
            resolved == null -> Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(vertical = 6.dp),
            ) {
                CircularProgressIndicator(Modifier.size(14.dp), color = WF.colors.ink3, strokeWidth = 2.dp)
                Text("Finding a ${MutateLabels.targetLabel(d.mutateTargetKind)} like that…", style = label13, color = WF.colors.ink3)
            }
            resolved.offline -> MutateHint("I need a connection for that.")
            resolved.candidates.isEmpty() -> MutateHint(MutateLabels.emptyHint(resolved.unsupported, resolved.disabledReason, d.mutateTargetKind))
            else -> Column(
                modifier = Modifier
                    .heightIn(max = 260.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                resolved.candidates.forEach { c -> CandidateRow(c, c.id == state.mutateChosenId) { model.chooseCandidate(c.id) } }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            WaffledSecondaryCTA(label = "Edit text", onClick = onEditText, modifier = Modifier.weight(1f))
            if (state.mutateChosenId != null) {
                // Delete gets the danger tint — its own explicit tap, never implicit.
                WaffledPrimaryCTA(
                    label = MutateLabels.confirmLabel(d.mutateVerb),
                    onClick = model::commit,
                    modifier = Modifier.weight(1f),
                    tint = if (d.mutateVerb == "delete") WF.colors.danger else WF.colors.primary,
                    isBusy = state.phase == CapturePhase.Committing,
                )
            }
        }
    }
}

@Composable
private fun MutateHint(text: String) {
    Text(
        text,
        style = label13,
        color = WF.colors.ink2,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
    )
}

@Composable
private fun CandidateRow(c: CaptureCandidate, on: Boolean, onPick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (on) WF.colors.ai.copy(alpha = 0.1f) else WF.colors.card2, shape)
            .border(if (on) 1.5.dp else 1.dp, if (on) WF.colors.ai else WF.colors.hair, shape)
            .clickable(onClick = onPick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(c.title, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = if (on) WF.colors.ai else WF.colors.ink)
            c.subtitle?.takeIf { it.isNotEmpty() }?.let {
                Text(it, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3, maxLines = 1)
            }
        }
        Icon(
            if (on) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked,
            contentDescription = if (on) "Selected" else null,
            tint = if (on) WF.colors.ai else WF.colors.hair,
            modifier = Modifier.size(18.dp),
        )
    }
}

// ---- field pieces ------------------------------------------------------------------

private val micro = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
private val label13 = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold)

@Composable
private fun BlockedNote(text: String) {
    Text(text, style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.primaryD)
}

/**
 * The inner input inside the understood card. Hand-rolled over `WaffledTextField`
 * because iOS draws these on `card2` (inside a `card` field) with per-field type sizes.
 */
@Composable
private fun InnerField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    style: TextStyle = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
    number: Boolean = false,
) {
    val merged = style.copy(color = WF.colors.ink)
    BasicTextField(
        value = value,
        onValueChange = onChange,
        singleLine = true,
        textStyle = merged,
        cursorBrush = SolidColor(WF.colors.primary),
        keyboardOptions = KeyboardOptions(keyboardType = if (number) KeyboardType.Decimal else KeyboardType.Text),
        modifier = modifier
            .fillMaxWidth()
            .wfField(fill = WF.colors.card2)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        decorationBox = { inner ->
            if (value.isEmpty()) Text(placeholder, style = merged, color = WF.colors.ink3)
            inner()
        },
    )
}

@Composable
private fun SelectChip(label: String, on: Boolean, onTap: () -> Unit) {
    Text(
        label,
        style = label13,
        color = if (on) WF.colors.ai else WF.colors.ink,
        maxLines = 1,
        modifier = Modifier
            .wfChip(on, tint = WF.colors.ai)
            .clickable(onClick = onTap)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun ToggleChip(label: String, on: Boolean, onTap: () -> Unit) {
    Row(
        modifier = Modifier
            .wfChip(on, tint = WF.colors.ai)
            .clickable(onClick = onTap)
            .padding(horizontal = 11.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (on) Icons.Filled.CheckBox else Icons.Filled.CheckBoxOutlineBlank,
            contentDescription = null,
            tint = if (on) WF.colors.ai else WF.colors.ink3,
            modifier = Modifier.size(13.dp),
        )
        Text(label, style = label13, color = if (on) WF.colors.ai else WF.colors.ink2)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PersonChips(state: CaptureUiState, noneLabel: String, onPick: (String?) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SelectChip(noneLabel, state.draft.person == null) { onPick(null) }
        state.environment.members.forEach { m ->
            val on = state.draft.person == m.name
            Row(
                modifier = Modifier
                    .wfChip(on, tint = WF.colors.ai)
                    .clickable { onPick(m.name) }
                    .padding(start = 6.dp, end = 12.dp, top = 6.dp, bottom = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AvatarFromHex(m.colorHex, m.displayEmoji, size = 20.dp)
                Text(m.name, style = label13, color = if (on) WF.colors.ai else WF.colors.ink)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TypeSwitcher(kind: String, onPick: (String) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        CaptureKinds.all.forEach { k ->
            val on = kind == k.key
            Row(
                modifier = Modifier
                    .wfChip(on, tint = WF.colors.ai)
                    .clickable { onPick(k.key) }
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Text(k.icon, style = TextStyle(fontSize = 13.sp))
                Text(k.label, style = label13, color = if (on) WF.colors.ai else WF.colors.ink2)
            }
        }
    }
}

@Composable
private fun Stepper(value: Int, onChange: (Int) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(
            Icons.Filled.RemoveCircle,
            contentDescription = "Fewer",
            tint = if (value > 0) WF.colors.ink2 else WF.colors.hair,
            modifier = Modifier
                .size(22.dp)
                .clickable(enabled = value > 0) { onChange(value - 1) },
        )
        Text(
            "$value",
            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.ExtraBold),
            color = WF.colors.ink,
            modifier = Modifier.widthIn(min = 18.dp),
        )
        Icon(
            Icons.Filled.AddCircle,
            contentDescription = "More",
            tint = WF.colors.primary,
            modifier = Modifier
                .size(22.dp)
                .clickable { onChange(value + 1) },
        )
    }
}

/** A chip that opens a dropdown — the editor's repeat / currency / list pickers (iOS `Menu`). */
@Composable
private fun MenuChip(
    label: String,
    options: List<Pair<String, String>>,
    fill: Boolean = false,
    onPick: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        val base = if (fill) {
            Modifier
                .fillMaxWidth()
                .wfField(fill = WF.colors.card2)
                .clickable { open = true }
                .padding(horizontal = 12.dp, vertical = 11.dp)
        } else {
            Modifier
                .wfChip(false)
                .clickable { open = true }
                .padding(horizontal = 11.dp, vertical = 7.dp)
        }
        Row(base, horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                label,
                style = if (fill) TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold) else label13,
                color = WF.colors.ink,
                maxLines = 1,
                modifier = if (fill) Modifier.weight(1f) else Modifier,
            )
            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null, tint = WF.colors.ink3, modifier = Modifier.size(14.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { (text, value) ->
                DropdownMenuItem(text = { Text(text) }, onClick = { open = false; onPick(value) })
            }
        }
    }
}

private val chipDay = DateTimeFormatter.ofPattern("EEE, MMM d", Locale.getDefault())
private val chipTime = DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault())

@Composable
private fun PickerChip(text: String, onClick: () -> Unit) {
    Text(
        text,
        style = label13,
        color = WF.colors.ink,
        modifier = Modifier
            .wfChip(false)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun DateChip(value: LocalDate, minDate: LocalDate? = null, onPick: (LocalDate) -> Unit) {
    var open by remember { mutableStateOf(false) }
    PickerChip(chipDay.format(value)) { open = true }
    if (open) {
        CaptureDatePickerDialog(value, minDate, onDismiss = { open = false }) { open = false; onPick(it) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TimeChip(value: LocalTime, onPick: (LocalTime) -> Unit) {
    var open by remember { mutableStateOf(false) }
    PickerChip(chipTime.format(value)) { open = true }
    if (open) {
        val state = rememberTimePickerState(initialHour = value.hour, initialMinute = value.minute)
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = { TextButton(onClick = { open = false; onPick(LocalTime.of(state.hour, state.minute)) }) { Text("OK") } },
            dismissButton = { TextButton(onClick = { open = false }) { Text("Cancel") } },
            text = { TimePicker(state = state) },
        )
    }
}

/**
 * Material3's date dialog speaks epoch millis in UTC; converting through UTC keeps "the
 * 15th" the 15th west of Greenwich. Duplicated from Calendar/Pantry (no cross-feature
 * dependency, `core:design` frozen) — a `core:design` candidate.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CaptureDatePickerDialog(initial: LocalDate, minDate: LocalDate?, onDismiss: () -> Unit, onPick: (LocalDate) -> Unit) {
    val floor = minDate?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli()
    val state = rememberDatePickerState(
        initialSelectedDateMillis = initial.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
        selectableDates = object : androidx.compose.material3.SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long): Boolean = floor == null || utcTimeMillis >= floor
            override fun isSelectableYear(year: Int): Boolean = minDate == null || year >= minDate.year
        },
    )
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                state.selectedDateMillis?.let { onPick(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) } ?: onDismiss()
            }) { Text("OK") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    ) {
        DatePicker(state = state)
    }
}


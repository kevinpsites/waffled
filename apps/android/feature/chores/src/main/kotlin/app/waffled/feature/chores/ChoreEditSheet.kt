package app.waffled.feature.chores

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.RemoveCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WeekdayToggleChip
import app.waffled.core.design.colorFromHex
import app.waffled.core.design.wfChip
import app.waffled.core.design.wfField
import app.waffled.core.model.Person
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset

/** What the editor is working on: a brand-new chore, or an existing one. */
sealed interface ChoreEditorTarget {
    /** A new chore, optionally pre-assigned to the column it was added from. */
    data class New(val personId: String?) : ChoreEditorTarget

    data class Edit(val row: ChoreRow) : ChoreEditorTarget
}

/**
 * Create or edit a chore definition — title, emoji, repeat schedule, who, reward,
 * approval and photo requirements. Port of iOS `ChoreEditSheet`.
 *
 * [assignableMembers] is snapshotted by the caller, not read from the sync manager here:
 * on iOS, letting this sheet observe the whole `@Observable` sync object re-laid out its
 * pickers on every unrelated mutation and stacked into a multi-second hang. The same
 * argument applies to a Compose sheet reading a hot `StateFlow`.
 *
 * Assignment is manage-gated by the CALLER: a person without `chore.manage` is handed a
 * list containing only themselves, so the sheet cannot become a way to assign work to
 * someone else.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChoreEditSheet(
    target: ChoreEditorTarget,
    assignableMembers: List<Person>,
    currencies: List<ChoresApi.Currency>,
    /** The day being viewed — a new one-off defaults to it, not to today. */
    initialDate: String,
    onSave: suspend (choreId: String?, body: JsonObject) -> String?,
    /** Returns null on success, else the message to show (the sheet stays open). */
    onDelete: suspend (choreId: String, body: JsonObject) -> String?,
    onDismiss: () -> Unit,
    /** Prefills a NEW chore's title (e.g. a Weekly Planning parked note). Ignored when editing. */
    initialTitle: String? = null,
    /** False hides the Delete control (Weekly Planning's Tasks step). */
    canDelete: Boolean = true,
) {
    val scope = rememberCoroutineScope()

    val editRow = (target as? ChoreEditorTarget.Edit)?.row
    val editChoreId = editRow?.choreId
    val editing = editChoreId != null
    val editInstanceId = editRow?.let { ChoreScopePolicy.instanceId(it.id, it.choreId) }
    val editStatus = editRow?.status
    val originalRrule = editRow?.instance?.rrule?.takeIf { it.isNotBlank() }

    var draft by remember(target) {
        mutableStateOf(
            when (target) {
                is ChoreEditorTarget.Edit -> ChoreDraft.from(target.row.instance)
                // A new chore defaults to a one-off due on the day being viewed.
                is ChoreEditorTarget.New -> ChoreDraft.forNew(target.personId, initialDate, initialTitle)
            },
        )
    }
    var saving by remember { mutableStateOf(false) }
    var saveError by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var showDatePicker by remember { mutableStateOf(false) }
    var showTimePicker by remember { mutableStateOf(false) }
    var scopeAction by remember { mutableStateOf<ChoreScopeAction?>(null) }

    fun performSave(body: JsonObject, choreScope: ChoreScope) {
        scope.launch {
            saving = true
            saveError = null
            val payload = if (editing) ChoreScopePolicy.target(body, choreScope, editInstanceId) else body
            val failure = onSave(editChoreId, payload)
            saving = false
            if (failure != null) saveError = failure else onDismiss()
        }
    }

    fun performDelete(choreScope: ChoreScope) {
        val choreId = editChoreId ?: return
        scope.launch {
            saving = true
            saveError = null
            val failure = onDelete(choreId, ChoreScopePolicy.target(JsonObject(emptyMap()), choreScope, editInstanceId))
            saving = false
            if (failure != null) {
                saveError = failure
                confirmDelete = false
            } else {
                onDismiss()
            }
        }
    }

    // A parent doesn't need another parent's OK, so the approval toggle is hidden for an
    // adult assignee — and `ChoreDraft` refuses to persist it there either.
    val assigneeIsAdult = assignableMembers
        .firstOrNull { it.id == draft.personId }
        ?.memberType == "adult"

    val effectiveCurrencyKey = draft.currencyKey
        ?: currencies.firstOrNull { it.isDefault }?.key
    val selectedCurrency = currencies.firstOrNull { it.key == effectiveCurrencyKey }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(20.dp)
                .padding(bottom = 40.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            // Header
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onDismiss) {
                    Text("Cancel", style = WF.type.label, color = WF.colors.primary)
                }
                Spacer(Modifier.weight(1f))
                Text(
                    text = if (editing) "Edit chore" else "New chore",
                    style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                )
                Spacer(Modifier.weight(1f))
                TextButton(
                    enabled = draft.canSave && !saving,
                    onClick = {
                        // Built HERE, where both the adult-assignee flag and the
                        // household's currency count are known, so neither can be lost on
                        // the way out.
                        val body = draft
                            .copy(assigneeIsAdult = assigneeIsAdult)
                            .toBody(currencyCount = currencies.size)
                        if (editing && ChoreScopePolicy.asksOnSave(originalRrule, editInstanceId)) {
                            scopeAction = ChoreScopeAction.Save(
                                body = body,
                                repeatChanged = ChoreRrule.build(draft.repeat, draft.days) != originalRrule,
                            )
                        } else {
                            performSave(body, ChoreScope.All)
                        }
                    },
                ) {
                    Text(
                        text = if (editing) "Save" else "Add",
                        style = WF.type.label,
                        color = if (draft.canSave && !saving) WF.colors.primary else WF.colors.ink3,
                    )
                }
            }

            saveError?.let { message ->
                Text(
                    text = message,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(
                            WF.colors.primary.copy(alpha = 0.10f),
                            RoundedCornerShape(WF.radius.md),
                        )
                        .padding(12.dp),
                    style = WF.type.label,
                    color = WF.colors.primaryD,
                )
            }

            // ---- title + emoji ----
            Row(horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg)) {
                Column(
                    Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(9.dp),
                ) {
                    SectionLabel("Title")
                    ChoreTextField(
                        value = draft.title,
                        onValueChange = { draft = draft.copy(title = it) },
                        placeholder = "Feed the dog",
                    )
                }
                Column(
                    Modifier.width(72.dp),
                    verticalArrangement = Arrangement.spacedBy(9.dp),
                ) {
                    SectionLabel("Emoji")
                    ChoreTextField(
                        value = draft.emoji,
                        // Two characters is enough for any emoji, including a surrogate
                        // pair — more is a paste accident.
                        onValueChange = { draft = draft.copy(emoji = it.take(2)) },
                        placeholder = "🐶",
                        centered = true,
                    )
                }
            }

            // ---- repeats ----
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("Repeats")
                Row(horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm)) {
                    RepeatChip("Just once", draft.repeat == ChoreRepeat.Once, Modifier.weight(1f)) {
                        draft = draft.copy(repeat = ChoreRepeat.Once)
                    }
                    RepeatChip("Every day", draft.repeat == ChoreRepeat.Daily, Modifier.weight(1f)) {
                        draft = draft.copy(repeat = ChoreRepeat.Daily)
                    }
                    RepeatChip("Certain days", draft.repeat == ChoreRepeat.Weekly, Modifier.weight(1f)) {
                        draft = draft.copy(repeat = ChoreRepeat.Weekly)
                    }
                }

                if (draft.repeat == ChoreRepeat.Once) {
                    FieldRow(
                        label = "On",
                        value = draft.dueOn ?: initialDate,
                        onClick = { showDatePicker = true },
                    )
                }

                if (draft.repeat == ChoreRepeat.Weekly) {
                    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        ChoreRrule.WEEKDAYS.forEach { (code, label) ->
                            WeekdayToggleChip(
                                label = label,
                                isOn = code in draft.days,
                                modifier = Modifier.weight(1f),
                                onClick = {
                                    draft = draft.copy(
                                        days = if (code in draft.days) draft.days - code else draft.days + code,
                                    )
                                },
                            )
                        }
                    }
                }
            }

            // ---- optional time of day ----
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                ToggleField(
                    title = "Due time",
                    subtitle = "Give this chore a specific time of day.",
                    checked = draft.dueTime != null,
                    onCheckedChange = { on ->
                        draft = draft.copy(dueTime = if (on) draft.dueTime ?: "09:00" else null)
                    },
                )
                draft.dueTime?.let { time ->
                    FieldRow(
                        label = "At",
                        value = ChoreDates.timeLabel(time) ?: time,
                        onClick = { showTimePicker = true },
                    )
                }
            }

            // ---- who ----
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel("Who")
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                    verticalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                ) {
                    PersonChip(
                        label = "🙌 Up for grabs",
                        selected = draft.personId == null,
                        onClick = { draft = draft.copy(personId = null) },
                    )
                    assignableMembers.forEach { member ->
                        PersonChip(
                            label = "${member.displayEmoji} ${member.name.substringBefore(' ')}",
                            selected = draft.personId == member.id,
                            tint = colorFromHex(member.colorHex),
                            onClick = { draft = draft.copy(personId = member.id) },
                        )
                    }
                }
            }

            // ---- reward ----
            Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.lg)) {
                if (currencies.size > 1) {
                    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                        SectionLabel("Reward")
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                            verticalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                        ) {
                            currencies.forEach { currency ->
                                PersonChip(
                                    label = "${currency.symbol} ${currency.label}",
                                    selected = currency.key == effectiveCurrencyKey,
                                    tint = colorFromHex(currency.color) ?: WF.colors.gold,
                                    onClick = { draft = draft.copy(currencyKey = currency.key) },
                                )
                            }
                        }
                    }
                }

                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SectionLabel(if (currencies.size > 1) "Amount" else "Stars")
                    Spacer(Modifier.weight(1f))
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(WF.spacing.xl),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        StepperButton(
                            icon = Icons.Filled.RemoveCircle,
                            tint = if (draft.rewardAmount > 0) WF.colors.ink2 else WF.colors.hair,
                            enabled = draft.rewardAmount > 0,
                            description = "One less",
                        ) { draft = draft.copy(rewardAmount = draft.rewardAmount - 1) }

                        Text(
                            text = "${selectedCurrency?.symbol ?: "⭐"} ${draft.rewardAmount}",
                            style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Black),
                            color = WF.colors.ink,
                        )

                        StepperButton(
                            icon = Icons.Filled.AddCircle,
                            tint = WF.colors.primary,
                            enabled = true,
                            description = "One more",
                        ) { draft = draft.copy(rewardAmount = draft.rewardAmount + 1) }
                    }
                }
            }

            // ---- approval + photo ----
            if (!assigneeIsAdult) {
                ToggleField(
                    title = "Needs a parent’s OK",
                    subtitle = "The reward is awarded only after a parent approves.",
                    checked = draft.requiresApproval,
                    onCheckedChange = { draft = draft.copy(requiresApproval = it) },
                )
            }

            ToggleField(
                title = "Needs a photo",
                subtitle = "A snapshot of the finished job is needed to complete it.",
                checked = draft.requiresPhoto,
                onCheckedChange = { draft = draft.copy(requiresPhoto = it) },
            )

            if (draft.requiresPhoto && !draft.requiresApproval && !assigneeIsAdult) {
                // A photo on its own attaches to the finished chore but doesn't pause for
                // review — nudge toward pairing it with approval.
                Text(
                    text = "Turn on “Needs a parent’s OK” too if you want to see the photo " +
                        "in your approvals before it counts.",
                    style = WF.type.micro,
                    color = WF.colors.ink3,
                )
            }

            if (editing && canDelete) {
                TextButton(
                    enabled = !saving,
                    onClick = {
                        if (confirmDelete) {
                            if (ChoreScopePolicy.asksOnDelete(originalRrule)) {
                                scopeAction = ChoreScopeAction.Delete
                            } else {
                                performDelete(ChoreScope.All)
                            }
                        } else {
                            confirmDelete = true
                        }
                    },
                ) {
                    Text(
                        text = if (confirmDelete) "Tap again to delete this chore" else "Delete chore",
                        style = WF.type.label,
                        color = WF.colors.primary,
                    )
                }
            }
        }
    }

    scopeAction?.let { action ->
        ChoreScopeDialog(
            action = action,
            status = editStatus,
            onPick = { choice ->
                scopeAction = null
                when (action) {
                    is ChoreScopeAction.Save -> performSave(action.body, choice)
                    ChoreScopeAction.Delete -> performDelete(choice)
                }
            },
            onCancel = { scopeAction = null },
        )
    }

    // ---- pickers ----

    if (showDatePicker) {
        val initialMillis = remember(draft.dueOn) {
            val day = runCatching { LocalDate.parse(draft.dueOn ?: initialDate) }
                .getOrDefault(LocalDate.now())
            day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        }
        val state = rememberDatePickerState(initialSelectedDateMillis = initialMillis)
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { millis ->
                        // The picker works in UTC millis; a chore day is a plain calendar
                        // date, so it must be read back in UTC too or it slides a day.
                        val day = Instant.ofEpochMilli(millis).atZone(ZoneId.of("UTC")).toLocalDate()
                        draft = draft.copy(dueOn = day.toString())
                    }
                    showDatePicker = false
                }) { Text("Done", color = WF.colors.primary) }
            },
            dismissButton = {
                TextButton(onClick = { showDatePicker = false }) {
                    Text("Cancel", color = WF.colors.ink2)
                }
            },
            colors = androidx.compose.material3.DatePickerDefaults.colors(
                containerColor = WF.colors.card,
            ),
        ) {
            DatePicker(state = state)
        }
    }

    if (showTimePicker) {
        val existing = remember(draft.dueTime) {
            runCatching { LocalTime.parse(draft.dueTime ?: "09:00") }.getOrDefault(LocalTime.of(9, 0))
        }
        val state = rememberTimePickerState(
            initialHour = existing.hour,
            initialMinute = existing.minute,
        )
        DatePickerDialog(
            onDismissRequest = { showTimePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    draft = draft.copy(
                        dueTime = "%02d:%02d".format(state.hour, state.minute),
                    )
                    showTimePicker = false
                }) { Text("Done", color = WF.colors.primary) }
            },
            dismissButton = {
                TextButton(onClick = { showTimePicker = false }) {
                    Text("Cancel", color = WF.colors.ink2)
                }
            },
            colors = androidx.compose.material3.DatePickerDefaults.colors(
                containerColor = WF.colors.card,
            ),
        ) {
            Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                TimePicker(state = state)
            }
        }
    }
}

/** A save or delete of a recurring chore, waiting on which occurrences it reaches. */
private sealed interface ChoreScopeAction {
    data class Save(val body: JsonObject, val repeatChanged: Boolean) : ChoreScopeAction
    data object Delete : ChoreScopeAction
}

/** The twin of iOS's scope `confirmationDialog`: one row per scope, then Cancel. */
@Composable
private fun ChoreScopeDialog(
    action: ChoreScopeAction,
    status: String?,
    onPick: (ChoreScope) -> Unit,
    onCancel: () -> Unit,
) {
    val deleting = action == ChoreScopeAction.Delete
    val repeatChanged = (action as? ChoreScopeAction.Save)?.repeatChanged ?: false
    AlertDialog(
        onDismissRequest = onCancel,
        containerColor = WF.colors.card,
        title = {
            Text(
                text = if (deleting) "Which chores should be deleted?" else "Which chores should change?",
                style = WF.type.sectionTitle,
                color = WF.colors.ink,
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(ChoreScopePolicy.explanation(status), style = WF.type.bodySmall, color = WF.colors.ink2)
                ChoreScopePolicy.choices(status, repeatChanged).forEach { choice ->
                    TextButton(onClick = { onPick(choice) }, modifier = Modifier.fillMaxWidth()) {
                        Text(
                            text = when (choice) {
                                ChoreScope.This -> "This chore only"
                                ChoreScope.Following -> "This and future chores"
                                ChoreScope.All -> "Entire active series"
                            },
                            style = WF.type.label,
                            color = if (deleting) WF.colors.danger else WF.colors.primary,
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onCancel) {
                Text("Cancel", style = WF.type.label, color = WF.colors.ink2)
            }
        },
    )
}

// ---------------------------------------------------------------------------
// Field bits
// ---------------------------------------------------------------------------

/**
 * A boxed single-line field.
 *
 * Hand-rolled on `BasicTextField` rather than Material3's `TextField`, which draws its own
 * container, indicator line and floating label — chrome that contradicts `wfField`, this
 * repo's single source for field styling. `BasicTextField` is the unstyled primitive the
 * design system can dress.
 */
@Composable
private fun ChoreTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    centered: Boolean = false,
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .wfField()
            .padding(horizontal = 13.dp, vertical = 12.dp),
        contentAlignment = if (centered) Alignment.Center else Alignment.CenterStart,
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            textStyle = TextStyle(
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                color = WF.colors.ink,
                textAlign = if (centered) {
                    androidx.compose.ui.text.style.TextAlign.Center
                } else {
                    androidx.compose.ui.text.style.TextAlign.Start
                },
            ),
            cursorBrush = SolidColor(WF.colors.primary),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            decorationBox = { inner ->
                if (value.isEmpty()) {
                    Text(
                        text = placeholder,
                        modifier = Modifier.fillMaxWidth(),
                        style = TextStyle(
                            fontSize = 16.sp,
                            textAlign = if (centered) {
                                androidx.compose.ui.text.style.TextAlign.Center
                            } else {
                                androidx.compose.ui.text.style.TextAlign.Start
                            },
                        ),
                        color = WF.colors.ink3,
                    )
                }
                inner()
            },
        )
    }
}

/** A tappable "label · value" field row, used for the date and time pickers. */
@Composable
private fun FieldRow(label: String, value: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .wfField()
            .clickable(onClick = onClick)
            .padding(horizontal = 13.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = WF.type.fieldTitle, color = WF.colors.ink)
        Spacer(Modifier.weight(1f))
        Text(value, style = WF.type.label, color = WF.colors.primary)
    }
}

/** A titled switch on card chrome — the twin of iOS's `Toggle { … }.cardField()`. */
@Composable
private fun ToggleField(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .wfField()
            .padding(13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(title, style = WF.type.fieldTitle, color = WF.colors.ink)
            Text(subtitle, style = WF.type.caption, color = WF.colors.ink3)
        }
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                // `success` rather than `primary`: an "on" switch reads as a good state,
                // and coral is this app's alert/brand accent.
                checkedTrackColor = WF.colors.success,
                checkedThumbColor = WF.colors.card,
            ),
        )
    }
}

@Composable
private fun RepeatChip(
    label: String,
    selected: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Box(
        modifier = modifier
            .wfChip(selected = selected)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 9.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            maxLines = 1,
            style = TextStyle(
                fontSize = 12.5.sp,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
            ),
            color = if (selected) WF.colors.ink else WF.colors.ink2,
        )
    }
}

@Composable
private fun PersonChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    tint: Color? = null,
) {
    Text(
        text = label,
        modifier = Modifier
            .wfChip(selected = selected, tint = tint ?: WF.colors.primary)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
        color = if (selected) WF.colors.ink else WF.colors.ink2,
    )
}

@Composable
private fun StepperButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    tint: Color,
    enabled: Boolean,
    description: String,
    onClick: () -> Unit,
) {
    Icon(
        imageVector = icon,
        contentDescription = description,
        tint = tint,
        modifier = Modifier
            .size(28.dp)
            .clip(RoundedCornerShape(WF.radius.pill))
            .clickable(enabled = enabled, onClick = onClick),
    )
}

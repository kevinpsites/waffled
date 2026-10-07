package app.waffled.feature.calendar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledFieldCard
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/** An emoji field holds at most one glyph plus a variation selector. */
private const val MAX_EMOJI_LENGTH = 2

private const val SAVED_BUT_STALE =
    "Saved, but this screen couldn't refresh. It will catch up on the next successful refresh."

/**
 * Add a standalone countdown — "what are you counting down to", an optional emoji, a date.
 *
 * Birthdays and flagged events become countdowns at their own source, so this sheet only
 * ever creates the standalone kind.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddCountdownSheet(
    onDismiss: () -> Unit,
    onAdd: suspend (title: String, date: String, emoji: String?) -> CountdownsModel.MutationOutcome,
) {
    CountdownSheet(
        heading = "Add countdown",
        confirmLabel = "Add",
        busyLabel = "Adding…",
        initial = CountdownDraft(date = LocalDate.now()),
        errorHeading = "Couldn't add this countdown. Check your connection and try again.",
        onDismiss = onDismiss,
        onConfirm = { draft -> onAdd(draft.title.trim(), draft.date.toString(), draft.emojiOrNull()) },
        // A countdown to a past date has nothing left to count, and the server drops past
        // items from the list — so it would vanish the moment it was created.
        minDate = LocalDate.now(),
    )
}

/**
 * Rename / move / remove a standalone countdown.
 *
 * Seeded from the tapped row. Unlike the add sheet the date has no floor — an existing
 * countdown may legitimately be edited on or after its own day.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditCountdownSheet(
    countdown: CalendarApi.Countdown,
    onDismiss: () -> Unit,
    onSave: suspend (title: String, date: String, emoji: String?) -> CountdownsModel.MutationOutcome,
    onRemove: suspend () -> Unit,
) {
    CountdownSheet(
        heading = "Edit countdown",
        confirmLabel = "Save",
        busyLabel = "Saving…",
        initial = CountdownDraft(
            title = countdown.title,
            date = CountdownFormat.parse(countdown.date) ?: LocalDate.now(),
            emoji = countdown.emoji.orEmpty(),
        ),
        errorHeading = "Couldn't save this countdown. Check your connection and try again.",
        onDismiss = onDismiss,
        onConfirm = { draft -> onSave(draft.title.trim(), draft.date.toString(), draft.emojiOrNull()) },
        onRemove = onRemove,
    )
}

/** The editable state both countdown sheets share. */
private data class CountdownDraft(
    val title: String = "",
    val date: LocalDate = LocalDate.now(),
    val emoji: String = "",
) {
    val canSave: Boolean get() = title.trim().isNotEmpty()

    fun emojiOrNull(): String? = emoji.trim().takeIf { it.isNotEmpty() }
}

/**
 * One sheet body for add and edit.
 *
 * The two differ only in their labels, their seed and whether they offer Remove — so they
 * share a body rather than being two near-identical 120-line composables that drift.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CountdownSheet(
    heading: String,
    confirmLabel: String,
    busyLabel: String,
    initial: CountdownDraft,
    errorHeading: String,
    onDismiss: () -> Unit,
    onConfirm: suspend (CountdownDraft) -> CountdownsModel.MutationOutcome,
    onRemove: (suspend () -> Unit)? = null,
    /** Earliest day the picker offers, or null when any day is legitimate. */
    minDate: LocalDate? = null,
) {
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    var draft by remember { mutableStateOf(initial) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pickingDate by remember { mutableStateOf(false) }
    var savedNotice by remember { mutableStateOf<String?>(null) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(text = heading, style = WF.type.title, color = WF.colors.ink)

            error?.let { DismissibleErrorBanner(message = it, onDismiss = { error = null }) }

            WaffledFieldCard(title = "What are you counting down to?") {
                OutlinedTextField(
                    value = draft.title,
                    onValueChange = { draft = draft.copy(title = it) },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("e.g. Beach trip") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                )
            }

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                WaffledFieldCard(title = "Emoji", modifier = Modifier.width(120.dp)) {
                    OutlinedTextField(
                        value = draft.emoji,
                        // Capped rather than validated: an emoji field that rejects input is
                        // maddening, and one that swallows a whole sentence is worse.
                        onValueChange = { draft = draft.copy(emoji = it.take(MAX_EMOJI_LENGTH)) },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text("🏖️") },
                        singleLine = true,
                    )
                }
                WaffledFieldCard(title = "Date", modifier = Modifier.weight(1f)) {
                    TextButton(onClick = { pickingDate = true }, modifier = Modifier.fillMaxWidth()) {
                        Text(
                            text = CountdownFormat.dateLabel(draft.date.toString()),
                            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink,
                        )
                    }
                }
            }

            savedNotice?.let { DismissibleErrorBanner(message = it, onDismiss = onDismiss) }

            WaffledPrimaryCTA(
                label = when {
                    savedNotice != null -> "Done"
                    busy -> busyLabel
                    else -> confirmLabel
                },
                onClick = {
                    // Already saved: the only safe action left is to close, never to resend.
                    if (savedNotice != null) {
                        onDismiss()
                        return@WaffledPrimaryCTA
                    }
                    busy = true
                    error = null
                    scope.launch {
                        runCatching { onConfirm(draft) }
                            .onSuccess { outcome ->
                                when (outcome) {
                                    CountdownsModel.MutationOutcome.Refreshed -> onDismiss()
                                    CountdownsModel.MutationOutcome.SavedButRefreshFailed -> {
                                        savedNotice = SAVED_BUT_STALE
                                        busy = false
                                    }
                                }
                            }
                            .onFailure { failure ->
                                error = (failure as? WaffledApiException)?.userMessage ?: errorHeading
                                busy = false
                            }
                    }
                },
                isBusy = busy,
                isDisabled = !draft.canSave,
            )

            if (onRemove != null && savedNotice == null) {
                TextButton(
                    onClick = {
                        busy = true
                        error = null
                        scope.launch {
                            runCatching { onRemove() }
                                .onSuccess { onDismiss() }
                                .onFailure { failure ->
                                    error = (failure as? WaffledApiException)?.userMessage
                                        ?: "Couldn't remove this countdown. Check your connection and try again."
                                    busy = false
                                }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !busy,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Delete,
                        contentDescription = null,
                        tint = WF.colors.danger,
                        modifier = Modifier.height(18.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = "Remove countdown",
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.danger,
                    )
                }
            }
        }
    }

    if (pickingDate) {
        WaffledDatePickerDialog(
            initial = draft.date,
            onDismiss = { pickingDate = false },
            onPick = {
                draft = draft.copy(date = it)
                pickingDate = false
            },
            minDate = minDate,
        )
    }
}

/**
 * The Material3 date picker, wrapped so every calendar surface gets the same dialog.
 *
 * Material3's picker speaks epoch millis in **UTC**; a naive `Instant.ofEpochMilli(…)
 * .atZone(systemDefault())` shifts the chosen day by one west of Greenwich. Converting
 * through [ZoneOffset.UTC] is what keeps "the 15th" the 15th.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WaffledDatePickerDialog(
    initial: LocalDate,
    onDismiss: () -> Unit,
    onPick: (LocalDate) -> Unit,
    /** Earliest selectable day, or null for no floor. Also in UTC — see above. */
    minDate: LocalDate? = null,
) {
    val floor = minDate?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli()
    val state = rememberDatePickerState(
        initialSelectedDateMillis = initial.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
        selectableDates = object : SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long): Boolean =
                floor == null || utcTimeMillis >= floor

            // Year-level too, or the year picker still offers years with no selectable day.
            override fun isSelectableYear(year: Int): Boolean =
                minDate == null || year >= minDate.year
        },
    )
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                onClick = {
                    state.selectedDateMillis?.let {
                        onPick(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate())
                    } ?: onDismiss()
                },
            ) { Text("OK") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    ) {
        DatePicker(state = state)
    }
}

package app.waffled.feature.goals

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledSecondaryCTA
import app.waffled.core.design.WaffledTextField
import java.time.LocalDate
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

/**
 * Edit or delete a single logged entry — amount, who took part, note and date. The port of
 * the iOS `GoalEntryEditSheet`, mirroring the web EntryModal.
 *
 * An entry its source owns ([GoalEntryEdit.isLocked]) offers the note alone and no delete.
 * A refused save or delete keeps the sheet OPEN with the server's reason, so the typed note
 * is still there to retry with.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun GoalEntryEditSheet(
    entry: GoalsApi.GoalDetail.LogEntry,
    participants: List<GoalsApi.Participant>,
    goalType: String,
    unit: String?,
    today: LocalDate = LocalDate.now(),
    onDismiss: () -> Unit,
    /** Returns the server's refusal, or null once saved. */
    onSave: suspend (GoalEntryEdit.Patch) -> String?,
    onDelete: suspend () -> String?,
) {
    val locked = GoalEntryEdit.isLocked(entry)
    val isCount = goalType == "count"
    val numeric = !locked && GoalEntryEdit.isNumeric(goalType)
    val showWho = !locked && participants.size > 1
    val scope = rememberCoroutineScope()

    var amountText by remember { mutableStateOf(goalFmt(entry.amount)) }
    var note by remember { mutableStateOf(entry.note.orEmpty()) }
    var who by remember {
        mutableStateOf(entry.participants.mapNotNull { it.personId }.toSet())
    }
    var loggedOn by remember {
        mutableStateOf(GoalDateKey.parseOrNull(entry.dateKey) ?: today)
    }
    var confirmDelete by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val amount = AmountEntry.value(amountText)
    val logAmount = if (isCount) maxOf(1.0, amount.roundToInt().toDouble()) else amount

    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.canvas)
            .verticalScroll(rememberScrollState())
            .padding(WF.spacing.xxxl),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.xxxl),
    ) {
        Text("Edit entry", style = WF.type.title, color = WF.colors.ink)

        if (numeric) {
            GoalSection("Amount") {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(WF.spacing.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    WaffledTextField(
                        value = amountText,
                        onValueChange = { amountText = it },
                        keyboardOptions = KeyboardOptions(
                            keyboardType = if (isCount) KeyboardType.Number else KeyboardType.Decimal,
                        ),
                        modifier = Modifier.width(130.dp),
                    )
                    unit?.let { Text(it, style = WF.type.micro, color = WF.colors.ink3) }
                }
            }
        }

        if (locked) {
            Text(
                text = "This entry came from a checklist tick, a calendar event or Apple Health — " +
                    "its amount and date are kept in step with that. You can still leave a note.",
                style = WF.type.bodySmall,
                color = WF.colors.ink3,
            )
        } else {
            GoalSection("When?") {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                    verticalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                ) {
                    (0..6).map { today.minusDays(it.toLong()) }.forEach { day ->
                        GoalChip(
                            text = if (day == today) "Today" else day.toString(),
                            selected = day == loggedOn,
                            onClick = { loggedOn = day },
                        )
                    }
                }
            }
        }

        if (showWho) {
            GoalSection("Who took part?") {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                    verticalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                ) {
                    participants.forEach { p ->
                        GoalPersonChip(
                            name = p.name,
                            colorHex = p.colorHex,
                            emoji = p.avatarEmoji,
                            selected = p.personId in who,
                            onClick = {
                                who = if (p.personId in who) who - p.personId else who + p.personId
                            },
                        )
                    }
                }
            }
        }

        GoalSection("Note · optional") {
            WaffledTextField(
                value = note,
                onValueChange = { note = it },
                placeholder = "What happened",
            )
        }

        error?.let { Text(it, style = WF.type.bodySmall, color = WF.colors.danger) }

        WaffledPrimaryCTA(
            label = "Save changes",
            isDisabled = saving || (numeric && logAmount == 0.0),
            onClick = {
                if (saving) return@WaffledPrimaryCTA
                saving = true
                error = null
                scope.launch {
                    val patch = GoalEntryEdit.patch(
                        entry = entry,
                        goalType = goalType,
                        participantCount = participants.size,
                        amount = amount,
                        who = who,
                        note = note,
                        day = loggedOn,
                    )
                    val refusal = onSave(patch)
                    saving = false
                    if (refusal == null) onDismiss() else error = refusal
                }
            },
        )
        WaffledSecondaryCTA(label = "Cancel", onClick = onDismiss)

        // Tap-twice rather than a dialog, matching the goal delete on the detail screen:
        // an entry is cheap to re-log, so a confirmation sheet is heavier than the risk.
        if (!locked) {
            Text(
                text = if (confirmDelete) "Tap again to delete this entry" else "Delete entry",
                style = WF.type.label,
                color = if (confirmDelete) WF.colors.primary else WF.colors.ink3,
                modifier = Modifier
                    .clip(RoundedCornerShape(WF.radius.sm))
                    .clickable(enabled = !saving) {
                        if (!confirmDelete) {
                            confirmDelete = true
                            return@clickable
                        }
                        saving = true
                        error = null
                        scope.launch {
                            val refusal = onDelete()
                            saving = false
                            if (refusal == null) {
                                onDismiss()
                            } else {
                                error = refusal
                                confirmDelete = false
                            }
                        }
                    }
                    .padding(vertical = WF.spacing.sm, horizontal = WF.spacing.xxs),
            )
        }
    }
}

/** The entry sheet's rules, kept out of the composable so they are testable on the JVM. */
object GoalEntryEdit {

    /** Only an explicit `false` locks — an older server's null stays fully editable. */
    fun isLocked(entry: GoalsApi.GoalDetail.LogEntry): Boolean = entry.editable == false

    fun isNumeric(goalType: String): Boolean = goalType == "total" || goalType == "count"

    /** What a save sends. A null [amount] / [personIds] means "leave it alone". */
    data class Patch(
        val amount: Double?,
        val personIds: List<String>?,
        val note: String,
        val loggedOn: String,
    )

    /**
     * A locked entry re-sends its OWN day (the server accepts a note-only change when the
     * day, amount and people are unchanged). The note always goes, so emptying it clears it.
     */
    fun patch(
        entry: GoalsApi.GoalDetail.LogEntry,
        goalType: String,
        participantCount: Int,
        amount: Double,
        who: Set<String>,
        note: String,
        day: LocalDate,
    ): Patch {
        val locked = isLocked(entry)
        val numeric = !locked && isNumeric(goalType)
        val logAmount = if (goalType == "count") maxOf(1.0, amount.roundToInt().toDouble()) else amount
        return Patch(
            amount = if (numeric) logAmount else null,
            personIds = if (!locked && participantCount > 1) who.toList() else null,
            note = note.trim(),
            loggedOn = if (locked) entry.dateKey.take(10) else day.toString(),
        )
    }
}

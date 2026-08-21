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

/**
 * Edit or delete a single logged entry — amount, who took part, note and date. The port of
 * the iOS `GoalEntryEditSheet`, mirroring the web EntryModal.
 *
 * A checklist tick is NOT editable here: it is a step, managed by the step rows.
 *
 * The note is the one field that can be CLEARED, and clearing it depends on an explicit
 * JSON null reaching the server (see [GoalsApi.editLog]) — so the sheet always passes the
 * note through, even when empty, rather than treating empty as "unchanged".
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
    /** (amount, personIds, note, loggedOn) — nulls mean "leave this one alone". */
    onSave: (Double?, List<String>?, String, String) -> Unit,
    onDelete: () -> Unit,
) {
    val isCount = goalType == "count"
    val numeric = goalType == "total" || isCount
    val showWho = participants.size > 1

    var amountText by remember { mutableStateOf(goalFmt(entry.amount)) }
    var note by remember { mutableStateOf(entry.note.orEmpty()) }
    var who by remember {
        mutableStateOf(entry.participants.mapNotNull { it.personId }.toSet())
    }
    var loggedOn by remember {
        mutableStateOf(runCatching { GoalDateKey.parse(entry.dateKey) }.getOrDefault(today))
    }
    var confirmDelete by remember { mutableStateOf(false) }

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

        GoalSection("Note") {
            WaffledTextField(
                value = note,
                onValueChange = { note = it },
                placeholder = "Creek hike + fort building",
            )
        }

        WaffledPrimaryCTA(
            label = "Save changes",
            isDisabled = numeric && logAmount == 0.0,
            onClick = {
                onSave(
                    if (numeric) logAmount else null,
                    if (showWho) who.toList() else null,
                    note.trim(),
                    loggedOn.toString(),
                )
                onDismiss()
            },
        )
        WaffledSecondaryCTA(label = "Cancel", onClick = onDismiss)

        // Tap-twice rather than a dialog, matching the goal delete on the detail screen:
        // an entry is cheap to re-log, so a confirmation sheet is heavier than the risk.
        Text(
            text = if (confirmDelete) "Tap again to delete this entry" else "Delete entry",
            style = WF.type.label,
            color = if (confirmDelete) WF.colors.primary else WF.colors.ink3,
            modifier = Modifier
                .clip(RoundedCornerShape(WF.radius.sm))
                .clickable {
                    if (confirmDelete) {
                        onDelete()
                        onDismiss()
                    } else {
                        confirmDelete = true
                    }
                }
                .padding(vertical = WF.spacing.sm, horizontal = WF.spacing.xxs),
        )
    }
}

package app.waffled.feature.goals

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledSecondaryCTA
import app.waffled.core.design.WaffledTextField
import java.time.LocalDate
import kotlin.math.roundToInt

/**
 * Log progress — quick-amount chips, a multi-select "who", an optional note and a
 * backdate. The port of the iOS `GoalLogSheet`.
 *
 * The sheet ADAPTS to the goal's measure, which is most of its complexity:
 *  - **habit** — one tap logs today's completion (amount 1).
 *  - **count** — a whole-unit stepper.
 *  - **total in hours** — separate hours + minutes fields, sent as-is so the SERVER folds
 *    them to decimal hours and "10 min" never has to become 0.1666… here.
 *  - **total** — quick chips plus a free amount field.
 *  - **checklist** — there is nothing to log; ticking the steps IS the progress.
 *
 * **Scope:** phone layout only. Apple Health's "use today's total" pre-fill is gated on
 * [HealthAutoFill.isAvailable], which is false for this port.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun GoalLogSheet(
    goal: GoalsApi.Goal,
    /** This goal's own most-used notes, newest first. Empty is fine — defaults top up. */
    noteSuggestions: List<String> = emptyList(),
    /** A checklist goal's steps; ticking one is the "log" for that goal type. */
    steps: List<GoalsApi.GoalDetail.Step> = emptyList(),
    stepsLoaded: Boolean = false,
    today: LocalDate = LocalDate.now(),
    onTickStep: (GoalsApi.GoalDetail.Step, Boolean) -> Unit = { _, _ -> },
    onDismiss: () -> Unit,
    /** (amount, hours, minutes, personIds, note, loggedOn) — see [GoalsApi.logProgress]. */
    onSave: (Double, Int?, Int?, List<String>, String, String?) -> Unit,
) {
    val isChecklist = goal.goalType == "checklist"
    val isHabit = goal.goalType == "habit"
    val isCount = goal.goalType == "count"
    val isHours = isHourUnit(goal.unit)

    /** A total goal measured in hours is logged as hours + minutes. */
    val isTime = !isHabit && !isCount && isHours

    // Habit and count start at one completion / one whole thing; an hours total at 1, any
    // other total at 2.
    val initialAmount = if (isHabit || isCount) 1.0 else if (isHours) 1.0 else 2.0

    var amountText by remember { mutableStateOf(goalFmt(initialAmount)) }
    // The raw text is the single source of truth so a cleared field can stay empty while
    // editing instead of snapping back to the old number. The logged Ints are DERIVED,
    // never stored, so text and value can't drift apart.
    var hoursText by remember { mutableStateOf(if (isTime) "1" else "0") }
    var minutesText by remember { mutableStateOf("0") }
    var note by remember { mutableStateOf("") }
    var loggedOn by remember { mutableStateOf(today) }
    var who by remember {
        mutableStateOf(
            // A single-participant goal pre-selects that person; there is nobody else.
            if (goal.participants.size == 1) setOf(goal.participants.first().personId) else emptySet(),
        )
    }

    val amount = AmountEntry.value(amountText)
    val hours = DurationEntry.value(hoursText)
    val minutes = DurationEntry.value(minutesText, cap = 59)

    val logAmount = when {
        isHabit -> 1.0
        isCount -> maxOf(1.0, amount.roundToInt().toDouble())
        isTime -> hours + minutes / 60.0
        else -> amount
    }

    // A log has to be credited to someone: when the goal has participants, at least one
    // must be picked.
    val whoMissing = goal.participants.isNotEmpty() && who.isEmpty()
    val unitSuffix = goal.unit?.let { " $it" }.orEmpty()
    val durationLabel = when {
        hours > 0 && minutes > 0 -> "${hours}h ${minutes}m"
        hours > 0 -> "${hours}h"
        else -> "${minutes}m"
    }
    val confirmLabel = when {
        isHabit -> "Mark done for today"
        isTime -> "Log $durationLabel"
        else -> "Log ${goalFmt(logAmount)}$unitSuffix"
    }

    // "Who" copy adapts to how the goal counts a group entry.
    val whoLabel = when {
        goal.trackingMode == "each_tracks" -> "Who took part?"
        !goal.countsOnce -> "Split between"
        else -> "Who was there?"
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.canvas)
            .verticalScroll(rememberScrollState())
            .padding(WF.spacing.xxxl),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.xxxl),
    ) {
        Text(
            text = if (isChecklist) "Checklist" else "Log progress",
            style = WF.type.title,
            color = WF.colors.ink,
        )

        if (isChecklist) {
            ChecklistSection(steps = steps, loaded = stepsLoaded, onTick = onTickStep)
            WaffledSecondaryCTA(label = "Done", onClick = onDismiss)
            return@Column
        }

        when {
            isHabit -> GoalSection("Mark it done") {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(WF.colors.card2, RoundedCornerShape(WF.radius.md))
                        .padding(WF.spacing.xl),
                    horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Filled.CheckCircle,
                        contentDescription = null,
                        tint = WF.colors.primary,
                        modifier = Modifier.size(22.dp),
                    )
                    Text(
                        text = "One tap logs today's completion — keep the streak going.",
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink2,
                    )
                }
            }

            isCount -> GoalSection("How many?") {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(WF.spacing.xxl),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    StepButton(
                        increase = false,
                        enabled = logAmount > 1,
                        onClick = { amountText = goalFmt(maxOf(1.0, logAmount - 1)) },
                    )
                    Text(
                        text = "${logAmount.roundToInt()}$unitSuffix",
                        style = WF.type.title,
                        color = WF.colors.ink,
                        modifier = Modifier.width(110.dp),
                    )
                    StepButton(increase = true, enabled = true, onClick = { amountText = goalFmt(logAmount + 1) })
                }
            }

            isTime -> GoalSection("How long?") {
                Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.md)) {
                    ChipRow(
                        chips = GoalLogChips.chips(isHours = true, unit = goal.unit),
                        isSelected = { GoalLogChips.isSelected(hours, minutes, it.value) },
                        onPick = { chip ->
                            val (h, m) = GoalLogChips.fields(chip.value)
                            hoursText = h.toString()
                            minutesText = m.toString()
                        },
                    )
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                        verticalAlignment = Alignment.Bottom,
                    ) {
                        Text(
                            text = "or",
                            style = WF.type.micro,
                            color = WF.colors.ink3,
                            modifier = Modifier.padding(bottom = 14.dp),
                        )
                        WaffledTextField(
                            value = hoursText,
                            onValueChange = { hoursText = it },
                            label = "hr",
                            placeholder = "0",
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.width(90.dp),
                        )
                        WaffledTextField(
                            value = minutesText,
                            onValueChange = { minutesText = it },
                            label = "min",
                            placeholder = "0",
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.width(90.dp),
                        )
                    }
                }
            }

            else -> GoalSection("How much?") {
                Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.md)) {
                    ChipRow(
                        chips = GoalLogChips.chips(isHours = false, unit = goal.unit),
                        // Compare on the PARSED amount, so "2" and "2.0" both light the chip.
                        isSelected = { GoalStats.sameAmount(amount, it.value) },
                        onPick = { amountText = goalFmt(it.value) },
                    )
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(text = "or", style = WF.type.micro, color = WF.colors.ink3)
                        WaffledTextField(
                            value = amountText,
                            // Locale-aware and never sticky: an emptied field is 0, which
                            // disables Log, rather than silently logging the old number.
                            onValueChange = { amountText = it },
                            placeholder = "amount",
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            modifier = Modifier.width(130.dp),
                        )
                        goal.unit?.let {
                            Text(text = it, style = WF.type.micro, color = WF.colors.ink3)
                        }
                    }
                }
            }
        }

        GoalSection("When?") {
            // Quick chips plus any earlier day, so a missed log can be backdated without
            // breaking the streak. Future days are never offered.
            WhenRow(today = today, selected = loggedOn, onPick = { loggedOn = it })
        }

        if (goal.participants.isNotEmpty()) {
            GoalSection(
                label = whoLabel,
                trailing = {
                    if (whoMissing) {
                        Text(
                            text = "pick at least one",
                            style = WF.type.micro,
                            color = WF.colors.primary,
                        )
                    }
                },
            ) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                    verticalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                ) {
                    goal.participants.forEach { p ->
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

        GoalSection("What did you do? · optional") {
            Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.md)) {
                WaffledTextField(
                    value = note,
                    onValueChange = { note = it },
                    placeholder = "Creek hike + fort building",
                )
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                    verticalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                ) {
                    noteChips(noteSuggestions).forEach { suggestion ->
                        GoalChip(
                            text = suggestion,
                            selected = note == suggestion,
                            onClick = { note = suggestion },
                        )
                    }
                }
            }
        }

        WaffledPrimaryCTA(
            label = confirmLabel,
            isDisabled = logAmount == 0.0 || whoMissing,
            onClick = {
                val backdate = if (loggedOn == today) null else loggedOn.toString()
                onSave(
                    logAmount,
                    if (isTime) hours else null,
                    if (isTime) minutes else null,
                    who.toList(),
                    note.trim(),
                    backdate,
                )
                onDismiss()
            },
        )
        WaffledSecondaryCTA(label = "Cancel", onClick = onDismiss)
    }
}

/** Cold-start note chips, shown until a goal has enough of its own logged notes. */
private val DEFAULT_NOTE_CHIPS =
    listOf("Bike ride", "Park", "Sports", "Outside play", "Reading", "Art")

private const val NOTE_CHIP_TARGET = 6

/**
 * This goal's own notes first, then the defaults topping up the remaining slots, de-duped
 * case-insensitively so a learned note can't appear twice.
 */
internal fun noteChips(suggestions: List<String>): List<String> {
    val out = mutableListOf<String>()
    val seen = mutableSetOf<String>()
    for (candidate in suggestions + DEFAULT_NOTE_CHIPS) {
        if (out.size >= NOTE_CHIP_TARGET) break
        val key = candidate.trim().lowercase()
        if (key.isEmpty() || !seen.add(key)) continue
        out.add(candidate)
    }
    return out
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChipRow(
    chips: List<GoalLogChips.Chip>,
    isSelected: (GoalLogChips.Chip) -> Boolean,
    onPick: (GoalLogChips.Chip) -> Unit,
) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.sm),
    ) {
        chips.forEach { chip ->
            GoalChip(text = chip.label, selected = isSelected(chip), onClick = { onPick(chip) })
        }
    }
}

@Composable
private fun StepButton(increase: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .size(46.dp)
            .background(WF.colors.card, CircleShape)
            .border(1.dp, WF.colors.hair, CircleShape)
            .clip(CircleShape)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = if (increase) Icons.Filled.Add else Icons.Filled.Remove,
            contentDescription = if (increase) "One more" else "One fewer",
            tint = if (enabled) WF.colors.ink else WF.colors.ink3,
            modifier = Modifier.size(18.dp),
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WhenRow(today: LocalDate, selected: LocalDate, onPick: (LocalDate) -> Unit) {
    // The last week, newest first: enough to rescue a missed log without a date picker,
    // and never a future day (you cannot have done it yet).
    val days = remember(today) { (0..6).map { today.minusDays(it.toLong()) } }
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.sm),
    ) {
        days.forEach { day ->
            val label = when (day) {
                today -> "Today"
                today.minusDays(1) -> "Yesterday"
                else -> dayLabel(day)
            }
            GoalChip(text = label, selected = day == selected, onClick = { onPick(day) })
        }
    }
}

/** "Mon 14" — precomputed per chip, never rebuilt inside a scrolling row. */
private fun dayLabel(day: LocalDate): String {
    val weekday = day.dayOfWeek.getDisplayName(
        java.time.format.TextStyle.SHORT,
        java.util.Locale.getDefault(),
    )
    return "$weekday ${day.dayOfMonth}"
}

@Composable
private fun ChecklistSection(
    steps: List<GoalsApi.GoalDetail.Step>,
    loaded: Boolean,
    onTick: (GoalsApi.GoalDetail.Step, Boolean) -> Unit,
) {
    val done = steps.count { it.done }
    Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.lg)) {
        Text(
            text = "$done/${steps.size} steps done",
            style = WF.type.label,
            color = WF.colors.ink2,
        )
        when {
            !loaded -> Text("Loading…", style = WF.type.bodySmall, color = WF.colors.ink3)
            steps.isEmpty() -> Text(
                text = "No steps yet — add some by editing this goal.",
                style = WF.type.bodySmall,
                color = WF.colors.ink3,
            )

            else -> steps.forEach { step -> StepRow(step) { onTick(step, !step.done) } }
        }
    }
}

@Composable
internal fun StepRow(step: GoalsApi.GoalDetail.Step, onToggle: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair2, shape)
            .clip(shape)
            .clickable(onClick = onToggle)
            .padding(horizontal = WF.spacing.xl, vertical = WF.spacing.lg),
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StepTick(step.done)
        Text(
            text = step.label,
            style = TextStyle(
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                textDecoration = if (step.done) TextDecoration.LineThrough else null,
            ),
            color = if (step.done) WF.colors.ink3 else WF.colors.ink,
        )
    }
}

@Composable
private fun StepTick(done: Boolean) {
    val shape = RoundedCornerShape(6.dp)
    Box(
        Modifier
            .size(22.dp)
            .background(if (done) WF.colors.primary else Color.Transparent, shape)
            .border(2.dp, if (done) WF.colors.primary else WF.colors.hair, shape),
        contentAlignment = Alignment.Center,
    ) {
        if (done) {
            Icon(
                imageVector = Icons.Filled.CheckCircle,
                contentDescription = null,
                // White on the saturated coral fill is correct; `onInk` is for an ink fill.
                tint = Color.White,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}

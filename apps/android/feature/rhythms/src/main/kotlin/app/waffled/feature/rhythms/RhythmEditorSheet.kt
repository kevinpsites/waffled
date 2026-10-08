package app.waffled.feature.rhythms

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.DisclosureChevron
import app.waffled.core.design.LockNote
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledFieldCard
import app.waffled.core.design.WaffledMenuPill
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.WeekdayToggleChip
import app.waffled.core.design.wfField
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledDates
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle as DayTextStyle
import java.util.Locale
import kotlin.math.roundToInt

/**
 * Create a rhythm by saying it as a sentence — "🌬 Air filter / every 3 months, / counted
 * when I mark it done, / on Kevin" — then read what that sentence will actually do.
 * Port of iOS `RhythmEditorSheet` (and web `RhythmModal.tsx`).
 *
 * Editing asks less: the shape and the period anchor are stated, not offered, because the
 * server refuses them — moving a live rhythm's anchor would re-read its skips and bookings.
 */
@Composable
fun RhythmEditorSheet(
    model: RhythmsModel,
    members: List<Person>,
    onDismiss: () -> Unit,
    editing: RhythmsApi.Rhythm? = null,
    onSaved: () -> Unit = {},
) {
    val zone = remember { model.zone() }
    val today = remember { WaffledDates.localDay(model.now(), zone) }
    var form by remember(editing) {
        mutableStateOf(editing?.let { RhythmForm.editing(it, zone) } ?: RhythmForm(startsOn = today))
    }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var advanced by remember { mutableStateOf(false) }
    var history by remember { mutableStateOf<RhythmsApi.History?>(null) }
    val scope = rememberCoroutineScope()
    val isNew = form.editingId == null

    // Completion only: a scheduling rhythm never asks whether it happened.
    LaunchedEffect(form.editingId) {
        val id = form.editingId ?: return@LaunchedEffect
        if (form.shape == RhythmShape.Completion) history = model.history(id)
    }

    RhythmSheetScaffold(title = if (isNew) "New rhythm" else "Edit rhythm", onDismiss = onDismiss) {
        Text("Say it as a sentence. Everything else has a sane default.", style = TextStyle(fontSize = 13.sp), color = WF.colors.ink3)

        Sentence(form, isNew, members) { form = it }

        if (isNew) Consequence(form, today) else AnchorNote(form, zone)
        history?.takeIf { it.total > 0 }?.let { HistoryNote(it, form, zone) }

        Row(
            Modifier.fillMaxWidth().clickable { advanced = !advanced },
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            DisclosureChevron(isOpen = advanced, size = 12.dp, color = WF.colors.ink2)
            Text(
                if (advanced) "Fewer options" else "More options — notes, how early to nudge, auto-add to calendar",
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink2,
            )
        }
        if (advanced) AdvancedFields(form, isNew, today) { form = it }

        SheetError(error)

        WaffledPrimaryCTA(
            label = if (isNew) "Add rhythm" else "Save changes",
            isBusy = saving,
            isDisabled = !form.isValid,
            onClick = {
                if (saving || !form.isValid) return@WaffledPrimaryCTA
                saving = true
                error = null
                scope.launch {
                    try {
                        model.save(form)
                        onSaved()
                        onDismiss()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        error = errorText(e, "Couldn’t save that — check the cadence and try again.")
                        saving = false
                    }
                }
            },
        )
    }
}

private val MODES = listOf(
    Triple(RhythmShape.Completion, "I mark it done", "The clock restarts the day you actually do it. Late once ≠ late forever."),
    Triple(RhythmShape.Scheduling, "it’s on the calendar", "Getting it booked is the win — nobody asks later whether it happened."),
)

private fun modeLabel(shape: RhythmShape) = MODES.firstOrNull { it.first == shape }?.second.orEmpty()

@Composable
private fun Sentence(form: RhythmForm, isNew: Boolean, members: List<Person>, onChange: (RhythmForm) -> Unit) {
    // A scheduling rhythm's cadence IS its period grid, so it is fixed once live.
    val cadenceFixed = !isNew && form.shape == RhythmShape.Scheduling
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            TokenField(form.emoji, { onChange(form.copy(emoji = it)) }, "🔁", "Emoji", width = 54.dp)
            TokenField(
                form.title, { onChange(form.copy(title = it)) }, "Take the trash out", "What",
                modifier = Modifier.weight(1f), center = false,
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Fixed("every")
            if (cadenceFixed) {
                FixedToken("${form.count} ${form.unit.label}")
            } else {
                // Local text so the field can be emptied mid-edit; only a real count is written.
                var countText by remember(form.editingId) { mutableStateOf(form.count.toString()) }
                TokenField(
                    value = countText,
                    onChange = { text ->
                        countText = text.filter(Char::isDigit)
                        countText.toIntOrNull()?.takeIf { it >= 1 }?.let { onChange(form.copy(count = it)) }
                    },
                    placeholder = "1", label = "How often", width = 56.dp, numeric = true,
                )
                PillMenu(form.unit.label, "Unit", RhythmForm.Unit.entries.map { it.label to { onChange(form.copy(unit = it)) } })
            }
            Fixed(",")
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Fixed("counted when")
            if (isNew) {
                PillMenu(
                    modeLabel(form.shape), "counted when",
                    MODES.map { (shape, label, _) -> label to { onChange(form.copy(shape = shape)) } },
                    subtitles = MODES.map { it.third },
                )
            } else {
                FixedToken(modeLabel(form.shape))
            }
            Fixed(",")
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Fixed("on")
            val who = members.firstOrNull { it.id == form.personId }?.name ?: "the whole household"
            PillMenu(
                who, "Who",
                listOf<Pair<String, () -> Unit>>("the whole household" to { onChange(form.copy(personId = null)) }) +
                    members.map { m -> m.name to { onChange(form.copy(personId = m.id)) } },
            )
        }
    }
}

@Composable
private fun Fixed(text: String) {
    Text(text, style = TextStyle(fontSize = 17.sp), color = WF.colors.ink2, maxLines = 1)
}

/** A clause stated rather than offered — token-shaped, but flat so it doesn't invite a tap. */
@Composable
private fun FixedToken(text: String) {
    Text(
        text,
        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
        color = WF.colors.ink2,
        modifier = Modifier
            .background(WF.colors.panel.copy(alpha = 0.6f), RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 14.dp, vertical = 9.dp),
    )
}

/**
 * A sentence token. Hand-rolled on `BasicTextField` because `WaffledTextField` has no
 * text-style or alignment slot, and these are narrow, centred, 17sp words in a sentence.
 */
@Composable
private fun TokenField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    label: String,
    modifier: Modifier = Modifier,
    width: Dp? = null,
    center: Boolean = true,
    numeric: Boolean = false,
) {
    val style = TextStyle(
        fontSize = 17.sp,
        fontWeight = if (center && !numeric) FontWeight.Normal else FontWeight.SemiBold,
        color = WF.colors.ink,
        textAlign = if (center) TextAlign.Center else TextAlign.Start,
    )
    Box(
        modifier
            .then(if (width != null) Modifier.width(width) else Modifier)
            .wfField(radius = WF.radius.sm, fill = WF.colors.panel)
            .padding(horizontal = if (center) 6.dp else 12.dp, vertical = 9.dp)
            .semantics { contentDescription = label },
    ) {
        if (value.isEmpty()) {
            Text(placeholder, style = style.copy(color = WF.colors.ink3), modifier = Modifier.fillMaxWidth())
        }
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = style,
            cursorBrush = SolidColor(WF.colors.primary),
            keyboardOptions = if (numeric) KeyboardOptions(keyboardType = KeyboardType.Number) else KeyboardOptions.Default,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** A `WaffledMenuPill` opening a dropdown — the app-wide menu family. */
@Composable
private fun PillMenu(
    current: String,
    label: String,
    options: List<Pair<String, () -> Unit>>,
    subtitles: List<String>? = null,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        WaffledMenuPill(current, Modifier.clickable { open = true }.semantics { contentDescription = label })
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = WF.colors.card) {
            options.forEachIndexed { i, (text, pick) ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(text, color = WF.colors.ink, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
                            subtitles?.getOrNull(i)?.let { Text(it, color = WF.colors.ink3, style = TextStyle(fontSize = 12.sp)) }
                        }
                    },
                    onClick = {
                        open = false
                        pick()
                    },
                )
            }
        }
    }
}

/** The two dates that are the whole promise, through `consequence` — never the typed runway. */
@Composable
private fun Consequence(form: RhythmForm, today: java.time.LocalDate) {
    val anchor = if (form.shape == RhythmShape.Scheduling) form.startsOn else form.firstDue(today)
    val plan = RhythmFormat.consequence(form.shape, form.every, form.effectiveLeadDays, anchor, form.bookWithinInterval)
    val lands = RhythmFormat.dayMonth(plan.landsOn)
    val nudge = RhythmFormat.dayMonth(plan.nudgeFrom)
    val bold = SpanStyle(fontWeight = FontWeight.Bold)
    val promise = buildAnnotatedString {
        if (form.shape == RhythmShape.Completion) {
            append("Next one lands around ")
            withStyle(bold) { append(lands) }
            append(". It’ll be on your Today card from ")
            withStyle(bold) { append(nudge) }
            append(". If you do it late the next one moves with it — misses never stack up.")
        } else {
            append("Booking it is the win — we’ll never ask whether it happened. A fresh window opens ")
            append(RhythmFormat.cadenceLabel(form.every))
            append(", and if nothing’s on the calendar by ")
            withStyle(bold) { append(nudge) }
            append(" it moves to Needs you now.")
        }
    }
    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.md))
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            if (form.shape == RhythmShape.Completion) Icons.Filled.CheckCircle else Icons.Filled.CalendarMonth,
            contentDescription = null,
            tint = WF.colors.primary,
            modifier = Modifier.size(16.dp).padding(top = 1.dp),
        )
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(promise, style = TextStyle(fontSize = 13.5.sp), color = WF.colors.ink)
            RhythmFormat.capNote(form.every, form.effectiveLeadDays, form.shape, form.bookWithinInterval)?.let {
                Text(it, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
            }
        }
    }
}

@Composable
private fun AnchorNote(form: RhythmForm, zone: java.time.ZoneId) {
    LockNote(
        if (form.shape == RhythmShape.Scheduling) {
            "Periods are anchored to ${RhythmFormat.shortDate(form.startsOn.toString(), zone)}, " +
                "${RhythmFormat.cadenceLabel(form.every)}. Moving the anchor would re-interpret the periods " +
                "you’ve already skipped or booked, so it can’t change here — retire this one and make a new one instead."
        } else {
            "The clock isn’t set by hand — marking it done restarts it from when you actually did it. " +
                "Moving the anchor would mean a different rhythm, so retire this one and make a new one instead."
        },
    )
}

/** How often it REALLY happens — a nominal 3 months that runs at 5 is the cadence saying it's wrong. */
@Composable
private fun HistoryNote(h: RhythmsApi.History, form: RhythmForm, zone: java.time.ZoneId) {
    val done = if (h.total == 1) "Done once" else "Done ${h.total} times"
    val headline = h.averageIntervalDays?.let {
        "$done · about every ${it.roundToInt()} days, against ${RhythmFormat.cadenceLabel(form.every)}"
    } ?: done
    Column(
        Modifier.fillMaxWidth().wfField(radius = WF.radius.sm, fill = WF.colors.panel).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(headline, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
        Text(
            h.completions.joinToString(" · ") { RhythmFormat.shortDate(it.completedAt, zone) },
            style = TextStyle(fontSize = 13.sp),
            color = WF.colors.ink3,
        )
    }
}

private val ORDINALS = listOf(1, 2, 3, 4, 5, -1)
private val ORDINAL_WORDS = listOf("", "first", "second", "third", "fourth", "fifth")
private val CHIP_DAY = mapOf("SU" to "Su", "MO" to "Mo", "TU" to "Tu", "WE" to "We", "TH" to "Th", "FR" to "Fr", "SA" to "Sa")
private val DAY_LABEL: DateTimeFormatter = DateTimeFormatter.ofPattern("EEE, MMM d, yyyy", Locale.US)

private fun ordinalWord(n: Int) = if (n == -1) "last" else ORDINAL_WORDS.getOrNull(n)?.takeIf { it.isNotEmpty() } ?: "${n}th"

@Composable
private fun AdvancedFields(form: RhythmForm, isNew: Boolean, today: java.time.LocalDate, onChange: (RhythmForm) -> Unit) {
    var pickingDue by remember { mutableStateOf(false) }
    var pickingStart by remember { mutableStateOf(false) }
    var rawRuleOpen by remember { mutableStateOf(false) }

    WaffledFieldCard(
        title = if (form.shape == RhythmShape.Completion) {
            "Start nudging me this many days early"
        } else {
            "Start nudging me this many days before the window closes"
        },
    ) {
        // Reads the derived value and writes the raw one: touching it is what pins it.
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "${form.effectiveLeadDays} days",
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
                modifier = Modifier.weight(1f),
            )
            IconButton(
                onClick = { onChange(form.copy(leadDays = (form.effectiveLeadDays - 1).coerceAtLeast(0))) },
                enabled = form.effectiveLeadDays > 0,
            ) { Icon(Icons.Filled.Remove, contentDescription = "Fewer days", tint = WF.colors.ink2) }
            IconButton(
                onClick = { onChange(form.copy(leadDays = (form.effectiveLeadDays + 1).coerceAtMost(365))) },
                enabled = form.effectiveLeadDays < 365,
            ) { Icon(Icons.Filled.Add, contentDescription = "More days", tint = WF.colors.ink2) }
        }
        Text(
            if (form.shape == RhythmShape.Completion) {
                "Capped at half the cadence — a rhythm you mark done keeps asking however late it is, so a longer runway would never let it go quiet."
            } else {
                RhythmFormat.nudgeExplainer(form.every, form.effectiveLeadDays, form.bookWithinInterval)
            },
            style = TextStyle(fontSize = 12.sp),
            color = WF.colors.ink3,
        )
    }

    if (isNew) {
        if (form.shape == RhythmShape.Completion) {
            WaffledFieldCard(title = "First one due") {
                PickerChip(DAY_LABEL.format(form.firstDue(today)), Modifier.fillMaxWidth()) { pickingDue = true }
            }
        } else {
            WaffledFieldCard(title = "First period starts") {
                PickerChip(DAY_LABEL.format(form.startsOn), Modifier.fillMaxWidth()) { pickingStart = true }
                LabeledSwitch("Put it on the calendar automatically", form.autoSchedule) { onChange(form.copy(autoSchedule = it)) }
                if (form.autoSchedule) {
                    Text(
                        "${RhythmRecurrence.describeRrule(form.rrule(), form.startsOn)} — booked once, then it just stays there.",
                        style = TextStyle(fontSize = 12.sp),
                        color = WF.colors.ink3,
                    )
                    if (form.unit == RhythmForm.Unit.Weeks) WeekdayChips(form, onChange)
                    if (form.unit == RhythmForm.Unit.Months) MonthlyModeMenu(form, onChange)
                    Row(
                        Modifier.clickable { rawRuleOpen = !rawRuleOpen },
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        DisclosureChevron(isOpen = rawRuleOpen, color = WF.colors.ink2)
                        Text(
                            "Advanced — write the rule yourself",
                            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink2,
                        )
                    }
                    if (rawRuleOpen) {
                        WaffledTextField(
                            value = form.customRule,
                            onValueChange = { onChange(form.copy(customRule = it)) },
                            placeholder = "FREQ=MONTHLY;BYDAY=2FR",
                            keyboardOptions = KeyboardOptions(
                                capitalization = KeyboardCapitalization.Characters,
                                autoCorrectEnabled = false,
                            ),
                        )
                    }
                } else {
                    Text(
                        "When it happens is an open decision every period, so it’ll ask you to pick a time.",
                        style = TextStyle(fontSize = 12.sp),
                        color = WF.colors.ink3,
                    )
                }
            }
        }
    }

    // The booking window is the one part of WHEN editable in place: it moves no boundary.
    if (form.shape == RhythmShape.Scheduling && !form.autoSchedule) {
        WaffledFieldCard(title = "Deadline inside each cycle") {
            val noun = cycleNoun(form)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("It must be booked in the first", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                TokenField(
                    value = form.windowDays?.toString().orEmpty(),
                    onChange = { text -> onChange(form.copy(windowDays = text.filter(Char::isDigit).toIntOrNull()?.takeIf { it > 0 })) },
                    placeholder = "—", label = "Booking window in days", width = 56.dp, numeric = true,
                )
            }
            Text("days of $noun.", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            Text(windowExplainer(form, noun), style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
        }
    }

    WaffledFieldCard(title = "Notes") {
        WaffledTextField(
            value = form.notes,
            onValueChange = { onChange(form.copy(notes = it)) },
            placeholder = "Furnace, 20x25x1",
            singleLine = false,
            minHeight = 64.dp,
        )
    }

    if (pickingDue) {
        RhythmDatePicker(form.firstDue(today), null, onDismiss = { pickingDue = false }) {
            onChange(form.copy(nextDue = it))
            pickingDue = false
        }
    }
    if (pickingStart) {
        RhythmDatePicker(form.startsOn, null, onDismiss = { pickingStart = false }) {
            onChange(form.copy(startsOn = it))
            pickingStart = false
        }
    }
}

/** One weekday, not several: the period is satisfied by ONE booking either way. */
@Composable
private fun WeekdayChips(form: RhythmForm, onChange: (RhythmForm) -> Unit) {
    val current = form.byday.firstOrNull() ?: RhythmRecurrence.weekdayCode(form.startsOn)
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (code in RhythmRecurrence.weekdays) {
            WeekdayToggleChip(label = CHIP_DAY[code] ?: code, isOn = current == code, onClick = {
                onChange(form.copy(byday = listOf(code)))
            })
        }
    }
}

@Composable
private fun MonthlyModeMenu(form: RhythmForm, onChange: (RhythmForm) -> Unit) {
    val weekday = form.startsOn.dayOfWeek.getDisplayName(DayTextStyle.FULL, Locale.US)
    fun nth(ord: Int) = "The ${ordinalWord(ord)} $weekday"
    val current = if (form.monthlyMode == RhythmMonthlyMode.DayOfMonth) "The same date" else nth(form.monthlyOrdinal)
    PillMenu(
        current, "Which day each month",
        listOf<Pair<String, () -> Unit>>("The same date" to { onChange(form.copy(monthlyMode = RhythmMonthlyMode.DayOfMonth)) }) +
            ORDINALS.map { ord ->
                nth(ord) to { onChange(form.copy(monthlyMode = RhythmMonthlyMode.NthWeekday, monthlyOrdinal = ord)) }
            },
    )
}

/** "each month" / "every 2 weeks" — names the cadence just chosen rather than "period". */
private fun cycleNoun(form: RhythmForm): String {
    val n = maxOf(1, form.count)
    return if (n == 1) "each ${form.unit.wire.removeSuffix("s")}" else "every $n ${form.unit.wire}"
}

private fun windowExplainer(form: RhythmForm, noun: String): String {
    val d = form.windowDays
    if (d == null || d <= 0) {
        return "Leave it blank and any day in ${noun.replace("each ", "the ")} counts — most rhythms want that."
    }
    return "Leave it blank and any day counts. Set to $d, a booking later than that leaves " +
        "${noun.replace("each ", "").replace("every ", "")} unbooked."
}

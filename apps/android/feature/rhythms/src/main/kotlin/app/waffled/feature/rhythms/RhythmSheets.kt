package app.waffled.feature.rhythms

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SelectableDates
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledFieldCard
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.wfField
import app.waffled.core.model.WaffledDates
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Book a period: turn "this should happen" into a dated event. The server fills title
 * and assignee from the rhythm, so all that is left to decide is WHEN. The date is
 * bounded to the period — `periodEnd` is exclusive, so a booking on it would satisfy the
 * next one. Port of iOS `BookRhythmSheet`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BookRhythmSheet(
    item: RhythmsApi.AttentionItem,
    model: RhythmsModel,
    onDismiss: () -> Unit,
    onBooked: () -> Unit = {},
) {
    val rhythm = item.rhythm
    val zone = remember { model.zone() }
    val series = RhythmsModel.needsSeriesBack(rhythm, item.hasSeries)
    val window = remember(item) {
        val start = item.periodStart?.let(RhythmFormat::parseDay)
        val last = item.bookableUntil?.let { RhythmFormat.parseDay(RhythmFormat.lastDayOfPeriod(it)) }
        if (start != null && last != null && !start.isAfter(last)) start..last else null
    }
    // Today when it is inside the period, else the first day it could go; six in the evening.
    var date by remember {
        val today = WaffledDates.localDay(model.now(), zone)
        mutableStateOf(window?.let { if (today in it) today else it.start } ?: today)
    }
    var time by remember { mutableStateOf(LocalTime.of(18, 0)) }
    var allDay by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pickingDate by remember { mutableStateOf(false) }
    var pickingTime by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    RhythmSheetScaffold(title = "Book a time", onDismiss = onDismiss) {
        SheetHeader(
            rhythm,
            if (series) {
                "Puts the whole series back on the calendar, ${RhythmFormat.cadenceLabel(rhythm.every)}."
            } else {
                "Pick a time and it goes on the calendar — ${RhythmFormat.cadenceLabel(rhythm.every)}."
            },
        )

        WaffledFieldCard(title = "When") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PickerChip(DAY.format(date), Modifier.weight(1f)) { pickingDate = true }
                if (!allDay) PickerChip(TIME.format(time)) { pickingTime = true }
            }
            LabeledSwitch("All day", allDay) { allDay = it }
        }

        item.bookableUntil?.let { end ->
            Text(
                "It counts for this period as long as it lands on or before " +
                    "${RhythmFormat.shortDate(RhythmFormat.lastDayOfPeriod(end), zone)}.",
                style = TextStyle(fontSize = 12.sp),
                color = WF.colors.ink3,
            )
        }

        SheetError(error)

        WaffledPrimaryCTA(
            label = if (series) "Put it back on the calendar" else "Put it on the calendar",
            isBusy = saving,
            onClick = {
                if (saving) return@WaffledPrimaryCTA
                saving = true
                error = null
                scope.launch {
                    try {
                        // An all-day booking still sends an instant — local midnight, flagged all-day.
                        val startsAt = if (allDay) {
                            date.atStartOfDay(zone).toInstant()
                        } else {
                            date.atTime(time).atZone(zone).toInstant()
                        }
                        model.book(rhythm.id, startsAt, allDay, item.periodStart)
                        onBooked()
                        onDismiss()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        error = errorText(e, "Couldn’t book it — try again.")
                        saving = false
                    }
                }
            },
        )
    }

    if (pickingDate) {
        RhythmDatePicker(initial = date, range = window, onDismiss = { pickingDate = false }) {
            date = it
            pickingDate = false
        }
    }
    if (pickingTime) {
        val state = rememberTimePickerState(initialHour = time.hour, initialMinute = time.minute)
        AlertDialog(
            onDismissRequest = { pickingTime = false },
            confirmButton = {
                TextButton(onClick = {
                    time = LocalTime.of(state.hour, state.minute)
                    pickingTime = false
                }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { pickingTime = false }) { Text("Cancel") } },
            text = { TimePicker(state = state) },
            containerColor = WF.colors.card,
        )
    }
}

/**
 * Log a completion for a day that has already passed — the completion shape restarts its
 * clock from when it was ACTUALLY done. Never later than today, and saved at noon so the
 * day can't slide across midnight once it is an instant. Port of iOS `BackdateCompletionSheet`.
 */
@Composable
fun BackdateCompletionSheet(
    rhythm: RhythmsApi.Rhythm,
    model: RhythmsModel,
    onDismiss: () -> Unit,
    onLogged: () -> Unit = {},
) {
    val zone = remember { model.zone() }
    val today = remember { WaffledDates.localDay(model.now(), zone) }
    var date by remember { mutableStateOf(today) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    RhythmSheetScaffold(title = "Log a completion", onDismiss = onDismiss) {
        SheetHeader(
            rhythm,
            "The clock restarts from the day you actually did it, ${RhythmFormat.cadenceLabel(rhythm.every)}.",
        )
        WaffledFieldCard(title = "When did you do it?") {
            PickerChip(DAY.format(date), Modifier.fillMaxWidth()) { picking = true }
        }
        SheetError(error)
        WaffledPrimaryCTA(
            label = "Log it",
            isBusy = saving,
            onClick = {
                if (saving) return@WaffledPrimaryCTA
                saving = true
                error = null
                scope.launch {
                    try {
                        val noon = date.atTime(LocalTime.NOON).atZone(zone).toInstant()
                        model.markDone(rhythm.id, on = minOf(noon, model.now()))
                        onLogged()
                        onDismiss()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        error = errorText(e, "Couldn’t log that — try again.")
                        saving = false
                    }
                }
            },
        )
    }

    if (picking) {
        RhythmDatePicker(initial = date, range = LocalDate.MIN..today, onDismiss = { picking = false }) {
            date = it
            picking = false
        }
    }
}

// ---- shared sheet pieces ----

private val DAY: DateTimeFormatter = DateTimeFormatter.ofPattern("EEE, MMM d, yyyy", Locale.US)
private val TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("h:mm a", Locale.US)

/** The sheet chrome every rhythm sheet shares: canvas, a serif title, scrolling content. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RhythmSheetScaffold(
    title: String,
    onDismiss: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = WF.type.title, color = WF.colors.ink, modifier = Modifier.weight(1f))
                TextButton(onClick = onDismiss) { Text("Cancel", color = WF.colors.ink2) }
            }
            content()
        }
    }
}

@Composable
private fun SheetHeader(rhythm: RhythmsApi.Rhythm, line: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        RhythmGlyph(rhythm)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(rhythm.title, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
            Text(line, style = TextStyle(fontSize = 13.sp), color = WF.colors.ink3)
        }
    }
}

@Composable
internal fun SheetError(error: String?) {
    if (error == null) return
    Text(error, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.danger)
}

/** A tappable value that opens a picker — the boxed-field look, since it stands in for one. */
@Composable
internal fun PickerChip(text: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Text(
        text,
        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
        color = WF.colors.ink,
        modifier = modifier
            .wfField(radius = WF.radius.sm, fill = WF.colors.panel)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    )
}

@Composable
internal fun LabeledSwitch(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            label,
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier)
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(checkedTrackColor = WF.colors.primary),
        )
    }
}

/**
 * Material3's date dialog, bounded to [range]. Its millis are UTC midnight, so they are
 * converted through UTC — through the device zone the picked day slides west of Greenwich.
 * (Pantry and Calendar carry the same wrapper; a `core:design` candidate.)
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RhythmDatePicker(
    initial: LocalDate,
    range: ClosedRange<LocalDate>?,
    onDismiss: () -> Unit,
    onPick: (LocalDate) -> Unit,
) {
    fun millis(d: LocalDate) = d.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
    val lo = range?.start?.takeIf { it != LocalDate.MIN }
    val hi = range?.endInclusive?.takeIf { it != LocalDate.MAX }
    val state = rememberDatePickerState(
        initialSelectedDateMillis = millis(initial),
        selectableDates = object : SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long): Boolean =
                (lo == null || utcTimeMillis >= millis(lo)) && (hi == null || utcTimeMillis <= millis(hi))

            override fun isSelectableYear(year: Int): Boolean =
                (lo == null || year >= lo.year) && (hi == null || year <= hi.year)
        },
    )
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                state.selectedDateMillis?.let {
                    onPick(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate())
                } ?: onDismiss()
            }) { Text("OK") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    ) {
        DatePicker(state = state)
    }
}

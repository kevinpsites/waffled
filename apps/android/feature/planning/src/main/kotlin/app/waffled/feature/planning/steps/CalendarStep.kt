package app.waffled.feature.planning.steps

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.model.WaffledDates
import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.calendar.CalendarApi
import app.waffled.feature.calendar.EventEditSheet
import app.waffled.feature.planning.PlanningEventChip
import app.waffled.feature.planning.PlanningHandoffVerb
import app.waffled.feature.planning.PlanningStepProps
import java.time.LocalDate
import java.time.ZoneId

/**
 * Weekly Planning · step 2 "Calendar" — "Here's your week. Anything missing?" Port of iOS
 * `CalendarStep.swift`: seven day rows from the synced calendar in the calendar's own chip
 * paint. The server owns the week (`props.weekStart` plus 0…6); a day over four events
 * shows "+N more", which opens that day in place; adding and editing are the calendar's own
 * `EventEditSheet`. What step 1 sent here is drawn by the shell's banner, not this body.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CalendarStepBody(props: PlanningStepProps) {
    val env = props.env
    val calendar = rememberPlanningCalendarModel(env)
    val api = remember(env) { CalendarApi(env.client, env.tokens) }
    val byDay by env.sync.eventsByDay.collectAsState()
    val zone by env.sync.householdZone.collectAsState()
    val members by env.sync.members.collectAsState()
    val palette by calendar.palette.collectAsState()
    val model = remember { PlanningCalendarModel() }
    val added by model.added.collectAsState()

    // Per day, and never reset by a sync tick: a row collapsing under someone mid-read is worse than a tall one.
    val opened = remember { mutableStateListOf<String>() }
    var composer by remember { mutableStateOf<PlanningCalendarComposer?>(null) }

    val todayKey = LocalDate.now(zone).toString()
    val days = remember(props.weekStart, todayKey) { PlanningWeekDays.days(props.weekStart, todayKey) }
    val total = remember(days, byDay) { PlanningWeekDays.eventCount(days, byDay) }
    val openDays = remember(days, byDay) { days.filter { byDay[it.day].isNullOrEmpty() }.map { it.full } }

    // Today when it is inside the planned week, else the week's first day — a Sunday session
    // usually plans the week ahead. `YYYY-MM-DD` compares lexicographically.
    val headerDay = run {
        val last = PlanningWeekDays.addDays(props.weekStart, 6)
        if (todayKey >= props.weekStart && todayKey <= last) todayKey else props.weekStart
    }
    val currentHeaderDay by rememberUpdatedState(headerDay)

    fun openComposer(dayKey: String, done: ((Boolean) -> Unit)? = null) {
        val day = runCatching { LocalDate.parse(dayKey) }.getOrElse { LocalDate.now(zone) }
        composer = PlanningCalendarComposer(day, prefillTitle = null, done = done)
    }

    LaunchedEffect(added) { if (added > 0) props.setDecisionData(model.decisionData) }
    DisposableEffect(Unit) {
        // The banner's note can't prefill the sheet's title: `EventEditSheet` has no such parameter yet.
        props.lendVerb(PlanningHandoffVerb("Make an event") { _, done -> openComposer(currentHeaderDay, done) })
        onDispose {
            props.lendVerb(null)
            props.reportBusy(false)
        }
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(PlanningWeekDays.weekRangeLabel(props.weekStart), style = WF.type.serif(20.sp), color = WF.colors.ink)
                Text(PlanningWeekDays.summary(total, openDays), style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
            }
            PlanningTextAction("+ Add an event", enabled = !props.busy, tint = WF.colors.primary) { openComposer(headerDay) }
        }

        WaffledCard(padding = 0.dp) {
            days.forEachIndexed { index, day ->
                val list = byDay[day.day].orEmpty()
                val showAll = day.key in opened || list.size <= PlanningWeekDays.ROW_MAX
                val shown = if (showAll) list else list.take(PlanningWeekDays.ROW_MAX)
                val hidden = list.size - shown.size
                Row(
                    Modifier
                        .fillMaxWidth()
                        // An open day takes a tint so it reads as an opportunity, not a hole.
                        .background(if (list.isEmpty()) WF.colors.panel.copy(alpha = 0.45f) else WF.colors.card)
                        .padding(horizontal = 13.dp, vertical = 11.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Column(Modifier.width(62.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        Text(
                            day.dow,
                            style = TextStyle(fontSize = 10.5.sp, fontWeight = FontWeight.Black, letterSpacing = 0.6.sp),
                            color = if (day.isToday) WF.colors.primary else WF.colors.ink3,
                        )
                        Text(day.date, style = WF.type.serif(17.sp), color = if (day.isToday) WF.colors.primary else WF.colors.ink)
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            shown.forEach { event ->
                                PlanningEventChip(
                                    event = event,
                                    palette = palette,
                                    owner = members.firstOrNull { it.id == event.personId },
                                    zone = zone,
                                    modifier = Modifier
                                        .clickable { composer = PlanningCalendarComposer(eventDay(event, zone) ?: day.day, null, event) }
                                        .semantics { contentDescription = "Edit ${event.title}" },
                                )
                            }
                            if (hidden > 0) {
                                Text(
                                    "+$hidden more",
                                    modifier = Modifier
                                        .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
                                        .clickable { opened += day.key }
                                        .padding(horizontal = 9.dp, vertical = 4.dp),
                                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
                                    color = WF.colors.ink2,
                                )
                            }
                        }
                        if (list.isEmpty()) {
                            Text(
                                "Nothing on the calendar",
                                modifier = Modifier.padding(vertical = 3.dp),
                                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                                color = WF.colors.ink3,
                            )
                        }
                    }
                    Box(
                        Modifier
                            .size(28.dp)
                            .background(WF.colors.panel, CircleShape)
                            .clickable(enabled = !props.busy) { openComposer(day.key) }
                            .semantics { contentDescription = "Add an event on ${day.full}, ${day.date}" },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "+",
                            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Black),
                            color = if (props.busy) WF.colors.ink3.copy(alpha = 0.5f) else WF.colors.ink2,
                        )
                    }
                }
                if (index < days.lastIndex) Box(Modifier.fillMaxWidth().height(1.dp).background(WF.colors.hair))
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                "This is everything your calendars already have. Add what isn’t here yet.",
                style = TextStyle(fontSize = 12.sp),
                color = WF.colors.ink3,
            )
            Text(
                "Busy weeks stay one screen — a day over four events shows “+N more”, which opens that day.",
                style = TextStyle(fontSize = 12.sp),
                color = WF.colors.ink3,
            )
        }
    }

    composer?.let { c ->
        EventEditSheet(
            api = api,
            zone = zone,
            members = members,
            event = c.event,
            initialDate = c.day,
            // A cancelled composer reports false, or a parked note is settled on a box opened and closed.
            onDismiss = {
                composer = null
                c.done?.invoke(false)
            },
            onSaved = {
                composer = null
                if (c.countsAsAdded) model.recordEventAdded()
                props.refresh()
                c.done?.invoke(c.countsAsAdded)
            },
        )
    }
}

/** The household-local day an event starts on, for opening the sheet on it. */
internal fun eventDay(event: SyncedEvent, zone: ZoneId): LocalDate? =
    WaffledDates.parseInstant(event.startsAt, zone)?.let { WaffledDates.localDay(it, zone) }

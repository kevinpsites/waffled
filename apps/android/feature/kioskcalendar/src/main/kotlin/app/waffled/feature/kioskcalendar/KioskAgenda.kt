package app.waffled.feature.kioskcalendar

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledIcons
import app.waffled.core.design.colorFromHex
import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.model.Person
import app.waffled.feature.calendar.Agenda
import app.waffled.feature.calendar.CalendarApi
import app.waffled.feature.calendar.CountdownCard
import app.waffled.feature.calendar.EventCard
import app.waffled.feature.calendar.EventRow
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val agendaDateFormat = DateTimeFormatter.ofPattern("EEE · MMM d", Locale.getDefault())
private val miniMonthFormat = DateTimeFormatter.ofPattern("MMMM", Locale.getDefault())

/** Agenda: the upcoming list, with a mini-month, the AI heads-up and busy bars beside it. */
@Composable
internal fun KioskAgenda(
    byDay: Map<LocalDate, List<EventRow>>,
    countdownsByDate: Map<String, List<CalendarApi.Countdown>>,
    sleeps: Boolean,
    today: LocalDate,
    zone: ZoneId,
    weekStart: HouseholdWeekStart,
    members: List<Person>,
    miniAnchor: LocalDate,
    headsUp: KioskCalendarApi.HeadsUp?,
    onStepMini: (Int) -> Unit,
    onPickDay: (LocalDate) -> Unit,
    onOpenEvent: (EventRow) -> Unit,
    onOpenCountdown: (CalendarApi.Countdown) -> Unit,
    modifier: Modifier = Modifier,
) {
    val days = remember(byDay, countdownsByDate, today) {
        val eventDays = Agenda.upcoming(byDay, today).mapTo(mutableSetOf()) { it.day }
        val countdownDays = countdownsByDate.filterValues { it.isNotEmpty() }.keys
        KioskCalendar.agendaDays(eventDays, countdownDays, today)
    }
    // One clock read per data change, not one per row.
    val now = remember(byDay) { Instant.now() }

    Row(modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
        LazyColumn(
            Modifier.weight(1f).fillMaxHeight(),
            contentPadding = PaddingValues(bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            item { Text("What's coming up", style = WF.type.serif(28.sp), color = WF.colors.ink) }
            if (days.isEmpty()) {
                item {
                    Text(
                        text = "Nothing upcoming.",
                        modifier = Modifier.padding(vertical = 14.dp),
                        style = TextStyle(fontSize = 16.sp),
                        color = WF.colors.ink3,
                    )
                }
            }
            for (day in days) {
                item(key = day.toString()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
                            Text(KioskCalendar.relativeLabel(day, today), style = WF.type.serif(20.sp), color = WF.colors.ink)
                            Text(
                                text = agendaDateFormat.format(day),
                                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                                color = WF.colors.ink3,
                            )
                        }
                        for (c in countdownsByDate[day.toString()].orEmpty()) {
                            CountdownCard(countdown = c, sleeps = sleeps, onClick = { onOpenCountdown(c) })
                        }
                        for (row in byDay[day].orEmpty()) {
                            EventCard(row = row, isPast = Agenda.isPast(row, zone, now), onClick = { onOpenEvent(row) })
                        }
                    }
                }
            }
        }

        Column(
            Modifier
                .width(360.dp)
                .fillMaxHeight()
                .verticalScroll(rememberScrollState())
                .padding(bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            MiniMonth(miniAnchor, weekStart, byDay, today, onStepMini, onPickDay)
            HeadsUpCard(headsUp)
            BusyCard(remember(byDay, today, weekStart, members) {
                KioskCalendar.busyRows(byDay, KioskCalendar.weekDays(today, weekStart), members)
            })
        }
    }
}

@Composable
private fun MiniMonth(
    anchor: LocalDate,
    weekStart: HouseholdWeekStart,
    byDay: Map<LocalDate, List<EventRow>>,
    today: LocalDate,
    onStep: (Int) -> Unit,
    onPick: (LocalDate) -> Unit,
) {
    val rows = remember(anchor, weekStart) { KioskCalendar.monthRows(anchor, weekStart) }
    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(miniMonthFormat.format(anchor), style = WF.type.serif(20.sp), color = WF.colors.ink)
            Spacer(Modifier.weight(1f))
            MiniChevron(Icons.Filled.ChevronLeft, "Previous month") { onStep(-1) }
            Spacer(Modifier.width(8.dp))
            MiniChevron(Icons.Filled.ChevronRight, "Next month") { onStep(1) }
        }
        Row {
            for (label in KioskCalendar.miniWeekdayHeaders(weekStart)) {
                Text(
                    text = label,
                    modifier = Modifier.weight(1f),
                    style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.ExtraBold),
                    color = WF.colors.ink3,
                    textAlign = TextAlign.Center,
                )
            }
        }
        for (week in rows) {
            Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                for (cell in week) {
                    val isToday = cell.date == today
                    val dots = KioskCalendar.dotColors(byDay[cell.date].orEmpty()).take(3)
                    Column(
                        Modifier.weight(1f).clickable { onPick(cell.date) },
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Box(
                            Modifier.size(26.dp).background(if (isToday) WF.colors.primary else Color.Transparent, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = "${cell.dayOfMonth}",
                                style = TextStyle(fontSize = 13.sp, fontWeight = if (isToday) FontWeight.ExtraBold else FontWeight.SemiBold),
                                color = when {
                                    !cell.inMonth -> WF.colors.ink3.copy(alpha = 0.5f)
                                    isToday -> Color.White
                                    else -> WF.colors.ink
                                },
                            )
                        }
                        Row(Modifier.height(4.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                            for (hex in dots) {
                                Box(Modifier.size(4.dp).background(colorFromHex(hex) ?: WF.colors.ink3, CircleShape))
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(2.dp))
        }
    }
}

@Composable
private fun MiniChevron(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(28.dp)
            .clip(CircleShape)
            .background(WF.colors.panel, CircleShape)
            .clickable(onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = WF.colors.ink2, modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun HeadsUpCard(headsUp: KioskCalendarApi.HeadsUp?) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.ai.copy(alpha = 0.06f), shape)
            .border(1.dp, WF.colors.ai.copy(alpha = 0.2f), shape)
            .padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(32.dp).background(WF.colors.ai.copy(alpha = 0.12f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(WaffledIcons.Sparkles, contentDescription = null, tint = WF.colors.ai, modifier = Modifier.size(16.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                text = headsUp?.headline ?: "Heads up this week",
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.ExtraBold),
                color = WF.colors.ink,
            )
            if (headsUp != null) {
                Text(headsUp.body, style = TextStyle(fontSize = 13.sp), color = WF.colors.ink2)
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Thinking…", style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
                    CircularProgressIndicator(Modifier.size(14.dp), color = WF.colors.ai, strokeWidth = 2.dp)
                }
            }
        }
    }
}

@Composable
private fun BusyCard(rows: List<KioskCalendar.BusyRow>) {
    if (rows.isEmpty()) return
    val maxCount = rows.maxOf { it.count }.coerceAtLeast(1)
    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Whose week is busy?", style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.ExtraBold), color = WF.colors.ink)
        for (row in rows) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                AvatarFromHex(colorHex = row.person.colorHex, emoji = row.person.avatarEmoji ?: "🙂", size = 28.dp)
                Text(
                    text = row.person.name,
                    modifier = Modifier.width(66.dp),
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                // Per-person colour is identity data, one of the two literal-colour exceptions.
                val tint = colorFromHex(row.person.colorHex) ?: WF.colors.ink3
                Box(Modifier.weight(1f).height(10.dp).background(tint.copy(alpha = 0.18f), CircleShape)) {
                    Box(
                        Modifier
                            .fillMaxWidth(row.count.toFloat() / maxCount)
                            .fillMaxHeight()
                            .background(tint, CircleShape),
                    )
                }
                Text("${row.count}", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.ExtraBold), color = WF.colors.ink2)
            }
        }
    }
}

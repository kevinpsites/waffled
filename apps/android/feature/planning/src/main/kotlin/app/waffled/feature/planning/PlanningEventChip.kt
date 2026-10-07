package app.waffled.feature.planning

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.WF
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledDates
import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.calendar.EventChipPaint
import app.waffled.feature.calendar.EventEnd
import app.waffled.feature.calendar.EventPalette
import app.waffled.feature.calendar.EventPeople
import app.waffled.feature.calendar.color
import java.time.ZoneId

/**
 * One event as a planning step draws it: a coloured time, the title and the owner's
 * bubble, in the calendar's own chip paint so the household's solid/tinted style applies.
 * Shared by the Calendar step's week and Family night's event picker.
 *
 * [palette] comes from the household (calendar's `CalendarModel.palette`); [owner] is the
 * event's `personId` resolved against the members.
 */
@Composable
fun PlanningEventChip(
    event: SyncedEvent,
    palette: EventPalette,
    owner: Person?,
    zone: ZoneId,
    modifier: Modifier = Modifier,
) {
    val people = EventPeople(
        ownerPersonId = event.personId,
        ownerColorHex = owner?.colorHex,
        ownerAvatarEmoji = owner?.avatarEmoji,
    )
    val paint = EventChipPaint.of(
        color = palette.color(people, fallback = WF.colors.ink3),
        style = palette.style,
        ink = WF.colors.ink,
        isDark = WF.colors.isDark,
    )
    val emoji = owner?.avatarEmoji?.takeIf { it.isNotBlank() }
    Row(
        modifier
            // A long title truncates instead of pushing past the row on a phone.
            .widthIn(max = 220.dp)
            .clip(RoundedCornerShape(WF.radius.pill))
            .background(paint.background)
            .padding(start = 10.dp, end = if (emoji == null) 10.dp else 4.dp, top = 4.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            timeLabel(event, zone),
            style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
            color = paint.foreground.copy(alpha = 0.8f),
            maxLines = 1,
        )
        Text(
            event.title,
            modifier = Modifier.weight(1f, fill = false),
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
            color = paint.foreground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (emoji != null) AvatarFromHex(colorHex = owner.colorHex, emoji = emoji, size = 20.dp)
    }
}

/** "1:00 PM" in the household's zone, or a real "All day" label. */
private fun timeLabel(event: SyncedEvent, zone: ZoneId): String {
    if (event.allDay) return "All day"
    val start = WaffledDates.parseInstant(event.startsAt, zone) ?: return ""
    return EventEnd.timeLabel(start.atZone(zone).toLocalTime())
}

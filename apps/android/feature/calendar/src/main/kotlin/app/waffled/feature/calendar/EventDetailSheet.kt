package app.waffled.feature.calendar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.automirrored.filled.Notes
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.Avatar
import app.waffled.core.design.LockNote
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.colorFromHex
import app.waffled.core.model.WaffledDates
import java.time.ZoneId

/**
 * One event's full detail — the sheet a tapped agenda row opens, and the route to the
 * editor.
 *
 * The rich fields (recurrence, source calendar, named participants) come over REST and the
 * thin synced mirror doesn't carry them, so the sheet opens IMMEDIATELY on what it already
 * has and fills in as the detail lands. A spinner over an event whose title is already
 * known would be a worse trade.
 *
 * The read-only gate takes the server's origin when it has one and the mirror's otherwise —
 * never "editable" merely because the network is slow. The gate is repeated on the EDIT
 * SHEET itself, which is the one that actually protects the write.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun EventDetailSheet(
    api: CalendarApi,
    row: EventRow,
    zone: ZoneId,
    onDismiss: () -> Unit,
    onEdit: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var detail by remember { mutableStateOf<CalendarApi.EventDetail?>(null) }

    LaunchedEffect(row.id) {
        detail = runCatching { api.eventDetail(row.id) }.getOrNull()
    }

    val readOnly = EventOrigin.isReadOnly(
        detailOrigin = detail?.origin,
        mirrorOrigin = row.event.origin,
    )

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
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(text = row.title, style = WF.type.hero, color = WF.colors.ink)

            DetailRow(Icons.Filled.Schedule, dayAndTime(row, zone))

            (detail?.location ?: row.location)?.takeIf { it.isNotBlank() }?.let {
                DetailRow(Icons.Filled.Place, it)
            }

            detail?.rrule?.takeIf { it.isNotEmpty() }?.let { rrule ->
                DetailRow(Icons.Filled.Repeat, Recurrence.describeRrule(rrule, row.day))
            }

            detail?.calendarName?.takeIf { it.isNotBlank() }?.let {
                DetailRow(Icons.Filled.CalendarMonth, it)
            }

            detail?.description?.takeIf { it.isNotBlank() }?.let {
                DetailRow(Icons.AutoMirrored.Filled.Notes, it)
            }

            detail?.participants?.takeIf { it.isNotEmpty() }?.let { participants ->
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for (person in participants) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Avatar(
                                emoji = person.avatarEmoji ?: person.name.take(1).uppercase(),
                                tint = colorFromHex(person.colorHex)?.copy(alpha = 0.16f)
                                    ?: WF.colors.panel,
                                size = 26.dp,
                            )
                            Text(
                                text = person.name,
                                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                                color = WF.colors.ink2,
                            )
                        }
                    }
                }
            }

            if (readOnly) {
                LockNote(text = EventOrigin.READ_ONLY_NOTE)
            } else {
                WaffledPrimaryCTA(label = "Edit event", onClick = onEdit)
            }
        }
    }
}

/** "Tue · Jun 16 · 8:30 AM", or "Tue · Jun 16 · All day". */
private fun dayAndTime(row: EventRow, zone: ZoneId): String {
    val day = WaffledDates.format(
        row.day.atStartOfDay(zone).toInstant(),
        "EEE · MMM d",
        zone,
    )
    return if (row.timeLabel.isEmpty()) day else "$day · ${row.timeLabel}"
}

@Composable
private fun DetailRow(icon: ImageVector, text: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = WF.colors.ink3,
            modifier = Modifier.size(16.dp),
        )
        Text(
            text = text,
            style = TextStyle(fontSize = 15.sp),
            color = WF.colors.ink2,
        )
    }
}

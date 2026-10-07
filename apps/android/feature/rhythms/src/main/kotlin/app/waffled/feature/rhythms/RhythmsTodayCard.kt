package app.waffled.feature.rhythms

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.MoreHoriz
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * The Today card for Rhythms (layout key `rhythms`) — port of iOS `RhythmsTodayCard`.
 *
 * Shows only what needs attention today and renders NOTHING otherwise: most days a
 * quarterly register is quiet, and an empty card every morning is how a board stops being
 * read. Gate it on the `rhythms` module (default off) at the call site.
 *
 * [onChanged] fires after any successful write — the integrator bumps whatever the
 * countdown chips listen to, since a completion rhythm is a countdown source.
 */
@Composable
fun RhythmsTodayCard(
    model: RhythmsModel,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
    kiosk: Boolean = false,
    /** Today's pull-to-refresh revision; keyed on it so a refresh refetches. */
    refreshKey: Any? = Unit,
    onChanged: () -> Unit = {},
) {
    val state by model.state.collectAsStateWithLifecycle()
    // Outside the emptiness gate: quiet is the initial state, so a load placed inside it
    // would never run and the card would stay empty forever.
    LaunchedEffect(refreshKey) { model.loadAttention() }

    // Above the emptiness gate: handling the last item empties the list, and a scope that
    // left composition with the card would cancel the write's follow-up (and onChanged).
    val scope = rememberCoroutineScope()
    var busyId by remember { mutableStateOf<String?>(null) }
    var booking by remember { mutableStateOf<RhythmsApi.AttentionItem?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    fun run(id: String, work: suspend () -> Unit) {
        if (busyId != null) return
        busyId = id
        scope.launch {
            try {
                work()
                onChanged()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = errorText(e)
            } finally {
                busyId = null
            }
        }
    }

    val cap = 4
    if (state.attention.isNotEmpty()) {
        // The header's "All N" needs the whole register — asked for only on days this renders.
        LaunchedEffect(refreshKey) { model.loadAll() }
        WaffledCard(modifier = modifier, padding = 15.dp) {
            Column(verticalArrangement = Arrangement.spacedBy(if (kiosk) 12.dp else 10.dp)) {
                Header(state, kiosk, onOpen)
                for (item in state.attention.take(cap)) {
                    AttentionRow(
                        item = item,
                        status = state.statusLines[item.rhythm.id].orEmpty(),
                        kiosk = kiosk,
                        busy = busyId == item.rhythm.id,
                        urgent = remember(item, state.statusLines) { isUrgent(item, model) },
                        onDone = { run(item.rhythm.id) { model.markDone(item.rhythm.id) } },
                        onBook = { booking = item },
                        onSkip = { run(item.rhythm.id) { model.skipPeriod(item) } },
                    )
                }
                if (state.attention.size > cap) {
                    Text(
                        "+${state.attention.size - cap} more",
                        style = TextStyle(fontSize = if (kiosk) 13.sp else 11.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                }
            }
        }
    }

    booking?.let { item ->
        BookRhythmSheet(item = item, model = model, onDismiss = { booking = null }, onBooked = onChanged)
    }
    RhythmErrorDialog(error) { error = null }
}

@Composable
private fun Header(state: RhythmsState, kiosk: Boolean, onOpen: () -> Unit) {
    val n = state.attention.size
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onOpen),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "🔁 Rhythms",
            style = if (kiosk) {
                TextStyle(fontSize = 16.sp, fontWeight = FontWeight.ExtraBold)
            } else {
                TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold)
            },
            color = if (kiosk) WF.colors.ink else WF.colors.ink2,
            maxLines = 1,
        )
        // Dropped first when the column is narrow; the title and the way in stay.
        Text(
            if (n == 1) "1 wants attention" else "$n want attention",
            style = TextStyle(fontSize = if (kiosk) 13.sp else 12.sp),
            color = WF.colors.ink3,
            maxLines = 1,
            overflow = TextOverflow.Clip,
            modifier = Modifier.weight(1f),
        )
        // Held back until the count has arrived rather than flashing "All 0".
        Text(
            if (state.rhythms.isEmpty()) "All" else "All ${state.rhythms.size}",
            style = TextStyle(fontSize = if (kiosk) 13.sp else 12.sp),
            color = WF.colors.ink3,
            maxLines = 1,
        )
        Icon(
            Icons.AutoMirrored.Filled.ArrowForward,
            contentDescription = "Open Rhythms",
            tint = WF.colors.ink3,
            modifier = Modifier.size(if (kiosk) 14.dp else 13.dp),
        )
    }
}

@Composable
private fun AttentionRow(
    item: RhythmsApi.AttentionItem,
    status: String,
    kiosk: Boolean,
    busy: Boolean,
    urgent: Boolean,
    onDone: () -> Unit,
    onBook: () -> Unit,
    onSkip: () -> Unit,
) {
    val overdue = item.kind == AttentionKind.Due && item.overdue == true
    val tint: Color = if (urgent) WF.colors.primary else WF.colors.panel
    val label: Color = if (urgent) Color.White else WF.colors.ink
    Row(
        horizontalArrangement = Arrangement.spacedBy(if (kiosk) 12.dp else 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RhythmGlyph(item.rhythm, kiosk)
        // weight(1f) lets the title truncate while the verb never wraps.
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                item.rhythm.title,
                style = TextStyle(fontSize = if (kiosk) 18.sp else 14.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                subtitle(item, status),
                style = TextStyle(fontSize = if (kiosk) 13.sp else 11.sp),
                color = if (overdue) WF.colors.danger else WF.colors.ink3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        when (item.kind) {
            AttentionKind.Due -> RhythmActionButton(
                label = "I did it", tint = tint, labelColor = label, onClick = onDone, kiosk = kiosk, busy = busy,
            )
            AttentionKind.Unscheduled -> Row(
                horizontalArrangement = Arrangement.spacedBy(if (kiosk) 8.dp else 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RhythmActionButton(
                    label = if (RhythmsModel.needsSeriesBack(item.rhythm, item.hasSeries)) "Put it back" else "Book a time",
                    tint = tint, labelColor = label, onClick = onBook, kiosk = kiosk,
                )
                SkipMenu(kiosk = kiosk, enabled = !busy, onSkip = onSkip)
            }
            AttentionKind.Unknown -> Spacer(Modifier.width(0.dp))
        }
    }
}

/** Skipping is the quiet way out of a period, tucked away so booking stays the obvious verb. */
@Composable
private fun SkipMenu(kiosk: Boolean, enabled: Boolean, onSkip: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, enabled = enabled, modifier = Modifier.size(if (kiosk) 32.dp else 28.dp)) {
            Icon(
                Icons.Filled.MoreHoriz,
                contentDescription = "More options",
                tint = WF.colors.ink3,
                modifier = Modifier.size(if (kiosk) 20.dp else 17.dp),
            )
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = WF.colors.card) {
            DropdownMenuItem(
                text = { Text("Mark handled", color = WF.colors.ink) },
                onClick = {
                    open = false
                    onSkip()
                },
            )
        }
    }
}

/** Countdown first, cadence second — on a board the cadence is the half you already know. */
private fun subtitle(item: RhythmsApi.AttentionItem, status: String): String = when (item.kind) {
    AttentionKind.Due -> "$status · ${RhythmFormat.cadenceLabel(item.rhythm.every)}"
    AttentionKind.Unscheduled ->
        if (!RhythmsModel.needsSeriesBack(item.rhythm, item.hasSeries)) {
            status
        } else if (status.isEmpty()) {
            "The series needs putting back"
        } else {
            "$status · the series needs putting back"
        }
    AttentionKind.Unknown -> status
}

/** Emphasis only for what is late, or a booking window with a day left in it. */
private fun isUrgent(item: RhythmsApi.AttentionItem, model: RhythmsModel): Boolean {
    if (item.kind == AttentionKind.Due && item.overdue == true) return true
    if (item.kind != AttentionKind.Unscheduled) return false
    val zone = model.zone()
    val end = item.bookableUntil?.let { RhythmFormat.moment(it, zone) } ?: return false
    return RhythmFormat.dayDiff(end, model.now(), zone) <= 1
}

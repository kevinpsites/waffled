package app.waffled.feature.calendar

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material3.Icon
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.colorFromHex
import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.launch

/** How many rows fit before the card collapses the rest into "+N more". */
private const val PHONE_ROW_CAP = 6

/** Days out at which a countdown starts reading as urgent. */
private const val SOON_DAYS = 7

/**
 * The countdowns card — "N days until X", from a flagged event, a standalone item or a
 * member's next birthday, merged and sorted server-side.
 *
 * Self-contained: it owns its add / edit sheets, so any screen can drop it in without
 * re-wiring. Only STANDALONE rows are interactive here; events and birthdays are managed at
 * their source, so their rows neither tap nor offer the ✕.
 *
 * **Scope:** the phone card only. The tablet variant (larger type, fewer rows) is Phase 4.
 */
@Composable
fun CountdownsCard(
    model: CountdownsModel,
    modifier: Modifier = Modifier,
    onOpenEvent: (eventId: String) -> Unit = {},
    /**
     * Bumped when something that feeds a countdown changed elsewhere on screen — a rhythm
     * marked done moves its due date, and the chip beside it must not keep the old one.
     */
    refreshKey: Any? = null,
) {
    val scope = rememberCoroutineScope()
    val items by model.itemsState.collectAsStateWithLifecycle()
    val sleeps by model.sleepsState.collectAsStateWithLifecycle()
    val loaded by model.loadedState.collectAsStateWithLifecycle()

    var adding by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<CalendarApi.Countdown?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(refreshKey) { if (!loaded || refreshKey != null) model.load() }

    WaffledCard(modifier = modifier, padding = 15.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "Countdowns",
                    style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink2,
                )
                Spacer(Modifier.weight(1f))
                Row(
                    modifier = Modifier.clickable { adding = true },
                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Add,
                        contentDescription = null,
                        tint = WF.colors.ai,
                        modifier = Modifier.size(14.dp),
                    )
                    Text(
                        text = "Add",
                        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ai,
                    )
                }
            }

            error?.let { DismissibleErrorBanner(message = it, onDismiss = { error = null }) }

            if (items.isEmpty()) {
                Text(
                    text = if (loaded) {
                        "Nothing to count down to yet — add a trip; birthdays are automatic."
                    } else {
                        "Loading…"
                    },
                    style = TextStyle(fontSize = 13.sp),
                    color = WF.colors.ink3,
                )
            } else {
                for (countdown in items.take(PHONE_ROW_CAP)) {
                    CountdownRow(
                        countdown = countdown,
                        sleeps = sleeps,
                        onTap = {
                            when (countdown.source) {
                                "standalone" -> editing = countdown
                                // An event-sourced countdown carries the EVENT's id.
                                "event" -> onOpenEvent(countdown.id)
                                // A birthday is managed on the person's profile.
                                else -> Unit
                            }
                        },
                        onRemove = {
                            scope.launch {
                                runCatching { model.remove(countdown) }.onFailure { failure ->
                                    error = (failure as? WaffledApiException)?.userMessage
                                        ?: "Couldn't remove this countdown. Check your connection and try again."
                                }
                            }
                        },
                    )
                }
                if (items.size > PHONE_ROW_CAP) {
                    Text(
                        text = "+${items.size - PHONE_ROW_CAP} more",
                        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                }
            }
        }
    }

    if (adding) {
        AddCountdownSheet(
            onDismiss = { adding = false },
            onAdd = { title, date, emoji -> model.add(title, date, emoji) },
        )
    }

    editing?.let { countdown ->
        EditCountdownSheet(
            countdown = countdown,
            onDismiss = { editing = null },
            onSave = { title, date, emoji -> model.update(countdown, title, date, emoji) },
            onRemove = { model.remove(countdown) },
        )
    }
}

@Composable
private fun CountdownRow(
    countdown: CalendarApi.Countdown,
    sleeps: Boolean,
    onTap: () -> Unit,
    onRemove: () -> Unit,
) {
    val soon = countdown.daysLeft <= SOON_DAYS
    Row(
        modifier = Modifier
            .fillMaxWidth()
            // Only standalone rows lead anywhere; the others would be a dead tap.
            .clickable(enabled = countdown.isStandalone, onClick = onTap),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WaffledEmojiTile(
            emoji = countdown.emoji ?: "📅",
            size = 17.dp,
            frame = 32.dp,
            // Real per-person colour data — one of the two documented cases where a literal
            // colour value is correct — washed so the emoji stays the focus.
            background = colorFromHex(countdown.color)?.copy(alpha = 0.16f) ?: WF.colors.panel,
            cornerRadius = 9.dp,
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                text = countdown.title,
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = CountdownFormat.dateLabel(countdown.date),
                style = TextStyle(fontSize = 11.sp),
                color = WF.colors.ink3,
            )
        }
        Spacer(Modifier.width(4.dp))
        Text(
            text = CountdownFormat.label(countdown.daysLeft, sleeps),
            style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
            color = if (soon) WF.colors.primaryD else WF.colors.ink2,
        )
        if (countdown.isStandalone) {
            Icon(
                imageVector = Icons.Filled.Cancel,
                contentDescription = "Remove ${countdown.title}",
                tint = WF.colors.ink3,
                modifier = Modifier
                    .size(17.dp)
                    .clickable(onClick = onRemove),
            )
        }
    }
}

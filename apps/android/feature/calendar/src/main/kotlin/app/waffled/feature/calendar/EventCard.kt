package app.waffled.feature.calendar

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.WF
import app.waffled.core.design.colorFromHex
import app.waffled.core.design.wfShadow1

/** The time column's width, so every row's title starts on the same vertical line. */
private val TimeColumnWidth = 72.dp

/** The accent bar — a coloured stripe, not a filled chip, so a dense day stays readable. */
private val AccentBarWidth = 4.dp
private val AccentBarHeight = 34.dp

/** How far a finished event fades. Enough to recede, not enough to be unreadable. */
private const val PastAlpha = 0.5f

/**
 * One agenda event as its own rounded card — time, event colour bar, title, owner avatar.
 *
 * The bar takes the family colour on a whole-family event; the avatar stays the OWNER's,
 * because that is identity rather than categorisation.
 *
 * Every value it draws is precomputed on [EventRow]; the card itself does no date maths and
 * no colour resolution, which is what keeps a long agenda smooth.
 */
@Composable
fun EventCard(
    row: EventRow,
    isPast: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(WF.radius.lg)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .wfShadow1(shape)
            .background(WF.colors.card, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 15.dp, vertical = 13.dp)
            // Subtly fade events that have already finished, so the eye lands on what is
            // still ahead.
            .alpha(if (isPast) PastAlpha else 1f),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = row.timeLabel,
            modifier = Modifier.width(TimeColumnWidth),
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ink2,
        )
        AccentBar(colorFromHex(row.colorHex) ?: WF.colors.ink3)
        Text(
            text = row.title,
            modifier = Modifier.weight(1f),
            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (row.isReadOnly) {
            // A glance-level hint that this row came from a subscribed feed; the full
            // explanation is the LockNote on the detail and edit surfaces.
            Icon(
                imageVector = Icons.Filled.Lock,
                contentDescription = "From a subscribed calendar",
                tint = WF.colors.ink3,
                modifier = Modifier.size(13.dp),
            )
        }
        row.ownerEmoji?.let { emoji ->
            AvatarFromHex(colorHex = row.people.ownerColorHex, emoji = emoji, size = 30.dp)
        }
    }
}

/**
 * A countdown rendered like an all-day event row — the same card as [EventCard] — so
 * countdowns appear inline in the agenda and the month day-list. The "time" column shows
 * the days-left instead of a clock.
 */
@Composable
fun CountdownCard(
    countdown: CalendarApi.Countdown,
    sleeps: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(WF.radius.lg)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .wfShadow1(shape)
            .background(WF.colors.card, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 15.dp, vertical = 13.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = CountdownFormat.label(countdown.daysLeft, sleeps),
            modifier = Modifier.width(TimeColumnWidth),
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.warn,
        )
        // `countdown.color` is real per-person data, one of the two documented cases where
        // a literal colour value is correct; `warn` is the token fallback.
        AccentBar(colorFromHex(countdown.color) ?: WF.colors.warn)
        Text(
            text = countdown.title,
            modifier = Modifier.weight(1f),
            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.width(2.dp))
        Text(text = countdown.emoji ?: "⏳", style = TextStyle(fontSize = 20.sp))
    }
}

/**
 * The rounded colour stripe both cards lead with.
 *
 * Hand-rolled: this is a 4×34dp pill of pure colour with no text, no state and no
 * interaction — no Material3 control expresses it, and `Divider`/`VerticalDivider` carry
 * the wrong semantics (a separator, not an identity marker).
 */
@Composable
private fun AccentBar(color: Color) {
    Box(
        Modifier
            .width(AccentBarWidth)
            .height(AccentBarHeight)
            .background(color, RoundedCornerShape(WF.radius.pill)),
    )
}

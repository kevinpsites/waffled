package app.waffled.feature.rhythms

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmojiTile

internal const val MUTATION_FALLBACK = "That didn’t stick — check your connection and try again."

/** A rhythm's glyph — its emoji, defaulting per shape. Tile on the phone, bare on the wall display. */
@Composable
fun RhythmGlyph(rhythm: RhythmsApi.Rhythm, kiosk: Boolean = false) {
    val glyph = rhythm.emoji?.takeIf { it.isNotBlank() }
        ?: if (rhythm.shape == RhythmShape.Scheduling) "🗓️" else "🔁"
    if (kiosk) {
        Text(glyph, style = TextStyle(fontSize = 22.sp))
    } else {
        WaffledEmojiTile(emoji = glyph, size = 17.dp, frame = 32.dp, cornerRadius = 9.dp)
    }
}

/** The register row's anchor: the number large, its unit small underneath. */
@Composable
fun RhythmCountdownLabel(countdown: RhythmFormat.Countdown, muted: Boolean = false) {
    val booked = countdown.tone == RhythmFormat.Countdown.Tone.Done
    val tint = when {
        muted -> WF.colors.ink3
        else -> when (countdown.tone) {
            RhythmFormat.Countdown.Tone.Done -> WF.colors.success
            RhythmFormat.Countdown.Tone.Late -> WF.colors.danger
            RhythmFormat.Countdown.Tone.Near -> WF.colors.ink
            RhythmFormat.Countdown.Tone.Soft -> WF.colors.ink2
        }
    }
    Column(
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(1.dp),
        modifier = Modifier.clearAndSetSemantics {
            contentDescription = "${countdown.number} ${countdown.unit}"
        },
    ) {
        Text(
            countdown.number,
            // A word like "Booked" doesn't get the display size — set large it shouts.
            style = if (booked) {
                TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold)
            } else {
                WF.type.serif(21.sp, FontWeight.SemiBold)
            },
            color = tint,
            maxLines = 1,
        )
        Text(
            countdown.unit,
            style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
            color = if (muted || countdown.tone != RhythmFormat.Countdown.Tone.Late) WF.colors.ink3 else WF.colors.danger,
            maxLines = 1,
        )
    }
}

/** How much of the current cycle is spent — a hairline, not a chart. */
@Composable
fun RhythmProgressBar(percent: Int, late: Boolean, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Box(
        modifier
            .widthIn(max = 260.dp)
            .fillMaxWidth()
            .height(3.dp)
            .clip(shape)
            .background(WF.colors.hair),
    ) {
        Box(
            Modifier
                .fillMaxHeight()
                .fillMaxWidth(percent.coerceIn(0, 100) / 100f)
                .clip(shape)
                .background(if (late) WF.colors.danger else WF.colors.ink3.copy(alpha = 0.55f)),
        )
    }
}

/**
 * The compact inline verb ("I did it", "Book a time"). A tinted capsule rather than
 * `WaffledPrimaryCTA`, which is the full-width bottom-of-sheet shape. [labelColor] is
 * white only on a saturated fill; a wash passes its own ink.
 */
@Composable
fun RhythmActionButton(
    label: String,
    tint: Color,
    labelColor: Color,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kiosk: Boolean = false,
    busy: Boolean = false,
    disabled: Boolean = false,
    /** The register's own-line verb: fills the row, capped so a wall display isn't one slab. */
    fullWidth: Boolean = false,
) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Row(
        modifier = modifier
            .then(if (fullWidth) Modifier.widthIn(max = 420.dp).fillMaxWidth() else Modifier)
            .clip(shape)
            .background(tint)
            .clickable(enabled = !busy && !disabled, onClick = onClick)
            .padding(
                horizontal = if (kiosk) 12.dp else 10.dp,
                vertical = if (fullWidth) 10.dp else if (kiosk) 7.dp else 5.dp,
            ),
        horizontalArrangement = Arrangement.spacedBy(5.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) CircularProgressIndicator(color = labelColor, strokeWidth = 2.dp, modifier = Modifier.size(12.dp))
        Text(
            label,
            style = TextStyle(fontSize = if (kiosk || fullWidth) 14.sp else 12.sp, fontWeight = FontWeight.Bold),
            color = labelColor,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Visible,
        )
    }
}

/** "Rhythm unchanged" — the mutation failure, relayed from the server where it said why. */
@Composable
internal fun RhythmErrorDialog(message: String?, onDismiss: () -> Unit) {
    if (message == null) return
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("OK") } },
        title = { Text("Rhythm unchanged") },
        text = { Text(message) },
        containerColor = WF.colors.card,
        titleContentColor = WF.colors.ink,
        textContentColor = WF.colors.ink2,
    )
}

/** The server's own words for a failed write, or [fallback] when it said nothing useful. */
internal fun errorText(e: Throwable, fallback: String = MUTATION_FALLBACK): String =
    (e as? app.waffled.core.network.WaffledApiException)?.userMessage?.takeIf { it.isNotBlank() } ?: fallback

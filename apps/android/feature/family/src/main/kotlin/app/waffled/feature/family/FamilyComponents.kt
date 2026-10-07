package app.waffled.feature.family

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF

/**
 * Thin rounded progress bar (iOS `ProgressBar`). `core:design` has none and the Today
 * module's copy is off-limits; Material's `LinearProgressIndicator` draws a track gap and
 * stop dot this design doesn't have. Two capsules is the whole widget.
 */
@Composable
internal fun FamilyProgressBar(
    value: Double,
    tint: Color,
    track: Color,
    modifier: Modifier = Modifier,
    height: Dp = 7.dp,
) {
    val pill = RoundedCornerShape(WF.radius.pill)
    Box(modifier.fillMaxWidth().height(height).background(track, pill).clip(pill)) {
        Box(
            Modifier
                .fillMaxWidth(value.coerceIn(0.0, 1.0).toFloat())
                .fillMaxHeight()
                .background(tint, pill),
        )
    }
}

/** The spotlight's titled card: bold 15 title over its content, hairline-bordered. */
@Composable
internal fun SpotlightCard(
    title: String,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .padding(15.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(title, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
        content()
    }
}

/**
 * The "this may not be the whole picture" line above a REST-backed surface. iOS draws
 * `RestStateNotice`; `core:design` has no twin yet, so this is the minimal version: one
 * line plus a Retry.
 *
 * TODO(RestState): swap for the shared notice once RestState lands, which can also say
 * offline vs. sign-in-required.
 */
@Composable
internal fun FamilyRestNotice(
    visible: Boolean,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    message: String = "Some of this couldn’t load.",
) {
    if (!visible) return
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        modifier
            .fillMaxWidth()
            .background(WF.colors.warnT, shape)
            .clip(shape)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            message,
            modifier = Modifier.weight(1f),
            style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink2,
        )
        Text(
            "Retry",
            modifier = Modifier.clickable(onClick = onRetry).padding(horizontal = 4.dp, vertical = 2.dp),
            style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.warn,
        )
    }
}

/** A gold count capsule ("9+" past nine). White is right on the saturated gold fill. */
@Composable
internal fun CountBadge(count: Int, modifier: Modifier = Modifier) {
    val pill = RoundedCornerShape(WF.radius.pill)
    Text(
        text = if (count > 9) "9+" else "$count",
        modifier = modifier
            .background(WF.colors.gold, pill)
            .border(1.5.dp, WF.colors.card, pill)
            .padding(horizontal = if (count > 9) 4.dp else 5.dp, vertical = 1.5.dp),
        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Black),
        color = Color.White,
    )
}

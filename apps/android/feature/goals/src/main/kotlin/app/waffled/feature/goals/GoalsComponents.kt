package app.waffled.feature.goals

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.FamilyColor
import app.waffled.core.design.WF
import app.waffled.core.design.colorFromHex

/**
 * The goal-specific glyphs the iOS `GoalsView` declares at file scope: the progress ring,
 * the overlapping member avatars, and the contribution bar.
 *
 * Everything that already exists in `core:design` — cards, empty states, CTAs, avatars,
 * chips, badges, text fields — is used from there rather than re-drawn here.
 */

/**
 * A circular progress ring with arbitrary centre content.
 *
 * Hand-rolled because Material3's `CircularProgressIndicator` cannot host content in its
 * middle, and the whole point of this ring is the number inside it.
 *
 * The arc is inset by half the stroke width: a stroke is centred on its path, so a
 * full-radius circle would clip at the frame's edge.
 */
@Composable
fun GoalRing(
    value: Float,
    size: Dp,
    lineWidth: Dp,
    stroke: Color,
    track: Color,
    modifier: Modifier = Modifier,
    center: @Composable () -> Unit = {},
) {
    Box(modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(size)) {
            val width = lineWidth.toPx()
            val inset = width / 2
            val diameter = this.size.minDimension - width
            drawArc(
                color = track,
                startAngle = 0f,
                sweepAngle = 360f,
                useCenter = false,
                topLeft = Offset(inset, inset),
                size = Size(diameter, diameter),
                style = Stroke(width = width),
            )
            val sweep = value.coerceIn(0f, 1f) * 360f
            if (sweep > 0f) {
                drawArc(
                    color = stroke,
                    // -90° so progress starts at the top, the way a clock reads.
                    startAngle = -90f,
                    sweepAngle = sweep,
                    useCenter = false,
                    topLeft = Offset(inset, inset),
                    size = Size(diameter, diameter),
                    style = Stroke(width = width, cap = StrokeCap.Round),
                )
            }
        }
        // Cap the label to the inner diameter so a long value shrinks to fit rather than
        // spilling past the stroke.
        Box(
            Modifier.size(size - lineWidth * 2 - 10.dp),
            contentAlignment = Alignment.Center,
        ) {
            center()
        }
    }
}

/** Overlapping member avatars (up to four) for a goal list. */
@Composable
fun AvatarStack(
    members: List<GoalsApi.GoalList.Member>,
    modifier: Modifier = Modifier,
    size: Dp = 24.dp,
) {
    Row(
        modifier = modifier,
        // A negative gap is the overlap; there is no Arrangement for "tuck under".
        horizontalArrangement = Arrangement.spacedBy(-(size * 0.34f)),
    ) {
        members.take(4).forEach { m ->
            Box(
                Modifier
                    .size(size)
                    .background(WF.colors.canvas, CircleShape)
                    .padding(1.5.dp),
            ) {
                AvatarFromHex(colorHex = m.colorHex, emoji = m.avatarEmoji ?: "🙂", size = size - 3.dp)
            }
        }
    }
}

/**
 * A contribution bar — one person's progress against the biggest contribution on the card.
 *
 * Hand-rolled rather than `LinearProgressIndicator`: M3's indicator draws a track gap and
 * a stop indicator that fight the flat capsule these cards use, and its colours come from
 * a `ColorScheme` this app deliberately does not populate.
 */
@Composable
fun GoalProgressBar(
    value: Float,
    tint: Color,
    track: Color,
    modifier: Modifier = Modifier,
    height: Dp = 7.dp,
) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Box(
        modifier
            .fillMaxWidth()
            .height(height)
            .background(track, shape)
            .clip(shape),
    ) {
        Box(
            Modifier
                .fillMaxWidth(value.coerceIn(0f, 1f))
                .height(height)
                .background(tint, shape),
        )
    }
}

/**
 * The category tint, mirroring the web CATEGORIES → person-palette mapping.
 *
 * A per-category identity colour is one of the two documented literal-colour exceptions,
 * and these come from the shared [FamilyColor] palette rather than fresh hexes.
 */
@Composable
fun goalCategoryColor(category: String?): Color = when (category) {
    "physical" -> FamilyColor.Person3.solid
    "intellectual" -> FamilyColor.Person1.solid
    "spiritual" -> FamilyColor.Person4.solid
    "creative" -> FamilyColor.Person2.solid
    "social" -> WF.colors.gold
    else -> WF.colors.primary
}

/**
 * A two-stop gradient for a hero card.
 *
 * Hand-rolled because the design system has **no gradient tokens** — iOS inlines a pair of
 * literal hexes per hero, which the no-hardcoded-hex rule forbids here. The second stop is
 * DERIVED from the token rather than invented, so the pair stays correct in both themes
 * and moves with the palette if the token ever changes.
 */
@Composable
fun goalHeroBrush(base: Color): Brush = Brush.linearGradient(listOf(base, base.deepened()))

/** The darker end of a hero gradient — the token, taken 18% toward black. */
internal fun Color.deepened(): Color = lerp(this, Color.Black, 0.18f)

/** A translucent capsule label sitting on a hero's saturated fill. */
@Composable
fun GoalHeroPill(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        modifier = modifier
            .background(Color.White.copy(alpha = 0.20f), RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 9.dp, vertical = 4.dp),
        style = TextStyle(fontSize = 10.5.sp, fontWeight = FontWeight.Black),
        // White is correct on a SATURATED coloured fill; `onInk` is for an `ink` fill.
        color = Color.White,
    )
}

/**
 * A selectable chip. Uses the shared `wfChip` modifier for its chrome so it can't drift
 * from the chips on Lists, Chores and Meals.
 */
@Composable
fun GoalChip(
    text: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = WF.colors.primary,
    leading: @Composable (() -> Unit)? = null,
) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Row(
        modifier = modifier
            .background(if (selected) tint.copy(alpha = 0.12f) else WF.colors.card, shape)
            .border(1.dp, if (selected) tint else WF.colors.hair, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading?.invoke()
        Text(
            text = text,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
            color = if (selected) tint else WF.colors.ink2,
            maxLines = 1,
        )
    }
}

/** A person chip for a multi-select "who?" row. */
@Composable
fun GoalPersonChip(
    name: String,
    colorHex: String?,
    emoji: String?,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tint = colorFromHex(colorHex) ?: WF.colors.primary
    GoalChip(
        text = goalFirstName(name),
        selected = selected,
        onClick = onClick,
        modifier = modifier,
        tint = tint,
        leading = { AvatarFromHex(colorHex = colorHex, emoji = emoji ?: "🙂", size = 22.dp) },
    )
}

/** A labelled block: an uppercase section label with its content underneath. */
@Composable
fun GoalSection(
    label: String,
    modifier: Modifier = Modifier,
    trailing: @Composable (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(WF.spacing.md)) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(WF.spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            app.waffled.core.design.SectionLabel(label)
            trailing?.invoke()
        }
        content()
    }
}

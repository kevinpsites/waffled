package app.waffled.feature.planning

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.wfChip
import app.waffled.core.design.wfShadow1

/**
 * Selectable-ROW treatment: `wfChip`'s look on a rounded rectangle, because a focus option
 * in a planning step is a multi-line row and `wfChip` clips to a pill.
 */
@Composable
fun Modifier.planningOptionChrome(
    selected: Boolean,
    tint: Color = WF.colors.primary,
    radius: Dp = WF.radius.md,
): Modifier {
    val shape = RoundedCornerShape(radius)
    return this
        .background(if (selected) tint.copy(alpha = 0.12f) else WF.colors.card, shape)
        .border(if (selected) 1.5.dp else 1.dp, if (selected) tint else WF.colors.hair, shape)
        .clip(shape)
}

/**
 * iOS `WaffledPillButton`: a compact capsule action, filled or outlined. Hand-rolled because
 * `core:design` has no equivalent and is frozen — reported as a design-system gap; swap
 * for the shared one when it lands. White on a filled pill is right: the fill is a
 * saturated hue.
 */
@Composable
fun PlanningPillButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = WF.colors.primary,
    filled: Boolean = false,
    disabled: Boolean = false,
    /** This row's own write is in flight: dimmed rather than merely disabled. */
    working: Boolean = false,
) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Text(
        text = label,
        modifier = modifier
            .alpha(if (working) 0.5f else 1f)
            .background(if (filled) tint else WF.colors.card, shape)
            .border(1.dp, if (filled) Color.Transparent else WF.colors.hair, shape)
            .clip(shape)
            .clickable(enabled = !disabled && !working, onClick = onClick)
            .padding(horizontal = 13.dp, vertical = 7.dp),
        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
        color = if (filled) Color.White else tint,
    )
}

/**
 * The thin progress bar (iOS `ProgressBar`). Hand-rolled: Material3's linear indicator
 * draws a gap and an end stop that the design doesn't have.
 */
@Composable
fun PlanningProgressBar(
    value: Double,
    modifier: Modifier = Modifier,
    height: Dp = 2.dp,
    tint: Color = WF.colors.primary,
    track: Color = WF.colors.hair,
) {
    val shape = RoundedCornerShape(height / 2)
    Box(
        modifier
            .fillMaxWidth()
            .height(height)
            .background(track, shape),
    ) {
        Box(
            Modifier
                .fillMaxWidth(value.coerceIn(0.0, 1.0).toFloat())
                .height(height)
                .background(tint, shape),
        )
    }
}

/**
 * A park/edit tag chip — `wfChip` in the AI tint. Selected text uses `aiD` for contrast on
 * the 12% wash.
 */
@Composable
fun PlanningTagChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    disabled: Boolean = false,
) {
    Text(
        text = label,
        modifier = Modifier
            .wfChip(selected = selected, tint = WF.colors.ai)
            .clickable(enabled = !disabled, onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = 11.dp, vertical = 7.dp),
        style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
        color = if (selected) WF.colors.aiD else WF.colors.ink2,
    )
}

/**
 * The kiosk dashboard's card (iOS `KioskCard`): 22 padding, a hairline, shadow. Not in
 * `core:design` — a design-system gap; local so the Today card can match the kiosk.
 */
@Composable
fun PlanningKioskCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        modifier
            .fillMaxWidth()
            .wfShadow1(shape)
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .padding(22.dp),
        content = content,
    )
}

/**
 * The tone of a goal's pace sentence. Classification is split from colour so it can be
 * asserted; the tone arrives as a string and anything unrecognised reads neutral. `flat`
 * is deliberately not a warning: a slow goal is a fact, not a complaint.
 */
object PlanningPaceTone {
    enum class Kind { Ok, Behind, Neutral }

    fun kind(tone: String): Kind = when (tone) {
        "ok" -> Kind.Ok
        "behind" -> Kind.Behind
        else -> Kind.Neutral
    }

    @Composable
    fun color(tone: String): Color = when (kind(tone)) {
        Kind.Ok -> WF.colors.success
        Kind.Behind -> WF.colors.warn
        Kind.Neutral -> WF.colors.ink3
    }
}

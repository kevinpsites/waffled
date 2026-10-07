package app.waffled.feature.planning

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.waffled.core.design.WF

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

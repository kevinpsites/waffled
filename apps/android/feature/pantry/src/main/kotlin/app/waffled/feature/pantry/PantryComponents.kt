package app.waffled.feature.pantry

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.FlowRowScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF

/**
 * A wrapping row of chips.
 *
 * iOS hand-rolls a `ChipFlow: Layout`; Compose has `FlowRow` in Foundation, so the
 * native control wins outright. (Lists has its own copy of this four-line wrapper —
 * neither module may depend on the other, and it is too small to be worth unfreezing
 * `core:design` for.)
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PantryChipFlow(
    modifier: Modifier = Modifier,
    spacing: Dp = 8.dp,
    lineSpacing: Dp = spacing,
    content: @Composable FlowRowScope.() -> Unit,
) {
    FlowRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(spacing),
        verticalArrangement = Arrangement.spacedBy(lineSpacing),
        content = content,
    )
}

/**
 * One coloured allergen letter-badge.
 *
 * ⚠️ The fill and letter colours are **literal hex** and that is CORRECT — see the
 * comment on [PantryAllergen.Badge]. This is one of the two documented exceptions in
 * `core/design/Theme.kt`: an identity palette that must stay mutually distinguishable
 * regardless of theme. Nine allergens sitting side by side are told apart by hue, so
 * theme-adaptive tokens would collapse them into each other, and the same nine hues ship
 * on web and iOS. **Do not "fix" these into `WF.*` tokens.**
 *
 * Everything around the badge IS tokenised: [avoid] draws its ring in
 * `WF.colors.danger`, and the legend's text is `WF.colors.ink2`.
 *
 * [avoid] rings the badge in the danger colour; [trace] draws it outlined, meaning
 * "may contain" rather than "contains".
 */
@Composable
fun AllergenBadge(
    allergen: String,
    modifier: Modifier = Modifier,
    avoid: Boolean = false,
    trace: Boolean = false,
) {
    val badge = PantryAllergen.badge(allergen)
    Box(
        modifier = modifier
            .size(21.dp)
            .then(
                if (avoid) Modifier.border(1.5.dp, WF.colors.danger, CircleShape) else Modifier,
            )
            .padding(1.5.dp)
            .background(if (trace) Color.Transparent else badge.bg, CircleShape)
            .then(
                if (trace) Modifier.border(1.5.dp, badge.bg, CircleShape) else Modifier,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = badge.short,
            style = TextStyle(fontSize = 9.5.sp, fontWeight = FontWeight.Black),
            color = if (trace) badge.bg else badge.fg,
        )
    }
}

/** A row of an item's allergen badges — definite first, then traces, avoided ones ringed. */
@Composable
fun AllergenBadges(
    allergens: List<String>,
    avoid: Set<String>,
    modifier: Modifier = Modifier,
    traces: List<String> = emptyList(),
) {
    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        allergens.forEach { AllergenBadge(it, avoid = it in avoid) }
        traces.filterNot { it in allergens }.forEach {
            AllergenBadge(it, avoid = it in avoid, trace = true)
        }
    }
}

/** The persistent legend — badge → name for all nine keys, avoided ones ringed. */
@Composable
fun AllergenKey(avoid: Set<String>, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel("Allergens")
        PantryChipFlow(spacing = 12.dp, lineSpacing = 9.dp) {
            PantryAllergen.keys.forEach { key ->
                Row(
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AllergenBadge(key, avoid = key in avoid)
                    Text(PantryAllergen.label(key), style = WF.type.caption, color = WF.colors.ink2)
                }
            }
        }
    }
}

/**
 * A small green "Vegan / Vegetarian / Palm-oil-free" chip.
 *
 * Read-only: these come off the Open Food Facts ingredients analysis, not from the user.
 * Tokenised (`success` on `successT`) — unlike the allergen badges, there is no identity
 * palette to preserve here.
 */
@Composable
fun DietaryChip(key: String, modifier: Modifier = Modifier) {
    Text(
        text = PantryDietary.label(key),
        modifier = modifier
            .background(WF.colors.successT, RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
        color = WF.colors.success,
    )
}

/** A wrapping row of an item's dietary chips; renders nothing when there are none. */
@Composable
fun DietaryChips(dietary: List<String>?, modifier: Modifier = Modifier) {
    if (dietary.isNullOrEmpty()) return
    PantryChipFlow(modifier, spacing = 7.dp) {
        dietary.forEach { DietaryChip(it) }
    }
}

/**
 * The amber "been a while" age chip — 🕰️ plus a compact age ("8 mo").
 *
 * Used on list rows (old items only) and on the detail's Added row, where [trailing]
 * appends " ago".
 */
@Composable
fun AgePill(
    label: String,
    modifier: Modifier = Modifier,
    icon: Boolean = true,
    trailing: String = "",
    fontSize: TextUnit = 10.5.sp,
) {
    Text(
        text = (if (icon) "🕰️ " else "") + label + trailing,
        modifier = modifier
            .background(WF.colors.warnT, RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 7.dp, vertical = 2.dp),
        style = TextStyle(fontSize = fontSize, fontWeight = FontWeight.Bold),
        color = WF.colors.warn,
    )
}

/** The palette a row's expiry label reads in. Tokens, resolved at draw time. */
@Composable
fun ExpiryTone.color(): Color = when (this) {
    ExpiryTone.Danger -> WF.colors.danger
    ExpiryTone.Warn -> WF.colors.warn
    ExpiryTone.Plain -> WF.colors.ink3
}

/**
 * A ± stepper glyph.
 *
 * Hand-rolled rather than a Material `IconButton`: the target is a 28dp panel circle with
 * a coral glyph, and `IconButton`'s fixed 48dp minimum touch frame with its own ripple
 * shape cannot be squeezed into a row that already carries a name, a location, badges and
 * an amount without the row growing past a phone's width.
 */
@Composable
fun StepperGlyph(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 28.dp,
    tint: Color = WF.colors.primary,
) {
    Box(
        modifier = modifier
            .size(size)
            .background(WF.colors.panel, CircleShape)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = tint,
            modifier = Modifier.size(size * 0.45f),
        )
    }
}

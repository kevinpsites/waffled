package app.waffled.feature.lists

import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.FlowRowScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.colorFromHex
import app.waffled.core.design.wfChip
import app.waffled.core.design.wfField

/**
 * A boxed single-line text field.
 *
 * Hand-rolled on `BasicTextField` rather than Material3's `TextField`, for the reason the
 * Photos feature already documented: the Material fields draw their own container,
 * indicator line and floating label — chrome that contradicts `wfField`, which is this
 * repo's single source for field chrome. `BasicTextField` is the unstyled primitive that
 * lets the design system supply the look.
 *
 * (This is a near-copy of `PhotoTextField`. `core:design` has no text field and is frozen,
 * so each feature owns its own wrapper — flagged in the port report.)
 */
@Composable
fun ListTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    fill: Color = WF.colors.card,
    fontSize: TextUnit = 16.sp,
    fontWeight: FontWeight = FontWeight.SemiBold,
    horizontalPadding: Dp = 13.dp,
    verticalPadding: Dp = 12.dp,
    boxed: Boolean = true,
    textAlign: TextAlign = TextAlign.Start,
    imeAction: ImeAction = ImeAction.Done,
    capitalization: KeyboardCapitalization = KeyboardCapitalization.Sentences,
    onSubmit: () -> Unit = {},
) {
    Box(
        modifier = modifier
            .then(if (boxed) Modifier.wfField(fill = fill) else Modifier)
            .padding(horizontal = if (boxed) horizontalPadding else 0.dp, vertical = if (boxed) verticalPadding else 0.dp),
    ) {
        val style = TextStyle(
            fontSize = fontSize,
            fontWeight = fontWeight,
            color = WF.colors.ink,
            textAlign = textAlign,
        )
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            textStyle = style,
            cursorBrush = SolidColor(WF.colors.primary),
            keyboardOptions = KeyboardOptions(capitalization = capitalization, imeAction = imeAction),
            keyboardActions = KeyboardActions(
                onDone = { onSubmit() },
                onNext = { onSubmit() },
                onGo = { onSubmit() },
            ),
            decorationBox = { inner ->
                if (value.isEmpty()) {
                    Text(
                        text = placeholder,
                        style = style.copy(fontWeight = FontWeight.Normal),
                        color = WF.colors.ink3,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                inner()
            },
        )
    }
}

/**
 * The rendered pantry badge.
 *
 * `success` / a 12%-opacity wash of it is the tint pair the Pantry screen uses for its own
 * "you've got this" chips, so the same claim looks the same everywhere it's made — and
 * deliberately NOT a warning colour, since the row is still on the list on purpose. Both
 * are dark-aware `WF` tokens; a literal here would go wrong in one theme.
 */
@Composable
fun PantryBadgeChip(
    rowName: String,
    hit: ListItemDTO.PantryHit,
    modifier: Modifier = Modifier,
    /** A checked-off row has already been dealt with — let its badge recede with it. */
    dimmed: Boolean = false,
) {
    val spoken = PantryBadge.accessibilityLabel(rowName, hit)
    Text(
        text = "🥫 ${PantryBadge.label(rowName, hit)}",
        modifier = modifier
            .background(
                WF.colors.success.copy(alpha = if (dimmed) 0.06f else 0.12f),
                RoundedCornerShape(WF.radius.pill),
            )
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .semantics { contentDescription = spoken },
        style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.Bold),
        color = WF.colors.success.copy(alpha = if (dimmed) 0.5f else 1f),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/**
 * List-item priority: a 1–5 urgency scale (1 not urgent, 3 normal, 5 urgent) shared by the
 * detail editor's chips and the row flag. Above-normal items (4–5) get the flag. Mirrors
 * the web `priority.tsx`.
 */
object ListItemPriority {
    data class Option(val value: Int, val label: String, val icon: String)

    const val NORMAL = 3

    val all = listOf(
        Option(1, "Not urgent", ""),
        Option(2, "Low", ""),
        Option(3, "Normal", ""),
        Option(4, "High", "⚑"),
        Option(5, "Urgent", "‼️"),
    )

    fun meta(priority: Int?): Option = all.firstOrNull { it.value == (priority ?: NORMAL) } ?: all[2]
}

/**
 * A selectable pill.
 *
 * `wfChip` is the design system's single source for chip treatment; only the label and
 * padding live here.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ListChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leading: String? = null,
    tint: Color = WF.colors.primary,
    /** Long-press action, e.g. "delete this template". Null keeps a plain tap target. */
    onLongClick: (() -> Unit)? = null,
) {
    Row(
        modifier = modifier
            .wfChip(selected = selected, tint = tint)
            .then(
                if (onLongClick == null) Modifier.clickable(onClick = onClick)
                else Modifier.combinedClickable(onClick = onClick, onLongClick = onLongClick),
            )
            .padding(horizontal = 12.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) Text(text = leading, style = TextStyle(fontSize = 13.sp))
        Text(
            text = label,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
            color = if (selected) WF.colors.ink else WF.colors.ink2,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * The per-item provenance dots — one small circle per meal that wants this row.
 *
 * A meal's colour is identity data (it distinguishes one dinner from another regardless
 * of theme), which is the documented exception to the never-hardcode-a-colour rule; an
 * unparseable value falls back to a token rather than to a literal.
 */
@Composable
fun MealDotsRow(colors: List<String>, modifier: Modifier = Modifier) {
    if (colors.isEmpty()) return
    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        for (hex in colors.take(4)) {
            Box(
                Modifier
                    .size(7.dp)
                    .background(colorFromHex(hex) ?: WF.colors.ink3, CircleShape),
            )
        }
    }
}

/**
 * A wrapping row of chips.
 *
 * iOS hand-rolls a `ChipFlow: Layout` for this; Compose has `FlowRow` in Foundation, so
 * the native control wins outright — one of the few places the port gets *smaller*.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChipFlow(
    modifier: Modifier = Modifier,
    spacing: Dp = 8.dp,
    content: @Composable FlowRowScope.() -> Unit,
) {
    FlowRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(spacing),
        verticalArrangement = Arrangement.spacedBy(spacing),
        content = content,
    )
}

/** One entry in a row's overflow menu. */
data class MenuAction(
    val label: String,
    val icon: ImageVector,
    val onClick: () -> Unit,
    val destructive: Boolean = false,
)

/**
 * A row's overflow menu.
 *
 * Material3's `DropdownMenu` is the native contextual-action control, and it is what
 * carries the actions iOS puts behind a swipe or a context menu. Only the item colours
 * are ours, so a destructive action reads as destructive in both themes.
 */
@Composable
fun ListRowMenu(
    expanded: Boolean,
    onDismiss: () -> Unit,
    items: List<MenuAction>,
) {
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        containerColor = WF.colors.card,
    ) {
        for (action in items) {
            val tint = if (action.destructive) WF.colors.danger else WF.colors.ink
            DropdownMenuItem(
                text = {
                    Text(action.label, style = WF.type.body, color = tint)
                },
                leadingIcon = {
                    Icon(action.icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
                },
                onClick = {
                    onDismiss()
                    action.onClick()
                },
            )
        }
    }
}

/** A small muted tag, e.g. the row's store. */
@Composable
fun ListRowTag(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        modifier = modifier
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 8.dp, vertical = 3.dp),
        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
        color = WF.colors.ink3,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

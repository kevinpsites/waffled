package app.waffled.core.design

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The shared Waffled building blocks — the Compose twins of
 * `apps/ios/.../DesignSystem/Components.swift`.
 *
 * ⚠️ FROZEN after Phase 0. Reuse hierarchy, in order:
 *   1. a native Material3 / Compose Foundation control,
 *   2. one of these components + [WF] tokens,
 *   3. hand-rolled — and only with a comment saying why.
 *
 * Two menu families exist BY DESIGN: [WaffledMenuPill] (app-wide compact pill) and
 * [WaffledSettingsMenuLabel] (Settings dropdowns). Do not add a third.
 */

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

private val ShadowInkLight = Color(0xFF282118)

/** The standard card shadow. Deepens in dark, matching iOS `wfShadow1`. */
@Composable
fun Modifier.wfShadow1(shape: Shape): Modifier {
    val dark = WF.colors.isDark
    val c = if (dark) Color.Black.copy(alpha = 0.45f) else ShadowInkLight.copy(alpha = 0.05f)
    return this.shadow(elevation = 1.dp, shape = shape, ambientColor = c, spotColor = c)
}

/** The raised-FAB shadow. Matches iOS `wfShadow3`. */
@Composable
fun Modifier.wfShadow3(shape: Shape): Modifier {
    val dark = WF.colors.isDark
    val c = if (dark) Color.Black.copy(alpha = 0.60f) else ShadowInkLight.copy(alpha = 0.12f)
    return this.shadow(elevation = 10.dp, shape = shape, ambientColor = c, spotColor = c)
}

// ---------------------------------------------------------------------------
// Field / chip chrome — the twins of FieldStyles.swift
// ---------------------------------------------------------------------------

/**
 * Boxed field chrome: a fill (card by default) with a hairline border, rounded.
 * The single source for boxed inputs — don't re-spell fill + clip + border per screen.
 */
@Composable
fun Modifier.wfField(radius: Dp = WF.radius.md, fill: Color = WF.colors.card): Modifier {
    val shape = RoundedCornerShape(radius)
    return this
        .background(fill, shape)
        .border(1.dp, WF.colors.hair, shape)
        .clip(shape)
}

/**
 * Selectable-chip treatment: a tinted fill + coloured border when selected, a card fill
 * + hairline when not. The single source for every picker chip (people, categories,
 * sections, filters). Padding and label stay at the call site.
 */
@Composable
fun Modifier.wfChip(selected: Boolean, tint: Color = WF.colors.primary): Modifier {
    val shape = RoundedCornerShape(WF.radius.pill)
    return this
        .background(if (selected) tint.copy(alpha = 0.12f) else WF.colors.card, shape)
        .border(if (selected) 1.5.dp else 1.dp, if (selected) tint else WF.colors.hair, shape)
        .clip(shape)
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** A rounded card surface (`.card` on the web). Padding is the caller's choice. */
@Composable
fun WaffledCard(
    modifier: Modifier = Modifier,
    padding: Dp = 16.dp,
    radius: Dp = WF.radius.lg,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(radius)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .wfShadow1(shape)
            .background(WF.colors.card, shape)
            .clip(shape)
            .padding(padding),
        content = content,
    )
}

/** A [WaffledCard] whose first child is a bold section title — the "titled field card". */
@Composable
fun WaffledFieldCard(
    title: String,
    modifier: Modifier = Modifier,
    padding: Dp = 14.dp,
    spacing: Dp = 10.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    WaffledCard(modifier = modifier, padding = padding) {
        Column(verticalArrangement = Arrangement.spacedBy(spacing)) {
            Text(
                text = title,
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
            )
            content()
        }
    }
}

// ---------------------------------------------------------------------------
// Text bits
// ---------------------------------------------------------------------------

/** An uppercase section label, e.g. "EVERYTHING ELSE". */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text.uppercase(),
        modifier = modifier,
        style = TextStyle(
            fontSize = 12.5.sp,
            fontWeight = FontWeight.Black,
            letterSpacing = 0.6.sp,
        ),
        color = WF.colors.ink3,
    )
}

/** A static rounded chip (`.pill`). */
@Composable
fun Pill(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        modifier = modifier
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 12.dp, vertical = 5.dp),
        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
        color = WF.colors.ink2,
    )
}

/** A tinted status / count capsule — coloured text on a 12%-opacity fill of the same hue. */
@Composable
fun WaffledStatusBadge(
    text: String,
    color: Color,
    modifier: Modifier = Modifier,
    size: androidx.compose.ui.unit.TextUnit = 11.sp,
    weight: FontWeight = FontWeight.Bold,
) {
    Text(
        text = text,
        modifier = modifier
            .background(color.copy(alpha = 0.12f), RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 7.dp, vertical = 2.dp),
        style = TextStyle(fontSize = size, fontWeight = weight),
        color = color,
    )
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * The canonical full-width primary call-to-action.
 *
 * `tint` is SEMANTIC: pass `WF.colors.ai` for AI actions, `WF.colors.primary` otherwise.
 * Busy shows a spinner before the label; disabled greys the fill to `ink3`. Both block
 * the tap.
 *
 * White text is correct here — this is a saturated coloured fill, the one case where a
 * literal white is right. On a solid `ink` fill you must use `onInk` instead.
 */
@Composable
fun WaffledPrimaryCTA(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = WF.colors.primary,
    isBusy: Boolean = false,
    isDisabled: Boolean = false,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    val blocked = isDisabled || isBusy
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(if (isDisabled) WF.colors.ink3 else tint, shape)
            .clip(shape)
            .clickable(enabled = !blocked, onClick = onClick)
            .padding(vertical = 14.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (isBusy) {
            CircularProgressIndicator(
                modifier = Modifier.size(16.dp),
                color = Color.White,
                strokeWidth = 2.dp,
            )
            Spacer(Modifier.width(8.dp))
        }
        Text(
            text = label,
            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold),
            color = Color.White,
        )
    }
}

/**
 * The Deny/Approve pair on parent approval rows. Kiosk (tablet) gets inline capsules;
 * phone gets full-width buttons. Stateless — the work stays at the call site.
 */
@Composable
fun ApprovalActionPair(
    denyLabel: String,
    isKiosk: Boolean,
    onDeny: () -> Unit,
    onApprove: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val pill = RoundedCornerShape(WF.radius.pill)
    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (isKiosk) {
            Text(
                text = denyLabel,
                modifier = Modifier
                    .background(WF.colors.panel, pill)
                    .clip(pill)
                    .clickable(onClick = onDeny)
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink2,
            )
            Text(
                text = "Approve",
                modifier = Modifier
                    .background(WF.colors.primary, pill)
                    .clip(pill)
                    .clickable(onClick = onApprove)
                    .padding(horizontal = 18.dp, vertical = 8.dp),
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                color = Color.White,
            )
        } else {
            ApprovalWideButton(denyLabel, WF.colors.panel, WF.colors.ink2, Modifier.weight(1f), onDeny)
            ApprovalWideButton("Approve", WF.colors.primary, Color.White, Modifier.weight(1f), onApprove)
        }
    }
}

@Composable
private fun ApprovalWideButton(
    label: String,
    fill: Color,
    textColor: Color,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val pill = RoundedCornerShape(WF.radius.pill)
    Box(
        modifier = modifier
            .background(fill, pill)
            .clip(pill)
            .clickable(onClick = onClick)
            .padding(vertical = 9.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
            color = textColor,
        )
    }
}

/** A weekday toggle chip — a full-width pill that fills coral when on. */
@Composable
fun WeekdayToggleChip(
    label: String,
    isOn: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(12.dp)
    Box(
        modifier = modifier
            .height(44.dp)
            .background(if (isOn) WF.colors.primary else WF.colors.card, shape)
            .then(if (isOn) Modifier else Modifier.border(1.dp, WF.colors.hair, shape))
            .clip(shape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            maxLines = 1,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Black),
            color = if (isOn) Color.White else WF.colors.ink2,
        )
    }
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

/** A person avatar — emoji on a soft circular tint. */
@Composable
fun Avatar(
    emoji: String,
    modifier: Modifier = Modifier,
    tint: Color = WF.colors.panel,
    size: Dp = 34.dp,
) {
    Box(
        modifier = modifier
            .size(size)
            .background(tint, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = emoji, style = TextStyle(fontSize = (size.value * 0.52f).sp))
    }
}

/** Avatar for a design [FamilyColor] slot (static screens). */
@Composable
fun Avatar(person: FamilyColor, emoji: String, modifier: Modifier = Modifier, size: Dp = 34.dp) {
    Avatar(emoji = emoji, modifier = modifier, tint = person.tint(WF.colors.isDark), size = size)
}

/**
 * Avatar for a synced member: derive a soft tint from the stored `color_hex`, falling
 * back to `panel` when it's missing or unparseable.
 */
@Composable
fun AvatarFromHex(colorHex: String?, emoji: String, modifier: Modifier = Modifier, size: Dp = 34.dp) {
    val tint = colorFromHex(colorHex)?.copy(alpha = 0.16f) ?: WF.colors.panel
    Avatar(emoji = emoji, modifier = modifier, tint = tint, size = size)
}

/** A rounded square holding an emoji — the universal list-row / picker glyph tile. */
@Composable
fun WaffledEmojiTile(
    emoji: String,
    modifier: Modifier = Modifier,
    size: Dp = 22.dp,
    frame: Dp = 42.dp,
    background: Color = WF.colors.panel,
    cornerRadius: Dp = 12.dp,
    emojiAlpha: Float = 1f,
) {
    Box(
        modifier = modifier
            .size(frame)
            .background(background, RoundedCornerShape(cornerRadius)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = emoji,
            // Emoji render as colour glyphs, so fade the layer rather than tinting text —
            // a text colour would be ignored. Muted archived rows rely on this.
            modifier = Modifier.alpha(emojiAlpha),
            style = TextStyle(fontSize = size.value.sp),
        )
    }
}

/** A chevron that rotates 90° when its section is open. */
@Composable
fun DisclosureChevron(
    isOpen: Boolean,
    modifier: Modifier = Modifier,
    size: Dp = 11.dp,
    color: Color = WF.colors.ink3,
) {
    Icon(
        imageVector = Icons.Filled.KeyboardArrowRight,
        contentDescription = null,
        tint = color,
        modifier = modifier
            .size(size * 1.6f)
            .rotate(if (isOpen) 90f else 0f),
    )
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** A centred loading spinner with the standard tint + breathing room. */
@Composable
fun WaffledLoading(modifier: Modifier = Modifier, top: Dp = 48.dp) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = top),
        contentAlignment = Alignment.TopCenter,
    ) {
        CircularProgressIndicator(color = WF.colors.ink3)
    }
}

/** A friendly centred empty state — big emoji, bold title, optional supporting line. */
@Composable
fun WaffledEmptyState(
    emoji: String,
    title: String,
    modifier: Modifier = Modifier,
    message: String? = null,
    top: Dp = 56.dp,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = top, start = 24.dp, end = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(text = emoji, style = TextStyle(fontSize = 48.sp))
        Text(
            text = title,
            style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ink,
        )
        if (message != null) {
            Text(
                text = message,
                style = TextStyle(fontSize = 13.sp),
                color = WF.colors.ink3,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** A dismissible inline error banner — ⚠ + a short message + an ✕ that clears it. */
@Composable
fun DismissibleErrorBanner(
    message: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(WF.colors.primary.copy(alpha = 0.10f), shape)
            .border(1.dp, WF.colors.primary.copy(alpha = 0.3f), shape)
            .clip(shape)
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Filled.Warning,
            contentDescription = null,
            tint = WF.colors.primary,
            modifier = Modifier.size(15.dp),
        )
        Text(
            text = message,
            modifier = Modifier.weight(1f),
            style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink,
        )
        Icon(
            imageVector = Icons.Filled.Close,
            contentDescription = "Dismiss",
            tint = WF.colors.ink3,
            modifier = Modifier
                .size(16.dp)
                .clickable(onClick = onDismiss),
        )
    }
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/** The app-wide compact menu trigger — bold text plus a down chevron on a panel pill. */
@Composable
fun WaffledMenuPill(text: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 14.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = text,
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ink,
        )
        Icon(
            imageVector = Icons.Filled.KeyboardArrowDown,
            contentDescription = null,
            tint = WF.colors.ink3,
            modifier = Modifier.size(16.dp),
        )
    }
}

/**
 * The Settings dropdown affordance — a value plus the up/down "pick from a list" glyph.
 * Distinct from [WaffledMenuPill] on purpose; these are the only two menu families.
 */
@Composable
fun WaffledSettingsMenuLabel(value: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = value,
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink,
        )
        Icon(
            imageVector = Icons.Filled.UnfoldMore,
            contentDescription = null,
            tint = WF.colors.ink3,
            modifier = Modifier.size(14.dp),
        )
    }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** The "Add anything…" capture bar shown on Today. */
@Composable
fun AICaptureBar(
    modifier: Modifier = Modifier,
    placeholder: String = "Add anything…",
    onTap: () -> Unit = {},
    onMic: () -> Unit = {},
) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .wfShadow1(shape)
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .clickable(onClick = onTap)
            .padding(horizontal = 12.dp, vertical = 11.dp),
        horizontalArrangement = Arrangement.spacedBy(11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(30.dp)
                .background(WF.colors.ai, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = WaffledIcons.Sparkles,
                contentDescription = null,
                tint = Color.White,
                modifier = Modifier.size(14.dp),
            )
        }
        Text(
            text = placeholder,
            modifier = Modifier.weight(1f),
            style = TextStyle(fontSize = 16.sp),
            color = WF.colors.ink3,
        )
        Icon(
            imageVector = WaffledIcons.Mic,
            contentDescription = "Dictate",
            tint = WF.colors.ink3,
            modifier = Modifier
                .size(15.dp)
                .clickable(onClick = onMic),
        )
    }
}

/**
 * A lock note explaining read-only state — e.g. an event from a subscribed ICS feed.
 * The canonical copy lives in [LockNoteText].
 */
@Composable
fun LockNote(text: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.sm))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Filled.Lock,
            contentDescription = null,
            tint = WF.colors.ink3,
            modifier = Modifier.size(13.dp),
        )
        Text(
            text = text,
            style = TextStyle(fontSize = 12.5.sp),
            color = WF.colors.ink2,
        )
    }
}

object LockNoteText {
    /** Canonical copy for an event owned by a subscribed feed. */
    const val SUBSCRIBED_FEED_EVENT: String =
        "This event comes from a subscribed calendar, so it can't be edited here."
}

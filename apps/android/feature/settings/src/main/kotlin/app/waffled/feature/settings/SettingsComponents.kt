package app.waffled.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.statusBarsPadding
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.colorFromHex

/** The ink3 "Soon" capsule on rows that aren't built yet. */
@Composable
internal fun SoonPill() {
    Text(
        "Soon",
        modifier = Modifier
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 8.dp, vertical = 3.dp),
        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
        color = WF.colors.ink3,
    )
}

/** Card fill + rMD corners + a hairline — the box every settings row sits in. */
@Composable
internal fun Modifier.settingsBox(fill: Color = WF.colors.card, stroke: Color = WF.colors.hair): Modifier {
    val shape = RoundedCornerShape(WF.radius.md)
    return this.clip(shape).background(fill, shape).border(1.dp, stroke, shape)
}

/**
 * A settings sub-page: a back affordance + centred title, then a scrolling canvas column.
 * Hand-rolled because `core:design` has no navigation bar and this app draws no
 * Material top app bar anywhere.
 */
@Composable
internal fun SettingsPage(
    title: String,
    onBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
    spacing: Dp = 16.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier.fillMaxSize().background(WF.colors.canvas)) {
        Box(
            Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (onBack != null) {
                Box(
                    Modifier
                        .align(Alignment.CenterStart)
                        .size(36.dp)
                        .clip(CircleShape)
                        .clickable(onClick = onBack),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = "Back",
                        tint = WF.colors.ink,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
            Text(title, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
        }
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(spacing),
            content = content,
        )
    }
}

/** A settings sheet: Cancel + centred title over a scrolling canvas column. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsSheet(
    title: String,
    onDismiss: () -> Unit,
    dismissLabel: String = "Cancel",
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Box(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), contentAlignment = Alignment.Center) {
            Text(
                dismissLabel,
                modifier = Modifier.align(Alignment.CenterStart).clickable(onClick = onDismiss),
                style = TextStyle(fontSize = 16.sp),
                color = WF.colors.primary,
            )
            Text(title, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
        }
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(20.dp)
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(18.dp),
            content = content,
        )
    }
}

/** A landing row: emoji tile, title + subtitle, chevron (or "Soon" when disabled). */
@Composable
internal fun SettingsNavRow(
    emoji: String,
    title: String,
    subtitle: String,
    onClick: (() -> Unit)?,
) {
    val enabled = onClick != null
    Row(
        Modifier
            .fillMaxWidth()
            .alpha(if (enabled) 1f else 0.6f)
            .settingsBox()
            .clickable(enabled = enabled) { onClick?.invoke() }
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WaffledEmojiTile(emoji = emoji)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                title,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                color = if (enabled) WF.colors.ink else WF.colors.ink2,
            )
            Text(subtitle, style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
        }
        if (enabled) {
            Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = WF.colors.ink3, modifier = Modifier.size(18.dp))
        } else {
            SoonPill()
        }
    }
}

/** The 40pt panel-tinted emoji square used by toggle rows (iOS radius 11). */
@Composable
internal fun SettingsIcon(emoji: String) {
    WaffledEmojiTile(emoji = emoji, size = 20.dp, frame = 40.dp, cornerRadius = 11.dp)
}

/** The brand switch: native Material3, coral when on (matches iOS `.tint(WF.primary)`). */
@Composable
internal fun SettingsSwitch(checked: Boolean, onCheckedChange: (Boolean) -> Unit, enabled: Boolean = true) {
    Switch(
        checked = checked,
        onCheckedChange = onCheckedChange,
        enabled = enabled,
        colors = SwitchDefaults.colors(checkedTrackColor = WF.colors.primary),
    )
}

/** Title + optional subtitle on the left, a switch on the right (iOS `Toggle` with label). */
@Composable
internal fun LabeledSwitch(
    title: String,
    subtitle: String?,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    enabled: Boolean = true,
    titleSize: Float = 15f,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(title, style = TextStyle(fontSize = titleSize.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            if (subtitle != null) Text(subtitle, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
        }
        SettingsSwitch(checked, onCheckedChange, enabled)
    }
}

@Composable
internal fun HairDivider(modifier: Modifier = Modifier) {
    HorizontalDivider(modifier, thickness = 1.dp, color = WF.colors.hair)
}

/** The dashed "＋ Add a …" button under a list of rows. */
@Composable
internal fun DashedAddButton(label: String, onClick: () -> Unit) {
    val hair = WF.colors.hair
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(WF.radius.md))
            .background(WF.colors.card2)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.matchParentSize()) {
            drawRoundRect(
                color = hair,
                style = Stroke(width = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(WF.radius.md.toPx()),
            )
        }
        Row(
            Modifier.padding(vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Add, contentDescription = null, tint = WF.colors.ink2, modifier = Modifier.size(15.dp))
            Text(label, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink2)
        }
    }
}

/** A small capsule action (Save / Test / Accept / Open). */
@Composable
internal fun CapsuleButton(
    label: String,
    onClick: () -> Unit,
    fill: Color,
    textColor: Color,
    enabled: Boolean = true,
    size: Float = 14f,
    horizontal: Dp = 18.dp,
    vertical: Dp = 10.dp,
) {
    Text(
        label,
        modifier = Modifier
            .clip(RoundedCornerShape(WF.radius.pill))
            .background(fill)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = horizontal, vertical = vertical),
        style = TextStyle(fontSize = size.sp, fontWeight = FontWeight.Bold),
        color = textColor,
    )
}

/** A two-tap destructive text button: first tap arms it, second tap acts. */
@Composable
internal fun ConfirmTextButton(
    label: String,
    armedLabel: String,
    armed: Boolean,
    onArm: () -> Unit,
    onConfirm: () -> Unit,
    size: Float = 14f,
) {
    Text(
        if (armed) armedLabel else label,
        modifier = Modifier.fillMaxWidth().clickable { if (armed) onConfirm() else onArm() },
        style = TextStyle(fontSize = size.sp, fontWeight = FontWeight.SemiBold),
        color = if (armed) WF.colors.primary else WF.colors.ink3,
        textAlign = TextAlign.Center,
    )
}

/**
 * The eight-swatch colour row with the current one ringed. iOS adds a ninth native
 * colour-wheel well; Android has no native picker and `core:design` has no component
 * for one, so a non-preset colour is shown ringed in a ninth, read-only swatch.
 */
@Composable
internal fun ColorSwatchPicker(hex: String, onPick: (String) -> Unit, size: Dp = 30.dp) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        WaffledSwatch.all.forEach { s -> Swatch(s, selected = s.equals(hex, ignoreCase = true), size = size) { onPick(s) } }
        if (!WaffledSwatch.isPreset(hex) && colorFromHex(hex) != null) {
            Swatch(hex, selected = true, size = size) {}
        }
        Spacer(Modifier.width(0.dp))
    }
}

@Composable
private fun Swatch(hex: String, selected: Boolean, size: Dp, onClick: () -> Unit) {
    Box(
        Modifier
            .size(size + 6.dp)
            .border(2.5.dp, if (selected) WF.colors.ink else Color.Transparent, CircleShape)
            .padding(3.dp)
            .clip(CircleShape)
            .background(colorFromHex(hex) ?: WF.colors.ink3)
            .clickable(onClick = onClick),
    )
}

/** Inline error / note text under a form. */
@Composable
internal fun FormMessage(text: String, color: Color, size: Float = 12.5f) {
    Text(text, style = TextStyle(fontSize = size.sp, fontWeight = FontWeight.Medium), color = color)
}

@Composable
internal fun BodyNote(text: String, size: Float = 13f, color: Color = WF.colors.ink2) {
    Text(text, style = TextStyle(fontSize = size.sp), color = color)
}

/** Spacer helper for the Column-with-spacing pages that need one extra gap. */
@Composable
internal fun Gap(height: Dp) = Spacer(Modifier.height(height))

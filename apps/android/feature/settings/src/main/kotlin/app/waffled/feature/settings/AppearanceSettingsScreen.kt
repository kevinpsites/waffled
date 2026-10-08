package app.waffled.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.ThemePref
import app.waffled.core.design.ThemeStore
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmojiTile

/**
 * Settings → Appearance: two preview cards plus Match system, saved per device through
 * the shared [ThemeStore] (key `waffled.theme`).
 */
@Composable
internal fun AppearanceSettingsScreen(
    themeStore: ThemeStore,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val pref by themeStore.prefFlow.collectAsStateWithLifecycle()
    // What is on screen: the device under System, the pinned choice otherwise.
    val resolvedDark = pref.forcedDark ?: isSystemInDarkTheme()

    SettingsPage("Appearance", onBack, modifier, spacing = 10.dp) {
        SectionLabel("Theme", Modifier.padding(horizontal = 2.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ThemePreviewCard("Light", active = !resolvedDark, pinned = pref == ThemePref.Light, swatch = PreviewSwatch.Light, Modifier.weight(1f)) {
                themeStore.pref = ThemePref.Light
            }
            ThemePreviewCard("Dark", active = resolvedDark, pinned = pref == ThemePref.Dark, swatch = PreviewSwatch.Dark, Modifier.weight(1f)) {
                themeStore.pref = ThemePref.Dark
            }
        }
        WaffledCard(Modifier.padding(top = 4.dp), padding = 14.dp, radius = WF.radius.md) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                WaffledEmojiTile("🌗")
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("Match system", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                    Text("Follow your device's light/dark setting automatically.", style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
                }
                // Turning it off pins whatever is currently on screen — same as web.
                SettingsSwitch(pref == ThemePref.System, { on ->
                    themeStore.pref = if (on) ThemePref.System else if (resolvedDark) ThemePref.Dark else ThemePref.Light
                })
            }
        }
        Text(
            "This choice is saved on this device only.",
            modifier = Modifier.padding(horizontal = 2.dp).padding(top = 8.dp),
            style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink3,
        )
    }
}

/**
 * The mockup's colours are fixed literals, not WF tokens: the card DEPICTS a theme, so
 * it must look light or dark whichever theme is active. Values mirror the web preview.
 */
private enum class PreviewSwatch(val bg: Color, val card: Color, val line: Color) {
    Light(Color(0xFFFAF7F2), Color(0xFFFFFFFF), Color(0xFFC9C3B8)),
    Dark(Color(0xFF14110C), Color(0xFF232019), Color(0xFF4A453C)),
}

@Composable
private fun ThemePreviewCard(
    label: String,
    active: Boolean,
    pinned: Boolean,
    swatch: PreviewSwatch,
    modifier: Modifier,
    onSelect: () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        modifier
            .clip(shape)
            .background(WF.colors.card, shape)
            .border(if (pinned) 2.dp else 1.dp, if (pinned) WF.colors.primary else WF.colors.hair, shape)
            .clickable(onClick = onSelect)
            .semantics { contentDescription = "$label theme"; selected = pinned }
            .padding(10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .height(96.dp)
                .clip(RoundedCornerShape(WF.radius.sm))
                .background(swatch.bg)
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Box(Modifier.width(44.dp).height(6.dp).background(swatch.line, RoundedCornerShape(WF.radius.pill)))
            Box(Modifier.fillMaxWidth().height(26.dp).background(swatch.card, RoundedCornerShape(7.dp)))
            Box(Modifier.width(66.dp).height(16.dp).background(swatch.card, RoundedCornerShape(6.dp)))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
            if (active) Icon(Icons.Filled.Check, null, tint = WF.colors.primary, modifier = Modifier.size(13.dp))
            Text(label, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
        }
    }
}

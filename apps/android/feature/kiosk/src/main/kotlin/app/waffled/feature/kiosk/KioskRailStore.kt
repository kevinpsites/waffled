package app.waffled.feature.kiosk

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.RemoveCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.auth.KeyValueStore
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.sync.ModuleGate
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The per-device rail pins, persisted under [KioskRail.STORAGE_KEY]. One instance in
 * `app` feeds the rail, the More grid and the picker card, so a pin change is live
 * everywhere at once (iOS gets that from a shared `@AppStorage` key).
 */
class KioskRailStore(private val prefs: KeyValueStore) {
    private val _raw = MutableStateFlow(prefs.getString(KioskRail.STORAGE_KEY) ?: KioskRail.defaultRaw)
    val raw: StateFlow<String> = _raw.asStateFlow()

    fun set(value: String) {
        prefs.putString(KioskRail.STORAGE_KEY, value)
        _raw.value = value
    }
}

/**
 * Settings → Display & Kiosk's rail picker (tablet only): "On the rail" — the pins, with
 * reorder and remove — and "Add to the rail" — the unpinned enabled pages, up to
 * [KioskRail.MAX_ITEMS]. Up/down buttons stand in for iOS's drag handles: a drag list
 * nested in a scrolling settings page fights the outer scroll.
 */
@Composable
fun KioskRailPickerCard(store: KioskRailStore, modules: ModuleGate, rewardsOn: Boolean, modifier: Modifier = Modifier) {
    val raw by store.raw.collectAsState()
    val pinned = KioskRail.pinned(raw, modules, rewardsOn)
    val available = KioskRail.choosable.filter { it !in pinned && KioskRail.moduleEnabled(it, modules, rewardsOn) }
    val atCap = pinned.size >= KioskRail.MAX_ITEMS

    Column(modifier, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        WaffledCard(padding = 0.dp) {
            SectionHeader("On the rail", "${pinned.size} of ${KioskRail.MAX_ITEMS}", if (atCap) WF.colors.primary else WF.colors.ink3)
            Hairline()
            if (pinned.isEmpty()) {
                Text(
                    "Nothing pinned yet — Today and Calendar are always on the rail; add pages below.",
                    Modifier.padding(16.dp),
                    style = TextStyle(fontSize = 13.sp),
                    color = WF.colors.ink3,
                )
            } else {
                pinned.forEachIndexed { i, nav ->
                    if (i > 0) Hairline(Modifier.padding(start = 54.dp))
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        RowLabel(nav.icon, nav.label, WF.colors.primary, WF.colors.ink, Modifier.weight(1f))
                        IconAction(Icons.Filled.KeyboardArrowUp, "Move ${nav.label} up", enabled = i > 0) {
                            store.set(KioskRail.move(raw, i, i - 1, modules, rewardsOn))
                        }
                        IconAction(Icons.Filled.KeyboardArrowDown, "Move ${nav.label} down", enabled = i < pinned.lastIndex) {
                            store.set(KioskRail.move(raw, i, i + 1, modules, rewardsOn))
                        }
                        IconAction(Icons.Filled.RemoveCircle, "Remove ${nav.label}", tint = WF.colors.danger) {
                            store.set(KioskRail.remove(raw, nav, modules, rewardsOn))
                        }
                    }
                }
            }
        }
        if (available.isNotEmpty()) {
            WaffledCard(padding = 0.dp) {
                SectionHeader("Add to the rail", if (atCap) "Rail full" else null, WF.colors.ink3)
                Hairline()
                available.forEachIndexed { i, nav ->
                    if (i > 0) Hairline(Modifier.padding(start = 54.dp))
                    Row(
                        Modifier.fillMaxWidth().clickable(enabled = !atCap) { store.set(KioskRail.pin(raw, nav, modules, rewardsOn)) }
                            .alpha(if (atCap) 0.5f else 1f).padding(horizontal = 16.dp, vertical = 13.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RowLabel(nav.icon, nav.label, WF.colors.ink3, if (atCap) WF.colors.ink3 else WF.colors.ink, Modifier.weight(1f))
                        Icon(Icons.Filled.AddCircle, "Pin ${nav.label}", tint = if (atCap) WF.colors.hair else WF.colors.primary, modifier = Modifier.size(20.dp))
                    }
                }
            }
        } else if (pinned.isEmpty()) {
            Text(
                "No optional pages are enabled. Turn on modules in Settings → Modules to pin them here.",
                style = TextStyle(fontSize = 12.5.sp),
                color = WF.colors.ink3,
            )
        }
    }
}

@Composable
private fun SectionHeader(title: String, trailing: String?, tint: Color) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text(title, Modifier.weight(1f), style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.4.sp), color = WF.colors.ink2)
        trailing?.let { Text(it, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold), color = tint) }
    }
}

@Composable
private fun Hairline(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(1.dp).background(WF.colors.hair))
}

@Composable
private fun RowLabel(icon: ImageVector, label: String, iconTint: Color, textColor: Color, modifier: Modifier = Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = iconTint, modifier = Modifier.width(26.dp).size(18.dp))
        Text(label, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold), color = textColor)
    }
}

@Composable
private fun IconAction(icon: ImageVector, description: String, enabled: Boolean = true, tint: Color = WF.colors.ink2, onClick: () -> Unit) {
    Box(
        Modifier.size(40.dp).clickable(enabled = enabled, onClick = onClick).alpha(if (enabled) 1f else 0.3f),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, description, tint = tint, modifier = Modifier.size(22.dp)) }
}

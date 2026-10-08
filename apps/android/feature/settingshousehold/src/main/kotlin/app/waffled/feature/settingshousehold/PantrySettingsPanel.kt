package app.waffled.feature.settingshousehold

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.RemoveCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.wfField
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Settings → Pantry: the Today card, the running-low and "old" thresholds, the allergen
 * avoid-list and the storage locations with their emoji. Any member may edit.
 *
 * The allergen catalogue and its badge belong to the pantry feature, which this module
 * may not depend on — so `app` passes them in: [allergenKeys] in canonical order,
 * [allergenLabel], and [allergenBadge] (pantry's `AllergenBadge(key, avoid = …)`).
 */
@Composable
fun PantrySettingsPanel(
    api: SettingsHouseholdApi,
    allergenKeys: List<String>,
    allergenLabel: (String) -> String,
    allergenBadge: @Composable (key: String, avoid: Boolean) -> Unit,
    modifier: Modifier = Modifier,
    bus: RefreshBus? = null,
) {
    val scope = rememberCoroutineScope()
    var loaded by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var showOnToday by remember { mutableStateOf(true) }
    var lowText by remember { mutableStateOf("1") }
    var staleText by remember { mutableStateOf("6") }
    var lowThreshold by remember { mutableStateOf(1.0) }
    var staleMonths by remember { mutableStateOf(6) }
    var locations by remember { mutableStateOf<List<String>>(emptyList()) }
    var icons by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var avoid by remember { mutableStateOf<Set<String>>(emptySet()) }
    var adding by remember { mutableStateOf("") }

    fun adopt(c: SettingsHouseholdApi.PantryConfig) {
        showOnToday = c.showOnToday
        lowThreshold = c.lowThreshold
        lowText = PantrySettingsLogic.formatAmount(c.lowThreshold)
        staleMonths = Math.round(c.staleMonths ?: 6.0).toInt()
        staleText = staleMonths.toString()
        locations = c.locations
        icons = c.locationIcons ?: emptyMap()
        avoid = c.avoidAllergens.toSet()
    }

    /** Persist a partial patch; [onFail] restores the optimistic change. */
    fun push(body: JsonObject, onFail: () -> Unit = {}) = scope.launch {
        val c = runCatchingIo { api.setPantryConfig(body) }
        if (c != null) {
            adopt(c); bus?.bump(RefreshDomain.Pantry)
        } else {
            onFail()
        }
    }

    fun commitLocations() {
        val clean = PantrySettingsLogic.cleanLocations(locations)
        val kept = PantrySettingsLogic.prunedIcons(icons, clean)
        push(
            JsonObject(
                mapOf(
                    "locations" to JsonArray(clean.map(::JsonPrimitive)),
                    "locationIcons" to JsonObject(kept.mapValues { JsonPrimitive(it.value) }),
                ),
            ),
        )
    }

    fun commitLow() {
        val n = PantrySettingsLogic.parseLow(lowText)
        if (n == null) { lowText = PantrySettingsLogic.formatAmount(lowThreshold); return }
        lowThreshold = n; lowText = PantrySettingsLogic.formatAmount(n)
        push(JsonObject(mapOf("lowThreshold" to JsonPrimitive(n))))
    }

    fun commitStale() {
        val n = PantrySettingsLogic.parseStale(staleText)
        if (n == null) { staleText = staleMonths.toString(); return }
        staleMonths = n; staleText = n.toString()
        push(JsonObject(mapOf("staleMonths" to JsonPrimitive(n))))
    }

    fun addLocation() {
        val name = adding.trim()
        if (name.isEmpty()) return
        adding = ""
        // A case-insensitive duplicate would be dropped by the server anyway.
        if (locations.any { it.equals(name, ignoreCase = true) }) return
        locations = locations + name
        commitLocations()
    }

    LaunchedEffect(api) {
        val c = runCatchingIo { api.pantryConfig() }
        if (c != null) { adopt(c); loaded = true } else failed = true
    }

    SettingsPage(modifier) {
        when {
            loaded -> {
                WaffledCard(padding = 4.dp) {
                    SettingRow("🥫", "Show a card on Today", "Surface use-soon and running-low items on the Today screen.") {
                        WFSwitch(showOnToday, { on ->
                            val prev = showOnToday
                            showOnToday = on
                            push(JsonObject(mapOf("showOnToday" to JsonPrimitive(on)))) { showOnToday = prev }
                        })
                    }
                }

                WaffledCard(padding = 4.dp) {
                    SettingRow("📉", "Running low at (or below)", "Default for all items; set a per-item override in the item editor’s “Warn below”.") {
                        NumberField(lowText, { lowText = it }, ::commitLow)
                    }
                    HairDivider()
                    SettingRow("🕰️", "Flag items older than", "Items on hand longer than this get a 🕰️ age badge and a “Been a while” group.") {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            NumberField(staleText, { staleText = it }, ::commitStale)
                            Text("mo", style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
                        }
                    }
                }

                WaffledCard {
                    SectionLabel("Allergens to avoid")
                    Gap(10.dp)
                    Caption("Items containing these (from Open Food Facts) get a red warning — e.g. a gluten-free home.")
                    Gap(10.dp)
                    ChipFlow {
                        allergenKeys.forEach { key ->
                            val on = key in avoid
                            Row(
                                Modifier
                                    .clip(RoundedCornerShape(WF.radius.pill))
                                    .background(if (on) WF.colors.primary else WF.colors.panel)
                                    .clickable {
                                        val prev = avoid
                                        avoid = if (on) avoid - key else avoid + key
                                        // Persist in the catalogue's canonical order.
                                        val next = allergenKeys.filter { it in avoid }
                                        push(JsonObject(mapOf("avoidAllergens" to JsonArray(next.map(::JsonPrimitive))))) { avoid = prev }
                                    }
                                    .padding(horizontal = 11.dp, vertical = 7.dp),
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                allergenBadge(key, on)
                                // White on the saturated primary fill.
                                Text(
                                    allergenLabel(key),
                                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                                    color = if (on) Color.White else WF.colors.ink2,
                                )
                            }
                        }
                    }
                }

                WaffledCard {
                    SectionLabel("Locations")
                    Gap(10.dp)
                    Caption("Where items live — the sidebar groups by these. Add an emoji to show next to each.")
                    Gap(10.dp)
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        locations.forEachIndexed { idx, loc ->
                            LocationRow(
                                icon = icons[loc].orEmpty(),
                                name = loc,
                                isFirst = idx == 0,
                                isLast = idx == locations.lastIndex,
                                onIcon = { v ->
                                    val clamped = PantrySettingsLogic.clampIcon(v).trim()
                                    icons = if (clamped.isEmpty()) icons - loc else icons + (loc to clamped)
                                },
                                onName = { v ->
                                    // The icon map is keyed by name, so a rename carries its icon along.
                                    val icon = icons[loc]
                                    locations = locations.toMutableList().also { it[idx] = v }
                                    icons = (icons - loc).let { m -> if (icon != null) m + (v to icon) else m }
                                },
                                onCommit = ::commitLocations,
                                onMove = { delta ->
                                    val dest = idx + delta
                                    if (dest in locations.indices) {
                                        locations = locations.toMutableList().also { java.util.Collections.swap(it, idx, dest) }
                                        commitLocations()
                                    }
                                },
                                onRemove = {
                                    locations = locations.toMutableList().also { it.removeAt(idx) }
                                    icons = icons - loc
                                    commitLocations()
                                },
                            )
                        }
                    }
                    Gap(10.dp)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        PlainField(
                            value = adding,
                            onValueChange = { adding = it },
                            placeholder = "Add a location…",
                            modifier = Modifier.weight(1f),
                            onDone = ::addLocation,
                        )
                        val canAdd = adding.isNotBlank()
                        Text(
                            "Add",
                            modifier = Modifier
                                .clip(RoundedCornerShape(WF.radius.pill))
                                .background(if (canAdd) WF.colors.primary else WF.colors.ink3)
                                .clickable(enabled = canAdd, onClick = ::addLocation)
                                .padding(horizontal = 14.dp, vertical = 10.dp),
                            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                            // White is correct on the saturated primary fill; on ink3 it reads as disabled.
                            color = Color.White,
                        )
                    }
                }
            }
            failed -> Caption("Couldn’t load pantry settings.", Modifier.padding(vertical = 30.dp), size = 14f)
            else -> WaffledLoading(top = 40.dp)
        }
    }
}

@Composable
private fun LocationRow(
    icon: String,
    name: String,
    isFirst: Boolean,
    isLast: Boolean,
    onIcon: (String) -> Unit,
    onName: (String) -> Unit,
    onCommit: () -> Unit,
    onMove: (Int) -> Unit,
    onRemove: () -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        PlainField(icon, onIcon, placeholder = "📦", modifier = Modifier.width(44.dp), center = true, onBlur = onCommit, onDone = onCommit)
        PlainField(
            name, onName, placeholder = "Location", modifier = Modifier.weight(1f),
            bold = true, onBlur = onCommit, onDone = onCommit,
        )
        ArrowButton(Icons.Filled.KeyboardArrowUp, "Move up", enabled = !isFirst) { onMove(-1) }
        ArrowButton(Icons.Filled.KeyboardArrowDown, "Move down", enabled = !isLast) { onMove(1) }
        Icon(
            Icons.Filled.RemoveCircle,
            contentDescription = "Remove $name",
            tint = WF.colors.ink3,
            modifier = Modifier.size(30.dp).clip(CircleShape).clickable(onClick = onRemove).padding(5.dp),
        )
    }
}

@Composable
private fun ArrowButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, enabled: Boolean, onClick: () -> Unit) {
    Icon(
        icon,
        contentDescription = label,
        tint = if (enabled) WF.colors.ink3 else WF.colors.ink3.copy(alpha = 0.4f),
        modifier = Modifier.size(30.dp).clip(CircleShape).clickable(enabled = enabled, onClick = onClick).padding(5.dp),
    )
}

/** The small centred decimal box the thresholds use; commits on blur or Done. */
@Composable
private fun NumberField(value: String, onChange: (String) -> Unit, onCommit: () -> Unit) {
    PlainField(
        value, onChange, modifier = Modifier.width(56.dp), center = true, bold = true,
        keyboardType = KeyboardType.Decimal, onBlur = onCommit, onDone = onCommit, radius = WF.radius.sm,
    )
}

/**
 * A compact panel-filled input. Not `WaffledTextField`: that one is full-width with a
 * 44dp minimum and a label row, too big for the 44/56dp inline boxes these rows need.
 */
@Composable
private fun PlainField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    center: Boolean = false,
    bold: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    radius: Dp = WF.radius.md,
    onBlur: () -> Unit = {},
    onDone: () -> Unit = {},
) {
    var focused by remember { mutableStateOf(false) }
    val align = if (center) TextAlign.Center else TextAlign.Start
    Box(
        modifier
            .wfField(radius = radius, fill = WF.colors.panel)
            .padding(horizontal = if (center) 4.dp else 12.dp, vertical = 10.dp),
        contentAlignment = if (center) Alignment.Center else Alignment.CenterStart,
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            textStyle = TextStyle(
                fontSize = 15.sp,
                fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal,
                color = WF.colors.ink,
                textAlign = align,
            ),
            cursorBrush = SolidColor(WF.colors.primary),
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onDone() }),
            modifier = Modifier.fillMaxWidth().onFocusChanged { f ->
                if (focused && !f.isFocused) onBlur()
                focused = f.isFocused
            },
            decorationBox = { inner ->
                Box(contentAlignment = if (center) Alignment.Center else Alignment.CenterStart) {
                    if (value.isEmpty()) {
                        Text(placeholder, style = TextStyle(fontSize = 15.sp, textAlign = align), color = WF.colors.ink3)
                    }
                    inner()
                }
            },
        )
    }
}

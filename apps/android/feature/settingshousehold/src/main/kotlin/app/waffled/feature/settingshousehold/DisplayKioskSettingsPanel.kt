package app.waffled.feature.settingshousehold

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.SegmentedRow
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledLoading
import app.waffled.core.model.WaffledDates
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Settings → Display & Kiosk: the household-wide family-display config (screensaver,
 * idle reset, night dimming) plus the paired kiosk tablets. The phone is a remote for
 * the wall display; the iPad-only "This iPad" section has no Android counterpart.
 *
 * Edits auto-save after a short pause, mirroring the iOS debounced save.
 */
@Composable
fun DisplayKioskSettingsPanel(api: SettingsHouseholdApi, isParent: Boolean, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var cfg by remember { mutableStateOf<SettingsHouseholdApi.DisplayConfig?>(null) }
    var loadFailed by remember { mutableStateOf(false) }
    var dirty by remember { mutableStateOf(false) }
    var savedFlash by remember { mutableStateOf(false) }
    var albums by remember { mutableStateOf<List<String>>(emptyList()) }
    var devices by remember { mutableStateOf<List<SettingsHouseholdApi.KioskDevice>>(emptyList()) }
    var confirmRevoke by remember { mutableStateOf<String?>(null) }
    var showPair by remember { mutableStateOf(false) }
    var reloadKey by remember { mutableStateOf(0) }

    suspend fun loadDevices() { devices = runCatchingIo { api.kioskDevices() } ?: emptyList() }

    LaunchedEffect(api, reloadKey) {
        loadFailed = false
        val c = runCatchingIo { api.displayConfig() }
        if (c != null) { cfg = c; dirty = false } else loadFailed = true
        albums = runCatchingIo { api.photoAlbums() } ?: emptyList()
        if (isParent) loadDevices()
    }

    // Echoing the server's normalised config back must not retrigger a save — hence `dirty`.
    LaunchedEffect(cfg) {
        val snapshot = cfg ?: return@LaunchedEffect
        if (!dirty) return@LaunchedEffect
        delay(600)
        val normalized = runCatchingIo { api.setDisplayConfig(snapshot) } ?: return@LaunchedEffect
        dirty = false
        // Outside this effect: assigning cfg restarts it, which would strand the flash on.
        scope.launch {
            savedFlash = true
            delay(1800)
            savedFlash = false
        }
        cfg = normalized
    }

    fun edit(change: (SettingsHouseholdApi.DisplayConfig) -> SettingsHouseholdApi.DisplayConfig) {
        if (!isParent) return
        cfg = cfg?.let(change); dirty = true
    }

    SettingsPage(modifier, spacing = 12.dp, horizontal = 20.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Family displays", Modifier.weight(1f))
            if (savedFlash) Text("✓ Saved", style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold), color = WF.colors.success)
        }
        Caption(
            "These control the family display — a wall tablet or a browser signed in as a kiosk. Changes apply to every display in your home.",
            color = WF.colors.ink2, size = 13f,
        )
        val c = cfg
        when {
            loadFailed -> HairlineCard(padding = 0.dp) {
                Column(Modifier.padding(horizontal = 18.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    RowLabel("Couldn’t load display settings", "Check your connection and try again.")
                    Text(
                        "Retry",
                        Modifier.clickable { reloadKey++ },
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.primary,
                    )
                }
            }
            c != null -> {
                if (!isParent) {
                    SettingsCard {
                        RowLabel("Only a parent can change these", "Ask an adult in your household to update the display.", Modifier.padding(vertical = 14.dp))
                    }
                }
                ScreensaverCard(c, albums, isParent, ::edit)
                SettingsCard {
                    SettingsMenuRow(
                        "Return to Today when idle",
                        DisplayKioskLogic.idleLabel(c.resetHomeMinutes),
                        DisplayKioskLogic.idleChoices.map { m -> DisplayKioskLogic.idleLabel(m) to { edit { it.copy(resetHomeMinutes = m) } } },
                        enabled = isParent,
                    )
                }
                SettingsCard {
                    ToggleRow("Night dimming", "Dim the display overnight on a schedule.", c.nightDim.enabled, enabled = isParent) { v ->
                        edit { it.copy(nightDim = it.nightDim.copy(enabled = v)) }
                    }
                    if (c.nightDim.enabled) {
                        HairDivider()
                        TimeRow("Dim from", c.nightDim.start, isParent) { t -> edit { it.copy(nightDim = it.nightDim.copy(start = t)) } }
                        HairDivider()
                        TimeRow("Back to bright at", c.nightDim.end, isParent) { t -> edit { it.copy(nightDim = it.nightDim.copy(end = t)) } }
                    }
                }
                if (isParent) {
                    KioskDevicesSection(
                        devices = devices,
                        confirmRevoke = confirmRevoke,
                        onUnpair = { d ->
                            if (confirmRevoke == d.id) {
                                confirmRevoke = null
                                scope.launch { runCatchingIo { api.revokeKioskDevice(d.id) }; loadDevices() }
                            } else {
                                confirmRevoke = d.id
                            }
                        },
                        onPair = { showPair = true },
                    )
                }
                Caption("Photos need a signed-in profile; the picker always shows the clock. Set a device as the display from the web kiosk under Display & Kiosk.")
            }
            else -> WaffledLoading()
        }
    }

    if (showPair) {
        PairKioskSheet(api, onPaired = { loadDevices() }, onDismiss = {
            showPair = false
            scope.launch { loadDevices() }
        })
    }
}

/** The Notifications/Display card: flat, 18pt side inset, rows supply their own height. */
@Composable
private fun SettingsCard(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) =
    HairlineCard(padding = 0.dp) { Column(Modifier.padding(horizontal = 18.dp), content = content) }

@Composable
private fun ScreensaverCard(
    c: SettingsHouseholdApi.DisplayConfig,
    albums: List<String>,
    enabled: Boolean,
    edit: ((SettingsHouseholdApi.DisplayConfig) -> SettingsHouseholdApi.DisplayConfig) -> Unit,
) {
    val contents = listOf("photos", "clock", "off")
    val sources = listOf("all", "favorites", "album")
    SettingsCard {
        SettingsMenuRow(
            "Screensaver after",
            DisplayKioskLogic.minutesLabel(c.screensaverMinutes),
            DisplayKioskLogic.screensaverChoices.map { m -> DisplayKioskLogic.minutesLabel(m) to { edit { it.copy(screensaverMinutes = m) } } },
            enabled = enabled,
        )
        HairDivider()
        Column(Modifier.padding(vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            RowLabel("What it shows", "“Photos + clock” is a slideshow with the clock, weather & next event overlaid.")
            SegmentedRow(
                listOf("Photos", "Clock", "Off"),
                contents.indexOf(c.content).coerceAtLeast(0),
                { i -> edit { it.copy(content = contents[i]) } },
                Modifier.alpha(if (enabled) 1f else 0.6f),
            )
        }
        HairDivider()
        ToggleRow("Return to profile picker afterward", "When a paired kiosk wakes, drop to the profile picker.", c.returnToPicker, enabled) { v ->
            edit { it.copy(returnToPicker = v) }
        }
        if (c.content == "photos") {
            HairDivider()
            Column(Modifier.padding(vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                RowLabel("Photo source", "Which photos the slideshow plays.")
                SegmentedRow(
                    listOf("All", "Favorites", "Album"),
                    sources.indexOf(c.photoSource).coerceAtLeast(0),
                    { i -> edit { it.copy(photoSource = sources[i]) } },
                    Modifier.alpha(if (enabled) 1f else 0.6f),
                )
            }
            if (c.photoSource == "album") {
                HairDivider()
                SettingsMenuRow(
                    "Album",
                    c.photoAlbum ?: "Choose…",
                    albums.map { a -> a to { edit { it.copy(photoAlbum = a) } } },
                    enabled = enabled,
                    emptyText = "No albums yet — tag photos with an album first.",
                )
            }
            HairDivider()
            SettingsMenuRow(
                "Transition speed",
                DisplayKioskLogic.secondsLabel(c.photoInterval),
                DisplayKioskLogic.intervalChoices.map { s -> DisplayKioskLogic.secondsLabel(s) to { edit { it.copy(photoInterval = s) } } },
                enabled = enabled,
            )
            HairDivider()
            ToggleRow("Shuffle photos", "Play them in a random order.", c.photoShuffle, enabled) { v -> edit { it.copy(photoShuffle = v) } }
        }
    }
}

@Composable
private fun TimeRow(title: String, value: String, enabled: Boolean, onChange: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f), style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium), color = WF.colors.ink)
        TimeField(value, onChange, enabled)
    }
}

@Composable
private fun KioskDevicesSection(
    devices: List<SettingsHouseholdApi.KioskDevice>,
    confirmRevoke: String?,
    onUnpair: (SettingsHouseholdApi.KioskDevice) -> Unit,
    onPair: () -> Unit,
) {
    Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SectionLabel("Kiosk devices")
        Caption("Shared tablets paired to this household — each shows a profile picker instead of a single login.", size = 12.5f)
        devices.forEach { d ->
            HairlineCard(padding = 12.dp) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(40.dp).background(WF.colors.panel, RoundedCornerShape(11.dp)),
                        contentAlignment = Alignment.Center,
                    ) { Text("🖥️", style = TextStyle(fontSize = 20.sp)) }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(d.label, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                        Caption(lastSeen(d.lastSeenAt))
                    }
                    val confirming = confirmRevoke == d.id
                    Text(
                        if (confirming) "Tap again" else "Unpair",
                        modifier = Modifier
                            .clip(RoundedCornerShape(WF.radius.pill))
                            .background(WF.colors.panel)
                            .clickable { onUnpair(d) }
                            .padding(horizontal = 10.dp, vertical = 7.dp),
                        style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
                        color = if (confirming) WF.colors.primary else WF.colors.ink3,
                    )
                }
            }
        }
        // iOS draws a dashed hairline here; a solid one keeps us on the shared border token.
        val shape = RoundedCornerShape(WF.radius.md)
        Row(
            Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(WF.colors.card2)
                .border(1.dp, WF.colors.hair, shape)
                .clickable(onClick = onPair)
                .padding(vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Add, null, tint = WF.colors.ink2, modifier = Modifier.size(15.dp))
            Text("Pair a new device", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink2)
        }
    }
}

private fun lastSeen(iso: String?): String {
    val at = WaffledDates.parseInstant(iso) ?: return "Never connected"
    val rel = DateUtils.getRelativeTimeSpanString(at.toEpochMilli(), System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE)
    return "Last seen $rel"
}

/**
 * Mint a one-time pairing code, then poll for the tablet that claims it — and keep
 * polling so a name set on the tablet shows here live. Polling stops when the sheet
 * leaves composition.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairKioskSheet(api: SettingsHouseholdApi, onPaired: suspend () -> Unit, onDismiss: () -> Unit) {
    var code by remember { mutableStateOf<SettingsHouseholdApi.PairingCode?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var pairedLabel by remember { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current

    LaunchedEffect(api) {
        val known = (runCatchingIo { api.kioskDevices() } ?: emptyList()).map { it.id }.toSet()
        code = runCatchingIo { api.createPairingCode() }
        if (code == null) { error = "Couldn’t create a pairing code. Admins only."; return@LaunchedEffect }
        var pairedId: String? = null
        while (true) {
            delay(if (pairedId == null) 5_000 else 3_000)
            val fresh = runCatchingIo { api.kioskDevices() } ?: continue
            if (pairedId == null) {
                val paired = fresh.firstOrNull { it.id !in known } ?: continue
                pairedId = paired.id
                pairedLabel = paired.label
                onPaired()
            } else {
                val d = fresh.firstOrNull { it.id == pairedId }
                if (d != null && d.label != pairedLabel) {
                    pairedLabel = d.label
                    onPaired()
                }
            }
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        SheetHeader("Pair a kiosk", leading = null, trailing = (if (pairedLabel == null) "Cancel" else "Done") to onDismiss)
        Column(
            Modifier.fillMaxWidth().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            val label = pairedLabel
            val c = code
            when {
                label != null -> {
                    Text("✅", style = TextStyle(fontSize = 48.sp), modifier = Modifier.padding(top = 24.dp))
                    Text("A device just paired", style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                    Text(
                        label,
                        Modifier.background(WF.colors.panel, RoundedCornerShape(WF.radius.pill)).padding(horizontal = 12.dp, vertical = 5.dp),
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink2,
                    )
                    Caption("If you’re still naming it on the tablet, the name updates here. Tap Done when you’re finished.", size = 13f)
                }
                c != null -> {
                    Text(
                        "Enter this code on the new tablet",
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center),
                        color = WF.colors.ink2,
                    )
                    HairlineCard(padding = 18.dp, radius = WF.radius.lg) {
                        Text(
                            c.code,
                            Modifier.fillMaxWidth(),
                            style = TextStyle(
                                fontSize = 44.sp,
                                fontWeight = FontWeight.ExtraBold,
                                fontFamily = FontFamily.Monospace,
                                letterSpacing = 6.sp,
                                textAlign = TextAlign.Center,
                            ),
                            color = WF.colors.ink,
                        )
                    }
                    Text(
                        if (copied) "Copied ✓" else "Copy code",
                        Modifier.clickable { clipboard.setText(AnnotatedString(c.code)); copied = true },
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.primary,
                    )
                    Text(
                        "On the tablet: open this Waffled’s address → “Set up this device as a kiosk” → enter the code. It’s one-time and expires in about 10 minutes.",
                        style = TextStyle(fontSize = 12.5.sp, textAlign = TextAlign.Center),
                        color = WF.colors.ink3,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(14.dp), color = WF.colors.ink3, strokeWidth = 2.dp)
                        Text("Waiting for a device to pair…", style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Medium), color = WF.colors.ink3)
                    }
                }
                error != null -> Text(
                    error.orEmpty(),
                    Modifier.padding(top = 40.dp),
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                    color = WF.colors.primary,
                )
                else -> WaffledLoading()
            }
        }
    }
}

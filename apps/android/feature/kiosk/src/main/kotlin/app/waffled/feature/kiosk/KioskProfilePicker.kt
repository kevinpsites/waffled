package app.waffled.feature.kiosk

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Backspace
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.wfShadow1
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Shows the profile picker instead of [content] while this device is a paired kiosk
 * with nobody claimed in; otherwise a transparent passthrough. Wrap `app`'s AuthGate.
 */
@Composable
fun KioskGate(
    kiosk: KioskMode,
    server: KioskServerAddress,
    content: @Composable () -> Unit,
) {
    val state by kiosk.state.collectAsState()
    if (state.needsPicker) KioskProfilePicker(kiosk, server) else content()
}

/** The escape sheet's view of the user-editable server address, supplied by `app`. */
interface KioskServerAddress {
    fun current(): String

    /** Validate and store; return a user-facing error, or null when accepted. */
    fun set(input: String): String?
}

/**
 * The shared kiosk's "who's using this?" screen. A PIN-protected face asks for its code
 * on [KioskPinPad] first. KEEP IN SYNC with web `kiosk/ProfilePicker.tsx` + `PinPad.tsx`.
 */
@Composable
fun KioskProfilePicker(kiosk: KioskMode, server: KioskServerAddress, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    val modeState by kiosk.state.collectAsState()
    var profiles by remember { mutableStateOf<List<KioskProfile>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var pinFor by remember { mutableStateOf<KioskProfile?>(null) }
    var claiming by remember { mutableStateOf<KioskProfile?>(null) }
    var claimError by remember { mutableStateOf<String?>(null) }
    var showEscape by remember { mutableStateOf(false) }
    var reloadKey by remember { mutableStateOf(0) }

    suspend fun load(silent: Boolean) {
        when (val r = kiosk.loadProfiles()) {
            is ProfilesLoad.Loaded -> { profiles = r.profiles.profiles; loadError = null }
            ProfilesLoad.Revoked -> Unit
            is ProfilesLoad.Failed -> if (!silent) loadError = r.message
        }
        loaded = true
    }

    LaunchedEffect(reloadKey) { load(silent = false) }
    // Re-poll so a new member appears without a relaunch, and the admin list sees us alive.
    LaunchedEffect(Unit) {
        while (true) {
            delay(60_000)
            kiosk.heartbeat()
            load(silent = true)
        }
    }
    LaunchedEffect(claimError) {
        if (claimError != null) { delay(4_000); claimError = null }
    }

    suspend fun attempt(p: KioskProfile, pin: String?): ClaimOutcome {
        claiming = p
        val outcome = kiosk.claim(p, pin)
        claiming = null
        when (outcome) {
            ClaimOutcome.Ok -> pinFor = null
            is ClaimOutcome.Failed -> { pinFor = null; claimError = outcome.message }
            is ClaimOutcome.WrongPin, is ClaimOutcome.LockedOut -> Unit
        }
        return outcome
    }

    Box(modifier.fillMaxSize().background(WF.colors.canvas)) {
        Column(
            Modifier.fillMaxSize().widthIn(max = 900.dp).align(Alignment.TopCenter),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier.padding(top = 64.dp, bottom = 44.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                KioskMark(80.dp)
                Text(modeState.deviceLabel ?: "Family hub", style = WF.type.serif(34.sp, FontWeight.Bold), color = WF.colors.ink)
                Text("Who’s using the tablet?", style = TextStyle(fontSize = 18.sp), color = WF.colors.ink3)
            }
            when {
                !loaded -> WaffledLoading(top = 80.dp)
                profiles.isEmpty() -> PickerEmpty(loadError) { loaded = false; reloadKey++ }
                else -> LazyVerticalGrid(
                    columns = GridCells.Adaptive(minSize = 160.dp),
                    modifier = Modifier.padding(horizontal = 28.dp),
                    horizontalArrangement = Arrangement.spacedBy(24.dp),
                    verticalArrangement = Arrangement.spacedBy(24.dp),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 48.dp),
                ) {
                    items(profiles, key = { it.id }) { p ->
                        ProfileCard(p, busy = claiming?.id == p.id, enabled = claiming == null) {
                            claimError = null
                            if (p.hasPin) pinFor = p else scope.launch { attempt(p, null) }
                        }
                    }
                }
            }
        }

        AnimatedVisibility(
            visible = claimError != null,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 40.dp),
        ) {
            Text(
                claimError.orEmpty(),
                Modifier.clip(CircleShape).background(WF.colors.ink.copy(alpha = 0.92f)).padding(horizontal = 18.dp, vertical = 12.dp),
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.onInk,
            )
        }

        // Always reachable: fix the server address or leave shared-kiosk mode, so a
        // misconfigured or remotely unpaired device is never stranded here.
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .padding(24.dp)
                .size(44.dp)
                .clip(CircleShape)
                .background(WF.colors.card2)
                .border(1.dp, WF.colors.hair, CircleShape)
                .clickable { showEscape = true },
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Outlined.Settings, "Kiosk settings", tint = WF.colors.ink3, modifier = Modifier.size(18.dp)) }
    }

    pinFor?.let { p ->
        KioskPinPad(p, onDismiss = { pinFor = null }) { pin -> attempt(p, pin) }
    }
    if (showEscape) {
        KioskPickerEscapeSheet(
            kiosk = kiosk,
            server = server,
            onServerChanged = { loaded = false; reloadKey++ },
            onDismiss = { showEscape = false },
        )
    }
}

@Composable
private fun ProfileCard(p: KioskProfile, busy: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        Modifier
            .fillMaxWidth()
            .wfShadow1(shape)
            .clip(shape)
            .background(WF.colors.card)
            .border(1.dp, WF.colors.hair, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 22.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            AvatarFromHex(p.colorHex, p.avatarEmoji ?: "🙂", size = 110.dp)
            if (busy) {
                Box(Modifier.size(110.dp).background(WF.colors.scrim, CircleShape))
                CircularProgressIndicator(color = WF.colors.onMedia)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(p.name, style = TextStyle(fontSize = 19.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            if (p.hasPin) Icon(Icons.Filled.Lock, "PIN protected", tint = WF.colors.ink3, modifier = Modifier.size(13.dp))
        }
    }
}

@Composable
private fun PickerEmpty(error: String?, onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(top = 60.dp, start = 40.dp, end = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("🙈", style = TextStyle(fontSize = 56.sp))
        Text("No profiles to show", style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
        Text(
            error ?: "Add household members (and toggle “Show on kiosk”) from Settings on another device.",
            style = TextStyle(fontSize = 15.sp, textAlign = TextAlign.Center),
            color = WF.colors.ink3,
        )
        Text(
            "Try again",
            Modifier.padding(top = 6.dp).clickable(onClick = onRetry),
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.primary,
        )
    }
}

/**
 * A big touch keypad for a profile's 4–8 digit PIN. Wrong-PIN and lockout copy stays
 * inline; it closes only on success (the gate flips to the shell) or the ✕.
 */
@Composable
fun KioskPinPad(profile: KioskProfile, onDismiss: () -> Unit, onSubmit: suspend (String) -> ClaimOutcome) {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf(PinPadState()) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(state.lockedFor) {
        if (state.locked) { delay(1_000); state = state.tick() }
    }

    fun submit() {
        if (!state.canSubmit || busy) return
        busy = true
        scope.launch {
            val outcome = onSubmit(state.pin)
            busy = false
            state = state.after(outcome)
        }
    }

    Dialog(
        onDismissRequest = { if (!busy) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(Modifier.fillMaxSize().background(WF.colors.canvas)) {
            Column(
                Modifier.align(Alignment.Center).widthIn(max = 380.dp).padding(vertical = 40.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(26.dp),
            ) {
                AvatarFromHex(profile.colorHex, profile.avatarEmoji ?: "🙂", size = 84.dp)
                Text(profile.name, style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                Text(
                    state.prompt,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium),
                    color = if (state.locked) WF.colors.primary else WF.colors.ink3,
                )
                Row(Modifier.height(16.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    repeat(state.dotCount) { i ->
                        Box(Modifier.size(14.dp).background(if (i < state.pin.length) WF.colors.ink else WF.colors.hair, CircleShape))
                    }
                }
                state.visibleMessage?.let {
                    Text(it, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.primary)
                }
                val inputOn = !busy && !state.locked
                Column(Modifier.padding(horizontal = 30.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                    listOf("123", "456", "789", "⌫0✓").forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(22.dp)) {
                            row.forEach { k ->
                                when (k) {
                                    '⌫' -> PinKey(Color.Transparent, inputOn, outlined = false, onClick = { state = state.backspace() }) {
                                        Icon(Icons.AutoMirrored.Filled.Backspace, "Delete", tint = WF.colors.ink2, modifier = Modifier.size(24.dp))
                                    }
                                    '✓' -> PinKey(
                                        if (state.canSubmit) WF.colors.primary else WF.colors.ink3,
                                        inputOn && state.canSubmit,
                                        outlined = false,
                                        onClick = ::submit,
                                    ) {
                                        // White on the saturated coral fill, as WaffledPrimaryCTA does.
                                        Icon(Icons.Filled.Check, "Submit", tint = Color.White, modifier = Modifier.size(26.dp))
                                    }
                                    else -> PinKey(WF.colors.card, inputOn, outlined = true, onClick = { state = state.press(k) }) {
                                        Text("$k", style = TextStyle(fontSize = 30.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            CloseButton(Modifier.align(Alignment.TopEnd).padding(20.dp)) { if (!busy) onDismiss() }
        }
    }
}

@Composable
private fun PinKey(fill: Color, enabled: Boolean, outlined: Boolean, onClick: () -> Unit, label: @Composable () -> Unit) {
    Box(
        Modifier
            .size(78.dp)
            .clip(CircleShape)
            .background(fill)
            .then(if (outlined) Modifier.border(1.dp, WF.colors.hair, CircleShape) else Modifier)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { label() }
}

@Composable
internal fun CloseButton(modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier.size(40.dp).clip(CircleShape).background(WF.colors.card2).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(Icons.Filled.Close, "Close", tint = WF.colors.ink2, modifier = Modifier.size(16.dp)) }
}

/** The Waffled mark. Android has no bundled mark asset yet, so this matches LoginScreen. */
@Composable
internal fun KioskMark(size: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier) {
    Text("🧇", modifier, style = TextStyle(fontSize = (size.value * 0.8f).sp))
}

/**
 * The picker's only non-claim affordance: check or correct the server address and retry
 * in place, or exit shared-kiosk mode (local only — nobody is signed in to revoke).
 */
@Composable
fun KioskPickerEscapeSheet(
    kiosk: KioskMode,
    server: KioskServerAddress,
    onServerChanged: () -> Unit,
    onDismiss: () -> Unit,
) {
    var url by remember { mutableStateOf(server.current()) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmExit by remember { mutableStateOf(false) }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(WF.colors.canvas)) {
            Column(
                Modifier
                    .align(Alignment.TopCenter)
                    .widthIn(max = 520.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(28.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Column(Modifier.padding(top = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("⚙️", style = TextStyle(fontSize = 40.sp))
                    Text("Kiosk settings", style = WF.type.serif(26.sp, FontWeight.Bold), color = WF.colors.ink)
                }
                val cardShape = RoundedCornerShape(WF.radius.lg)
                Column(
                    Modifier.fillMaxWidth().clip(cardShape).background(WF.colors.card).border(1.dp, WF.colors.hair, cardShape).padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    WaffledTextField(
                        value = url,
                        onValueChange = { url = it; error = null },
                        label = "Server address",
                        placeholder = "http://192.168.1.50:8080",
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                    )
                    error?.let { Text(it, style = TextStyle(fontSize = 12.sp), color = WF.colors.primaryD) }
                    val sm = RoundedCornerShape(WF.radius.sm)
                    Box(
                        Modifier.fillMaxWidth().clip(sm).background(WF.colors.card2).border(1.dp, WF.colors.hair, sm)
                            .clickable {
                                val problem = server.set(url)
                                if (problem != null) {
                                    error = problem
                                } else {
                                    url = server.current()
                                    kiosk.serverChanged()
                                    onServerChanged()
                                    onDismiss()
                                }
                            }
                            .padding(vertical = 12.dp),
                        contentAlignment = Alignment.Center,
                    ) { Text("Use this server & retry", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink) }
                    Text(
                        "If profiles load but tapping a face fails, the address is usually fine — try again, or ask an admin to re-check this kiosk.",
                        style = TextStyle(fontSize = 12.sp),
                        color = WF.colors.ink3,
                    )
                }
                val md = RoundedCornerShape(WF.radius.md)
                if (!confirmExit) {
                    Row(
                        Modifier.fillMaxWidth().clip(md).background(WF.colors.card).border(1.dp, WF.colors.primary.copy(alpha = 0.4f), md)
                            .clickable { confirmExit = true }.padding(vertical = 14.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Logout, null, tint = WF.colors.primary, modifier = Modifier.size(15.dp))
                        Text("Exit shared kiosk", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.primary)
                    }
                } else {
                    // Confirmation built into the page: dialogs-over-dialogs read poorly on a wall display.
                    Column(
                        Modifier.fillMaxWidth().clip(md).background(WF.colors.card).border(1.dp, WF.colors.hair, md).padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text("Exit shared kiosk on this tablet?", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                        Text(
                            "This tablet goes back to the normal sign-in screen. The household and everyone's data are untouched.",
                            style = TextStyle(fontSize = 13.sp),
                            color = WF.colors.ink3,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            ConfirmChip("Cancel", WF.colors.panel, WF.colors.ink2, Modifier.weight(1f)) { confirmExit = false }
                            ConfirmChip("Exit kiosk mode", WF.colors.primary, Color.White, Modifier.weight(1f)) {
                                kiosk.handleDeviceRevoked()
                                onDismiss()
                            }
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
            }
            CloseButton(Modifier.align(Alignment.TopEnd).padding(20.dp), onClick = onDismiss)
        }
    }
}

@Composable
internal fun ConfirmChip(label: String, fill: Color, fg: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier.clip(CircleShape).background(fill).clickable(onClick = onClick).padding(vertical = 11.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = fg) }
}

/**
 * Pair a FRESH tablet as a shared kiosk with the one-time code an admin generated
 * elsewhere (Settings → Display & Kiosk → "Pair a kiosk"). Reachable from login.
 */
@Composable
fun KioskCodeEntrySheet(kiosk: KioskMode, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    Dialog(onDismissRequest = { if (!busy) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(WF.colors.canvas)) {
            Column(
                Modifier.align(Alignment.TopCenter).widthIn(max = 480.dp).verticalScroll(rememberScrollState()).padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(22.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("Shared kiosk", style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("🖥️", style = TextStyle(fontSize = 52.sp))
                    Text(
                        "Use this tablet as a family hub",
                        style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center),
                        color = WF.colors.ink,
                    )
                    Text(
                        "Everyone in the household taps their own face to sign in — no shared password.",
                        style = TextStyle(fontSize = 14.sp, textAlign = TextAlign.Center),
                        color = WF.colors.ink3,
                    )
                }
                WaffledTextField(
                    value = code,
                    onValueChange = { code = it.uppercase(); error = null },
                    label = "Pairing code",
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth(),
                )
                WaffledTextField(
                    value = label,
                    onValueChange = { label = it },
                    label = "Name this display (optional)",
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let {
                    Text(it, Modifier.fillMaxWidth(), style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium), color = WF.colors.primary)
                }
                app.waffled.core.design.WaffledPrimaryCTA(
                    label = if (busy) "Setting up…" else "Set up this tablet",
                    isDisabled = !KioskCodeEntry.canSubmit(code, busy),
                    onClick = {
                        busy = true
                        error = null
                        scope.launch {
                            error = kiosk.enableViaCode(code, label)
                            busy = false
                            if (error == null) onDismiss()
                        }
                    },
                )
                Text(
                    "Ask an adult to open Waffled → Settings → Display & Kiosk → “Pair a kiosk” to get a code. It’s one-time and expires in about 10 minutes.",
                    style = TextStyle(fontSize = 12.5.sp, textAlign = TextAlign.Center, fontFamily = FontFamily.Default),
                    color = WF.colors.ink3,
                )
            }
            CloseButton(Modifier.align(Alignment.TopEnd).padding(20.dp)) { if (!busy) onDismiss() }
        }
    }
}

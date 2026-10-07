package app.waffled.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Warning
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.WaffledTextField
import kotlinx.coroutines.launch

private sealed interface ProbeState {
    data object Idle : ProbeState
    data object Testing : ProbeState
    data class Ok(val status: Int) : ProbeState
    data object Fail : ProbeState
}

/**
 * About & connection: the app version, and the server address — the Caddy origin that
 * serves both `/api` and `/media`. Typing a public host over plain http warns at once
 * (plan §7.5) because saving it is refused.
 */
@Composable
internal fun AboutSettingsScreen(
    api: SettingsApi,
    host: SettingsHost,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var address by remember { mutableStateOf(host.server.currentUrl()) }
    var serverError by remember { mutableStateOf<String?>(null) }
    var savedNote by remember { mutableStateOf<String?>(null) }
    var probe by remember { mutableStateOf<ProbeState>(ProbeState.Idle) }
    var update by remember { mutableStateOf<SettingsApi.UpdateInfo?>(null) }
    var metaRequest by remember { mutableStateOf(0) }

    LaunchedEffect(metaRequest) {
        update = ServerUpdateGate.fetchWithRetry(attempts = 6, delayMillis = 600) { api.updates() }
    }

    val liveWarning = ServerAddressForm.liveWarning(address)

    SettingsPage("About", onBack, modifier) {
        WaffledCard {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                WaffledEmojiTile("🧇", size = 30.dp, frame = 56.dp, background = WF.colors.card, cornerRadius = 14.dp)
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("Waffled", style = WF.type.serif(22.sp), color = WF.colors.ink)
                    Text(
                        "Version ${host.appVersion} (${host.appBuild})",
                        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                }
            }
        }

        WaffledCard {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SectionLabel("Server")
                BodyNote(
                    "The address of your Waffled server — the Caddy origin that serves the app and your photos. " +
                        "Use http://10.0.2.2:8080 on the emulator, or http://<your-computer-ip>:8080 on a phone. " +
                        "The api’s own port (:3000) won’t serve photos.",
                    size = 12.5f, color = WF.colors.ink3,
                )
                IconLine(
                    Icons.Filled.Warning, WF.colors.gold,
                    "Your sign-in is tied to one server. Pointing at a different Waffled won’t carry your account over — " +
                        "even if someone else hosts Waffled, you’ll need an account there, and may see nothing until you sign in again.",
                    size = 12f,
                )
                WaffledTextField(
                    value = address,
                    onValueChange = { address = it; serverError = null },
                    placeholder = host.server.defaultUrl,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                )
                liveWarning?.let { IconLine(Icons.Filled.Warning, WF.colors.warn, it, size = 12.5f) }
                serverError?.let { FormMessage(it, WF.colors.primaryD) }

                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    CapsuleButton("Save", fill = WF.colors.primary, textColor = Color.White, horizontal = 20.dp, onClick = {
                        serverError = null
                        probe = ProbeState.Idle
                        savedNote = "Checking and reconnecting…"
                        update = null
                        scope.launch {
                            val change = host.server.change(address)
                            val msg = ServerAddressForm.message(change)
                            serverError = msg.error
                            savedNote = msg.note
                            if (change is ServerChange.Updated) {
                                address = host.server.currentUrl()
                                metaRequest++
                            }
                        }
                    })
                    Row(
                        Modifier
                            .clip(RoundedCornerShape(WF.radius.pill))
                            .background(WF.colors.panel)
                            .clickable(enabled = probe != ProbeState.Testing) {
                                val url = ServerAddressForm.probeUrl(address)
                                if (url == null) {
                                    serverError = liveWarning ?: ServerAddressForm.INVALID_ADDRESS
                                    probe = ProbeState.Idle
                                } else {
                                    serverError = null
                                    probe = ProbeState.Testing
                                    scope.launch {
                                        probe = SettingsApi.probeHealth(url)?.let { ProbeState.Ok(it) } ?: ProbeState.Fail
                                    }
                                }
                            }
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (probe == ProbeState.Testing) {
                            CircularProgressIndicator(Modifier.size(14.dp), color = WF.colors.ink3, strokeWidth = 2.dp)
                        }
                        Text("Test", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink2)
                    }
                    Spacer(Modifier.weight(1f))
                    Text(
                        "Reset",
                        modifier = Modifier.clickable { address = host.server.defaultUrl; serverError = null },
                        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                }

                when (val p = probe) {
                    is ProbeState.Ok -> IconLine(Icons.Filled.CheckCircle, WF.colors.success, "Server responded (HTTP ${p.status}) — reachable.", bold = true)
                    ProbeState.Fail -> IconLine(
                        Icons.Filled.Error, WF.colors.primaryD,
                        "Couldn’t reach that address. Check the IP/port and that the stack is running.", bold = true,
                    )
                    else -> Unit
                }
                update?.let { u ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(7.dp).background(WF.colors.success, CircleShape))
                        Text(
                            "Server version ${u.current.version}",
                            style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink3,
                        )
                    }
                    val latest = u.latest
                    if (u.updateAvailable == true && latest != null) UpdateBanner(latest, u.current.version)
                }
                savedNote?.let {
                    Text(it, style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink2)
                }
            }
        }
    }
}

@Composable
private fun IconLine(icon: ImageVector, color: Color, text: String, size: Float = 12.5f, bold: Boolean = true) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, null, tint = color, modifier = Modifier.size((size + 2).dp).padding(top = 1.dp))
        Text(text, style = TextStyle(fontSize = size.sp, fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal), color = color)
    }
}

/** A newer server release is out — nudge the operator (the upgrade runs on the host). */
@Composable
private fun UpdateBanner(latest: SettingsApi.UpdateInfo.Release, current: String) {
    val uri = LocalUriHandler.current
    val shape = RoundedCornerShape(WF.radius.md)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(WF.colors.primary.copy(alpha = 0.08f))
            .border(1.dp, WF.colors.primary.copy(alpha = 0.25f), shape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("🧇", style = TextStyle(fontSize = 15.sp))
            Text("Update available", style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.ExtraBold), color = WF.colors.primary)
            Spacer(Modifier.weight(1f))
            Text(
                "Waffled ${ServerUpdateGate.displayTag(latest.tag)}",
                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink2,
            )
        }
        Text(
            "A newer Waffled is out — you’re on $current. Run ${ServerUpdateGate.UPGRADE_COMMAND} on the server that hosts Waffled.",
            style = TextStyle(fontSize = 12.sp),
            color = WF.colors.ink3,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "Changelog",
                modifier = Modifier
                    .clip(RoundedCornerShape(WF.radius.pill))
                    .border(1.dp, WF.colors.hair, RoundedCornerShape(WF.radius.pill))
                    .clickable { runCatching { uri.openUri(latest.url) } }
                    .padding(horizontal = 13.dp, vertical = 7.dp),
                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink2,
            )
            CapsuleButton(
                "How to upgrade", { runCatching { uri.openUri(ServerUpdateGate.UPGRADE_GUIDE_URL) } },
                fill = WF.colors.primary, textColor = Color.White, size = 12.5f, horizontal = 13.dp, vertical = 7.dp,
            )
        }
    }
}

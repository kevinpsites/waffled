package app.waffled.feature.kiosk

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import kotlinx.coroutines.launch

/**
 * Settings → Display & Kiosk → "This tablet" (tablet + parent only, like iOS "This
 * iPad"): turn this signed-in device into a shared kiosk in one tap, pair with a code
 * instead, or — once shared — switch profile / stop sharing. Confirmations are inline.
 */
@Composable
fun KioskThisDeviceCard(kiosk: KioskMode, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    val state by kiosk.state.collectAsState()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<String?>(null) }
    var showCode by remember { mutableStateOf(false) }

    WaffledCard(modifier, padding = 18.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (state.isShared) {
                Label(
                    "This tablet is a shared kiosk",
                    state.deviceLabel?.takeIf { it.isNotEmpty() }?.let { "“$it” · anyone can switch from the picker." }
                        ?: "Anyone can switch from the picker.",
                )
                if (confirm == STOP) {
                    Confirm(
                        "Stop sharing this tablet?",
                        "This tablet returns to a single sign-in. You’ll need to sign in again.",
                        "Stop sharing",
                        onCancel = { confirm = null },
                    ) { scope.launch { kiosk.unpair() } }
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Pill("Switch profile", WF.colors.primary) { scope.launch { kiosk.returnToPicker() } }
                        Pill("Stop sharing", null) { confirm = STOP }
                    }
                }
            } else {
                Label(
                    "Use this tablet as a shared kiosk",
                    "Show a profile picker so anyone in the household can tap their face to sign in — no shared password.",
                )
                if (confirm == PROMOTE) {
                    Confirm(
                        "Turn this tablet into a shared kiosk?",
                        "You’ll be signed out and the household picks a profile from a picker. You can switch back anytime.",
                        "Turn on shared kiosk",
                        onCancel = { confirm = null },
                    ) {
                        confirm = null
                        busy = true
                        error = null
                        scope.launch {
                            error = kiosk.enableViaPromote(null)
                            busy = false
                        }
                    }
                } else {
                    Pill(if (busy) "Setting up…" else "Turn this tablet into a shared kiosk", WF.colors.primary, wide = true, enabled = !busy) {
                        confirm = PROMOTE
                    }
                }
                Text(
                    "Pair with a code instead",
                    Modifier.clickable { showCode = true },
                    style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink2,
                )
                error?.let { Text(it, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium), color = WF.colors.primary) }
            }
        }
    }
    if (showCode) KioskCodeEntrySheet(kiosk, onDismiss = { showCode = false })
}

@Composable
private fun Label(title: String, subtitle: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(title, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
        Text(subtitle, style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
    }
}

@Composable
private fun Confirm(title: String, message: String, action: String, onCancel: () -> Unit, onConfirm: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
        Text(message, style = TextStyle(fontSize = 13.sp), color = WF.colors.ink3)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ConfirmChip("Cancel", WF.colors.panel, WF.colors.ink2, Modifier.weight(1f), onCancel)
            ConfirmChip(action, WF.colors.primary, Color.White, Modifier.weight(1f), onConfirm)
        }
    }
}

/** A filled coral pill (white on the saturated fill), or a faint card2 one when [tint] is null. */
@Composable
private fun Pill(label: String, tint: Color?, wide: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        Modifier
            .then(if (wide) Modifier.fillMaxWidth() else Modifier)
            .clip(CircleShape)
            .background(tint ?: WF.colors.card2)
            .then(if (tint == null) Modifier.border(1.dp, WF.colors.hair, CircleShape) else Modifier)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 12.dp),
        contentAlignment = androidx.compose.ui.Alignment.Center,
    ) {
        Text(label, style = TextStyle(fontSize = 14.5.sp, fontWeight = FontWeight.Bold), color = if (tint == null) WF.colors.ink2 else Color.White)
    }
}

private const val STOP = "stop"
private const val PROMOTE = "promote"

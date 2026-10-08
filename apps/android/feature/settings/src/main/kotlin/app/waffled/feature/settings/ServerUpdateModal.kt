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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import android.content.ClipData
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import kotlinx.coroutines.launch
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.wfShadow3

/** Remembers which release tag the admin dismissed. `app` backs it with SharedPreferences. */
interface UpdateDismissalStore {
    fun dismissedTag(): String?
    fun dismiss(tag: String)

    /** "Remind me later": held for the process's life, so it must outlive the Activity. */
    fun snoozedTag(): String? = null
    fun snooze(tag: String) {}
}

/**
 * The app-wide "a newer Waffled server is available" modal (admin-only — `/api/updates`
 * is admin-gated, so a 403 simply keeps it shut). Mount it once at the app root so it can
 * appear over any screen. × remembers the tag; "Remind me later" closes for this launch.
 */
@Composable
fun ServerUpdateModal(api: SettingsApi, store: UpdateDismissalStore) {
    var info by remember { mutableStateOf<SettingsApi.UpdateInfo?>(null) }
    var open by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        val r = ServerUpdateGate.fetchWithRetry(attempts = 8, delayMillis = 700) { api.updates() } ?: return@LaunchedEffect
        info = r
        open = ServerUpdateGate.shouldOpen(r, store.dismissedTag(), store.snoozedTag())
    }

    val latest = info?.latest
    if (!open || latest == null) return

    val snooze = {
        store.snooze(latest.tag)
        open = false
    }
    val dismiss = {
        store.dismiss(latest.tag)
        open = false
    }
    Dialog(onDismissRequest = snooze) {
        UpdateCard(latest, current = info?.current?.version ?: "—", onClose = dismiss, onSnooze = snooze)
    }
}

@Composable
private fun UpdateCard(
    latest: SettingsApi.UpdateInfo.Release,
    current: String,
    onClose: () -> Unit,
    onSnooze: () -> Unit,
) {
    val uri = LocalUriHandler.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        Modifier
            .widthIn(max = 420.dp)
            .wfShadow3(shape)
            .clip(shape)
            .background(WF.colors.card)
            .border(1.dp, WF.colors.hair, shape),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.fillMaxWidth().padding(top = 22.dp, start = 20.dp, end = 20.dp)) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                WaffledEmojiTile("🧇", size = 40.dp, frame = 68.dp, cornerRadius = 18.dp)
                Text(
                    "UPDATE AVAILABLE",
                    style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.6.sp),
                    color = WF.colors.primary,
                )
                Text(
                    "Waffled ${ServerUpdateGate.displayTag(latest.tag)} is here",
                    style = WF.type.serif(24.sp, FontWeight.Bold),
                    color = WF.colors.ink,
                    textAlign = TextAlign.Center,
                )
                Text("You’re on $current", style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
            }
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .size(30.dp)
                    .clip(CircleShape)
                    .background(WF.colors.panel)
                    .clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Close, contentDescription = "Dismiss", tint = WF.colors.ink3, modifier = Modifier.size(15.dp))
            }
        }

        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("To update, run this on the server that hosts Waffled:", style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(WF.radius.md))
                    .background(WF.colors.panel)
                    .padding(horizontal = 13.dp, vertical = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    ServerUpdateGate.UPGRADE_COMMAND,
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace),
                    color = WF.colors.ink,
                )
                Spacer(Modifier.weight(1f))
                Icon(
                    if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy,
                    contentDescription = "Copy command",
                    tint = if (copied) WF.colors.primary else WF.colors.ink3,
                    modifier = Modifier.size(16.dp).clickable {
                        scope.launch {
                            clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("command", ServerUpdateGate.UPGRADE_COMMAND)))
                            copied = true
                        }
                    },
                )
            }
        }

        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ModalButton("View changelog", WF.colors.panel, WF.colors.ink2, Modifier.weight(1f)) { runCatching { uri.openUri(latest.url) } }
            ModalButton("How to upgrade", WF.colors.primary, Color.White, Modifier.weight(1f)) {
                runCatching { uri.openUri(ServerUpdateGate.UPGRADE_GUIDE_URL) }
            }
        }
        Text(
            "Remind me later",
            modifier = Modifier.clickable(onClick = onSnooze).padding(vertical = 14.dp),
            style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink3,
        )
    }
}

@Composable
private fun ModalButton(label: String, fill: Color, text: Color, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label,
        modifier = modifier
            .clip(RoundedCornerShape(WF.radius.md))
            .background(fill)
            .clickable(onClick = onClick)
            .padding(vertical = 13.dp),
        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center),
        color = text,
    )
}

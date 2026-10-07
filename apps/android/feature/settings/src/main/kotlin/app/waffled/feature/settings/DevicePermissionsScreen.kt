package app.waffled.feature.settings

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmojiTile

/**
 * Settings → Permissions: the device permissions Waffled uses. Like iOS, every row
 * deep-links to Waffled's page in the system settings, where a denied permission can be
 * turned back on (the app can't re-ask once the user has said no twice).
 */
@Composable
internal fun DevicePermissionsScreen(onBack: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val openAppSettings = {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(intent) }
        Unit
    }

    SettingsPage("Permissions", onBack, modifier, spacing = 22.dp) {
        BodyNote("These are permissions you grant on this device. Android only lets you change them in system Settings — tap Open on any of them to jump straight to Waffled's settings page.")
        Column(Modifier.fillMaxWidth().settingsBox().padding(horizontal = 18.dp)) {
            PermissionRow("❤️", "Health Connect", "Auto-fill step, flight & exercise goals from your phone & watch.", openAppSettings)
            HairDivider()
            PermissionRow("🔔", "Notifications", "Reminders before your calendar events.", openAppSettings)
            HairDivider()
            PermissionRow("📷", "Camera", "Chore photo-proof and grocery barcode scanning.", openAppSettings)
            HairDivider()
            PermissionRow("🎤", "Microphone", "Speak an event into the capture bar.", openAppSettings)
        }
        BodyNote(
            "If you turned a permission off (or off by accident), flip it back on here — the app can't re-ask on its own.",
            size = 12f,
            color = WF.colors.ink3,
        )
    }
}

@Composable
private fun PermissionRow(emoji: String, title: String, subtitle: String, onOpen: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WaffledEmojiTile(emoji)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            Text(subtitle, style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
        }
        CapsuleButton(
            "Open", onOpen,
            fill = WF.colors.primary.copy(alpha = 0.10f), textColor = WF.colors.primary,
            size = 13f, horizontal = 13.dp, vertical = 7.dp,
        )
    }
}

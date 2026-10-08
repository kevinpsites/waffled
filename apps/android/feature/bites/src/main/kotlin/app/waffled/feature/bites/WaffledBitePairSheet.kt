package app.waffled.feature.bites

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.WaffledStatusBadge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/**
 * Mints a one-time code and waits for the physical device to claim it. Mirrors the web
 * `WaffledBitePairModal`: no client-side timeout — polling runs until the device shows
 * up or the sheet closes (leaving composition cancels the loop). The server's 10-minute
 * code TTL is the only real limit.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WaffledBitePairSheet(
    api: WaffledBitesApi,
    personId: String,
    personName: String,
    onPaired: () -> Unit,
    onDismiss: () -> Unit,
) {
    var code by remember { mutableStateOf<String?>(null) }
    var mintFailed by remember { mutableStateOf(false) }

    LaunchedEffect(personId) {
        code = try {
            api.mintPairingCode(personId, "$personName's Waffled-Bite").code
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            mintFailed = true
            return@LaunchedEffect
        }
        while (true) {
            delay(2_000)
            val paired = try {
                api.device(personId) != null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                false
            }
            if (paired) {
                onPaired()
                return@LaunchedEffect
            }
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = WF.colors.card) {
        Column(
            Modifier.fillMaxWidth().padding(28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            Text("🧇", style = TextStyle(fontSize = 44.sp))
            val current = code
            when {
                mintFailed -> Text(
                    "Couldn't start pairing — try again.",
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.danger,
                )
                current != null -> Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Text(
                        current,
                        style = TextStyle(
                            fontSize = 40.sp,
                            fontWeight = FontWeight.Black,
                            fontFamily = FontFamily.Monospace,
                            letterSpacing = 6.sp,
                        ),
                        color = WF.colors.ink,
                    )
                    Text(
                        "Waiting for the Waffled-Bite…",
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                    CircularProgressIndicator(color = WF.colors.ink3, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                }
                else -> {
                    CircularProgressIndicator(color = WF.colors.ink3, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                    Text(
                        "Generating a code…",
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                }
            }
            Text(
                "Cancel",
                modifier = Modifier.clickable(onClick = onDismiss).padding(8.dp),
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink2,
            )
        }
    }
}

/**
 * The person page's Waffled-Bite row: pairs a device, or opens its control panel once
 * paired. A full-width row rather than a pill beside the avatar, which reads as
 * decorative. Gate it on the `waffledBites` module only — like web, there is no
 * per-person kid check.
 */
@Composable
fun WaffledBiteEntryCard(
    api: WaffledBitesApi,
    personId: String,
    firstName: String,
    onOpenControls: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var device by remember { mutableStateOf<WaffledBitesApi.Device?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var pairing by remember { mutableStateOf(false) }

    LaunchedEffect(personId, reload) {
        device = try {
            api.device(personId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
    }

    val shape = RoundedCornerShape(WF.radius.lg)
    Row(
        modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clickable { if (device != null) onOpenControls() else pairing = true }
            .padding(15.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WaffledEmojiTile(emoji = "🧇", size = 24.dp, frame = 46.dp)
        Spacer(Modifier.width(13.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Waffled-Bite", style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
            Text(
                if (device != null) "Open controls" else "Pair $firstName’s device",
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
        }
        WaffledBiteStatus.badge(device)?.let { badge ->
            Spacer(Modifier.width(8.dp))
            WaffledStatusBadge(text = badge.label, color = badgeColor(badge))
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = WF.colors.ink3,
            modifier = Modifier.size(20.dp),
        )
    }

    if (pairing) {
        WaffledBitePairSheet(
            api = api,
            personId = personId,
            personName = firstName,
            onPaired = {
                pairing = false
                reload++
                onOpenControls()
            },
            onDismiss = { pairing = false },
        )
    }
}

@Composable
private fun badgeColor(badge: WaffledBiteStatus.Badge): Color = when (badge) {
    WaffledBiteStatus.Badge.Quiet, WaffledBiteStatus.Badge.Timer -> WF.colors.primary
    WaffledBiteStatus.Badge.Asleep -> SleepColors.ink()
    WaffledBiteStatus.Badge.AlmostWake -> WF.colors.warn
    WaffledBiteStatus.Badge.AwakeTime -> WF.colors.success
}

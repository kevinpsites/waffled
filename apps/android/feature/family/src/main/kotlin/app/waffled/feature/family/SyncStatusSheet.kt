package app.waffled.feature.family

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.Group
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.model.Person
import app.waffled.core.sync.SyncState

/**
 * The sync status sheet, opened from the hub's sync button — the port of iOS
 * `SyncStatusView`: PowerSync connection state, what's mirrored locally, and the
 * connection editor.
 *
 * The Android `SyncManager` exposes no pending-upload count, last-synced time or test
 * write yet, so those rows are absent. [connection] is the server-address editor, which
 * belongs to `app` (it owns the session and the server store).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SyncStatusSheet(
    state: SyncState,
    members: List<Person>,
    eventCount: Int,
    onDismiss: () -> Unit,
    lastError: String? = null,
    connection: (@Composable () -> Unit)? = null,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Sync", style = WF.type.title, color = WF.colors.ink)
            WaffledCard {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Box(Modifier.size(12.dp).background(syncDotColor(state), CircleShape))
                    Text(
                        state.name,
                        style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink,
                    )
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Stat("Persons", members.size, Icons.Filled.Group, Modifier.weight(1f))
                Stat("Events", eventCount, Icons.Filled.CalendarToday, Modifier.weight(1f))
            }
            WaffledCard {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionLabel("Family · from local SQLite")
                    if (members.isEmpty()) {
                        Text("No members synced yet.", style = TextStyle(fontSize = 13.sp), color = WF.colors.ink3)
                    } else {
                        members.forEach { m ->
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                AvatarFromHex(m.colorHex, m.avatarEmoji?.takeIf { it.isNotBlank() } ?: "🙂", size = 30.dp)
                                Text(m.name, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                                Spacer(Modifier.weight(1f))
                                m.memberType?.let {
                                    Text(it, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
                                }
                            }
                        }
                    }
                }
            }
            connection?.invoke()
            if (lastError != null) {
                Text(lastError, style = TextStyle(fontSize = 12.sp), color = WF.colors.danger)
            }
        }
    }
}

@Composable
private fun Stat(label: String, value: Int, icon: ImageVector, modifier: Modifier = Modifier) {
    WaffledCard(modifier = modifier, padding = 14.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Icon(icon, contentDescription = null, tint = WF.colors.ink3, modifier = Modifier.size(15.dp))
            Text("$value", style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
            Text(label, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
        }
    }
}

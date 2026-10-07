package app.waffled.feature.today

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.SyncProblem
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.FamilyColor
import app.waffled.core.design.WF
import app.waffled.core.network.RestNotice
import app.waffled.core.network.RestState

/**
 * In-place recovery notice for a non-authoritative [RestState] — the twin of the iOS
 * `RestStateNotice`. Renders nothing for loading, empty and ready, so a failure never
 * masquerades as an empty success while each card keeps its own empty copy.
 *
 * Lives here because `core:design` is frozen and nothing there carries a retry action or a
 * per-state tint; it is generic and should be promoted to `core:design`.
 */
@Composable
fun RestStateNotice(
    state: RestState,
    modifier: Modifier = Modifier,
    retry: (() -> Unit)? = null,
    compact: Boolean = false,
) {
    // Formatted once per state change, not on every recomposition.
    val notice = remember(state) { RestNotice.of(state) } ?: return
    val tint = notice.tone.color()
    val shape = RoundedCornerShape(WF.radius.md)
    val boxModifier = modifier
        .fillMaxWidth()
        .background(tint.copy(alpha = 0.09f), shape)
        .border(1.dp, tint.copy(alpha = 0.22f), shape)
        .padding(12.dp)
        .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }
    val showRetry = notice.canRetry && retry != null

    if (compact) {
        Column(boxModifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(state.icon(), contentDescription = null, tint = tint, modifier = Modifier.size(14.dp))
                Text(notice.title, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold), color = tint)
            }
            Text(notice.message, style = TextStyle(fontSize = 12.sp), color = tint)
            if (showRetry) RetryLabel(tint, retry!!)
        }
    } else {
        Row(boxModifier, horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(state.icon(), contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(notice.title, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold), color = tint)
                Text(notice.message, style = TextStyle(fontSize = 12.sp), color = tint)
            }
            if (showRetry) RetryLabel(tint, retry!!)
        }
    }
}

@Composable
private fun RetryLabel(tint: Color, onClick: () -> Unit) {
    Text(
        text = "Retry",
        modifier = Modifier.clickable(onClick = onClick).padding(vertical = 4.dp),
        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
        color = tint,
    )
}

@Composable
private fun RestNotice.Tone.color(): Color = when (this) {
    RestNotice.Tone.Warn -> WF.colors.warn
    RestNotice.Tone.Muted -> WF.colors.ink2
    RestNotice.Tone.Success -> FamilyColor.Person3.solid
    RestNotice.Tone.Primary -> WF.colors.primary
    RestNotice.Tone.Danger -> WF.colors.primaryD
}

private fun RestState.icon(): ImageVector = when (this) {
    is RestState.Stale -> Icons.Filled.History
    is RestState.Offline -> Icons.Filled.WifiOff
    is RestState.Queued -> Icons.Filled.Sync
    is RestState.Conflict -> Icons.Filled.SyncProblem
    is RestState.SignInRequired -> Icons.Filled.AccountCircle
    else -> Icons.Filled.Warning
}

package app.waffled.feature.familynight

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * The Today Family Night card: the gathering's date, its optional theme, and a per-part
 * person picker that overrides this week's rotation. `kiosk` is the larger family-display
 * variant (the iOS `KioskDashboard` use).
 *
 * [refreshKey] should change on pull-to-refresh — a bare one-shot load would sit on
 * launch-time data forever.
 */
@Composable
fun FamilyNightCard(
    model: FamilyNightModel,
    modifier: Modifier = Modifier,
    kiosk: Boolean = false,
    refreshKey: Any? = null,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var alert by remember { mutableStateOf<Pair<String, String>?>(null) }

    LaunchedEffect(model, refreshKey) { model.load() }

    fun assign(partId: String, personId: String?) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                if (model.assign(partId, personId) == FamilyNightModel.MutationOutcome.SavedButRefreshFailed) {
                    alert = "Assignment saved" to
                        "The assignment was saved, but Family Night couldn’t refresh. This screen may be out of date until it reloads."
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                alert = "Family Night unchanged" to
                    "Couldn’t change this assignment. Check your connection and try again."
            } finally {
                busy = false
            }
        }
    }

    WaffledCard(modifier = modifier, padding = if (kiosk) 18.dp else 15.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(if (kiosk) 12.dp else 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "🏡 Family Night",
                    style = if (kiosk) {
                        TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Black)
                    } else {
                        TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold)
                    },
                    color = if (kiosk) WF.colors.ink else WF.colors.ink2,
                    modifier = Modifier.weight(1f),
                )
                CircularProgressIndicator(
                    color = WF.colors.ink3,
                    strokeWidth = 2.dp,
                    modifier = Modifier.size(16.dp).alpha(if (busy) 1f else 0f),
                )
                state.view?.next?.date?.let { d ->
                    Spacer(Modifier.width(8.dp))
                    Text(
                        FamilyNightFormat.dateLabel(d),
                        style = TextStyle(fontSize = if (kiosk) 14.sp else 12.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                }
            }
            val view = state.view
            if (view != null) {
                view.next.theme?.takeIf { it.isNotEmpty() }?.let {
                    Text(
                        it,
                        style = TextStyle(fontSize = if (kiosk) 15.sp else 13.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink,
                    )
                }
                if (view.members.isEmpty()) {
                    Text(
                        "Add family members to start rotating the agenda.",
                        style = TextStyle(fontSize = if (kiosk) 15.sp else 13.sp),
                        color = WF.colors.ink3,
                    )
                } else {
                    view.next.assignments.forEach { a ->
                        PartRow(a, view.members, kiosk, enabled = !busy, onAssign = ::assign)
                    }
                }
            } else {
                Text(
                    if (state.loaded) "Couldn’t load Family Night." else "Loading…",
                    style = TextStyle(fontSize = if (kiosk) 15.sp else 13.sp),
                    color = WF.colors.ink3,
                )
            }
        }
    }

    alert?.let { (title, message) ->
        AlertDialog(
            onDismissRequest = { alert = null },
            title = { Text(title) },
            text = { Text(message) },
            confirmButton = { TextButton(onClick = { alert = null }) { Text("OK", color = WF.colors.primary) } },
            containerColor = WF.colors.card,
        )
    }
}

@Composable
private fun PartRow(
    a: FamilyNightApi.Assignment,
    members: List<FamilyNightApi.Member>,
    kiosk: Boolean,
    enabled: Boolean,
    onAssign: (partId: String, personId: String?) -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (kiosk) {
            Text(a.emoji, style = TextStyle(fontSize = 22.sp))
        } else {
            Box(
                Modifier.size(32.dp).background(WF.colors.panel, RoundedCornerShape(9.dp)),
                contentAlignment = Alignment.Center,
            ) { Text(a.emoji, style = TextStyle(fontSize = 17.sp)) }
        }
        Spacer(Modifier.width(if (kiosk) 12.dp else 10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                a.label,
                style = TextStyle(fontSize = if (kiosk) 18.sp else 14.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
            )
            // What the part is this week, when someone has said ("the good ice cream").
            a.detail?.takeIf { it.isNotBlank() }?.let {
                Text(
                    it,
                    style = TextStyle(fontSize = if (kiosk) 14.sp else 12.sp),
                    color = WF.colors.ink3,
                    maxLines = 2,
                )
            }
        }
        Spacer(Modifier.width(if (kiosk) 8.dp else 6.dp))
        PersonPicker(a, members, kiosk, enabled, onAssign)
    }
}

/** Assigns any member (or clears). Dimmed while it's only the rotation's suggestion. */
@Composable
private fun PersonPicker(
    a: FamilyNightApi.Assignment,
    members: List<FamilyNightApi.Member>,
    kiosk: Boolean,
    enabled: Boolean,
    onAssign: (partId: String, personId: String?) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val textSize = if (kiosk) 15.sp else 13.sp
    Box {
        Row(
            Modifier.clickable(enabled = enabled) { open = true }.padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(if (a.personName != null) 6.dp else 4.dp),
        ) {
            val name = a.personName
            if (name != null) {
                members.firstOrNull { it.id == a.personId }?.let { m ->
                    AvatarFromHex(m.color, m.emoji ?: "🙂", size = if (kiosk) 26.dp else 22.dp)
                }
                Text(
                    name,
                    style = TextStyle(fontSize = textSize, fontWeight = FontWeight.SemiBold),
                    color = if (a.suggested) WF.colors.ink3 else WF.colors.ink,
                )
                Icon(Icons.Filled.KeyboardArrowDown, null, tint = WF.colors.ink3, modifier = Modifier.size(14.dp))
            } else {
                Text("Pick", style = TextStyle(fontSize = textSize, fontWeight = FontWeight.SemiBold), color = WF.colors.ai)
                Icon(Icons.Filled.KeyboardArrowDown, null, tint = WF.colors.ai, modifier = Modifier.size(14.dp))
            }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            members.forEach { m ->
                DropdownMenuItem(
                    text = { Text(m.name) },
                    leadingIcon = if (m.id == a.personId) {
                        { Icon(Icons.Filled.Check, null) }
                    } else {
                        null
                    },
                    onClick = {
                        open = false
                        onAssign(a.partId, m.id)
                    },
                )
            }
            if (a.personId != null) {
                HorizontalDivider(color = WF.colors.hair)
                DropdownMenuItem(
                    text = { Text("Clear", color = WF.colors.danger) },
                    leadingIcon = { Icon(Icons.Filled.Close, null, tint = WF.colors.danger) },
                    onClick = {
                        open = false
                        onAssign(a.partId, null)
                    },
                )
            }
        }
    }
}

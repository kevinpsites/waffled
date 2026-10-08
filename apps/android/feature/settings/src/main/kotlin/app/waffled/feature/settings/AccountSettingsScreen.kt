package app.waffled.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SwapHoriz
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Households: who this device is signed in as (with your own calendar colour), the
 * household, and — when the account has more than one — the switcher and pending
 * invites. Sign out lives on the landing.
 */
@Composable
internal fun AccountSettingsScreen(
    api: SettingsApi,
    host: SettingsHost,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var settings by remember { mutableStateOf<SettingsApi.HouseholdSettings?>(null) }
    var overview by remember { mutableStateOf<SettingsApi.HouseholdOverview?>(null) }
    var switchingTo by remember { mutableStateOf<String?>(null) }
    var acceptingId by remember { mutableStateOf<String?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var pendingColor by remember { mutableStateOf<String?>(null) }
    var colorError by remember { mutableStateOf<String?>(null) }
    var colorSave by remember { mutableStateOf<Job?>(null) }
    var reload by remember { mutableStateOf(0) }

    LaunchedEffect(reload) {
        settings = runCatching { api.householdSettings() }.getOrNull() ?: settings
        overview = runCatching { api.household() }.getOrNull() ?: overview
    }

    val me = overview?.person?.id?.let { id -> settings?.members?.firstOrNull { it.id == id } }
    val myColor = pendingColor ?: me?.colorHex

    SettingsPage("Households", onBack, modifier) {
        WaffledCard {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SectionLabel("Signed in as")
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    AvatarFromHex(myColor, me?.avatarEmoji ?: "🙂", size = 44.dp)
                    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(me?.name ?: "—", style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            when {
                                me?.isOwner == true -> WaffledStatusBadge("Owner", WF.colors.gold)
                                me?.isAdmin == true -> WaffledStatusBadge("Admin", WF.colors.primary)
                            }
                            WaffledStatusBadge(me?.memberType?.capitalized() ?: "Member", WF.colors.ink3)
                        }
                    }
                }
                // Goes through the account profile route, so a teen or kid can set it
                // without an admin — Family & People, the other place, is admin-only.
                if (me != null) {
                    HairDivider()
                    SectionLabel("Your color")
                    ColorSwatchPicker(myColor ?: WaffledSwatch.all[0], size = 28.dp, onPick = { hex ->
                        pendingColor = hex
                        colorSave?.cancel()
                        colorSave = scope.launch {
                            delay(300)
                            colorError = null
                            try {
                                api.updateOwnColor(hex)
                                reload++
                            } catch (e: WaffledApiException) {
                                colorError = e.userMessage
                            } catch (e: kotlinx.coroutines.CancellationException) {
                                throw e
                            } catch (_: Exception) {
                                colorError = "Couldn’t save that color."
                            }
                            pendingColor = null
                        }
                    })
                    colorError?.let { FormMessage(it, WF.colors.danger) }
                }
            }
        }

        WaffledCard {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                SettingsIcon("🏡")
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(settings?.household?.name ?: "Household", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                    Text(settings?.household?.timezone.orEmpty(), style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
                }
            }
        }

        val o = overview
        if (o != null && o.memberships.size > 1) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionLabel("Your households", Modifier.padding(top = 6.dp))
                BodyNote("Switch which household this device is showing. Your other households stay signed in.", 12.5f, WF.colors.ink3)
                o.memberships.forEach { m ->
                    MembershipRow(
                        m,
                        isCurrent = m.householdId == o.household?.id,
                        busy = switchingTo == m.householdId,
                        locked = switchingTo != null,
                    ) {
                        actionError = AccountRules.switchBlockedMessage(host.pendingUploads())
                        if (actionError != null) return@MembershipRow
                        switchingTo = m.householdId
                        scope.launch {
                            try {
                                val r = api.switchHousehold(m.householdId)
                                if (host.adoptHouseholdSession(r.accessToken, r.refreshToken)) reload++
                                else actionError = "Couldn’t safely clear the previous household’s local data."
                            } catch (e: WaffledApiException) {
                                actionError = AccountRules.switchError(e.status)
                            } catch (e: kotlinx.coroutines.CancellationException) {
                                throw e
                            } catch (_: Exception) {
                                actionError = AccountRules.switchError(null)
                            }
                            switchingTo = null
                        }
                    }
                }
                actionError?.let { FormMessage(it, WF.colors.primary) }
            }
        }

        if (o != null && o.pendingInvites.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionLabel("Invitations", Modifier.padding(top = 6.dp))
                o.pendingInvites.forEach { inv ->
                    InviteRow(inv, busy = acceptingId == inv.id, locked = acceptingId != null) {
                        actionError = null
                        acceptingId = inv.id
                        scope.launch {
                            runCatching { api.acceptInvite(inv.id) }
                                .onSuccess { reload++ }
                                .onFailure { actionError = "Couldn't accept the invitation. Try again." }
                            acceptingId = null
                        }
                    }
                }
                if (o.memberships.size <= 1) actionError?.let { FormMessage(it, WF.colors.primary) }
            }
        }
    }
}

@Composable
private fun MembershipRow(
    m: SettingsApi.Membership,
    isCurrent: Boolean,
    busy: Boolean,
    locked: Boolean,
    onSwitch: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .settingsBox(stroke = if (isCurrent) WF.colors.primary.copy(alpha = 0.4f) else WF.colors.hair)
            .clickable(enabled = !isCurrent && !locked, onClick = onSwitch)
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SettingsIcon("🏡")
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(m.householdName, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            Text(AccountRules.roleText(m.isAdmin, m.memberType), style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
        }
        when {
            isCurrent -> WaffledStatusBadge("Current", WF.colors.primary)
            busy -> CircularProgressIndicator(Modifier.size(16.dp), color = WF.colors.ink3, strokeWidth = 2.dp)
            else -> Icon(Icons.Filled.SwapHoriz, contentDescription = "Switch", tint = WF.colors.ink3, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun InviteRow(inv: SettingsApi.PendingInvite, busy: Boolean, locked: Boolean, onAccept: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().settingsBox().padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SettingsIcon("✉️")
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(inv.householdName, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            Text(
                "Invited as ${AccountRules.roleText(inv.isAdmin, inv.memberType)}",
                style = TextStyle(fontSize = 12.sp),
                color = WF.colors.ink3,
            )
        }
        if (busy) {
            CircularProgressIndicator(Modifier.size(16.dp), color = WF.colors.primary, strokeWidth = 2.dp)
        } else {
            Text(
                "Accept",
                modifier = Modifier
                    .clip(RoundedCornerShape(WF.radius.pill))
                    .background(WF.colors.primary)
                    .clickable(enabled = !locked, onClick = onAccept)
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
                color = Color.White,
            )
        }
    }
}

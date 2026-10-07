package app.waffled.feature.family

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.FamilyColor
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.colorFromHex
import app.waffled.core.model.Capability
import app.waffled.core.model.Person
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.sync.SyncState
import kotlinx.coroutines.launch

/**
 * Which optional tiles the hub shows. Built by `app` from the household gate, because two
 * of these ([weeklyPlanning], [rhythms]) have no `WaffledModule` key on Android yet and
 * [rewards] is the chores sub-flag (`ModuleGate.rewardsOn`), not a module.
 */
data class FamilyHubGates(
    val chores: Boolean = true,
    val goals: Boolean = true,
    val rewards: Boolean = true,
    val lists: Boolean = true,
    val pantry: Boolean = false,
    val rhythms: Boolean = false,
    val weeklyPlanning: Boolean = false,
) {
    val restModules: FamilyRestModules
        get() = FamilyRestModules(chores = chores, goals = goals, rewards = rewards, lists = lists)
}

/**
 * The Family tab — a people row plus a launcher grid for every overflow area. The port of
 * iOS `FamilyView`.
 *
 * Navigation belongs to `app`: every tap is reported as a [HubRoute] through [onOpen].
 * [scope] must change on every sign-in and server change (see [FamilyHubModel.load]).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FamilyScreen(
    hub: FamilyHubModel,
    approvals: ApprovalsModel,
    gates: FamilyHubGates,
    members: List<Person>,
    me: Person?,
    syncState: SyncState,
    scope: Any,
    onOpen: (HubRoute) -> Unit,
    onOpenSync: () -> Unit,
    modifier: Modifier = Modifier,
    refreshBus: RefreshBus? = null,
) {
    val state by hub.state.collectAsStateWithLifecycle()
    val queue by approvals.state.collectAsStateWithLifecycle()
    val revisions = refreshBus?.state?.collectAsStateWithLifecycle()?.value.orEmpty()
    val coroutines = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }

    // Same key as iOS `LoadKey`: account scope, enabled feeds, and each feed's revision.
    LaunchedEffect(
        scope,
        gates.restModules,
        revisions[RefreshDomain.Chores],
        revisions[RefreshDomain.Goals],
        revisions[RefreshDomain.Rewards],
        revisions[RefreshDomain.Lists],
    ) {
        hub.load(scope, gates.restModules)
    }

    // Per-tile approval counts — only for someone who can action that queue.
    val choreApprovals = if (me?.can(Capability.CHORE_APPROVE) == true) queue.chores.size else 0
    val rewardApprovals = if (me?.can(Capability.REWARD_APPROVE) == true) queue.redemptions.size else 0

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            coroutines.launch {
                refreshing = true
                hub.load(scope, gates.restModules)
                approvals.load(scope, choresEnabled = gates.chores, rewardsEnabled = gates.rewards)
                refreshing = false
            }
        },
        modifier = modifier.fillMaxSize().background(WF.colors.canvas),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp)
                .padding(bottom = WF.spacing.tabBarClearance),
        ) {
            Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Family", style = WF.type.serif(30.sp), color = WF.colors.ink)
                Spacer(Modifier.weight(1f))
                SyncButton(syncState, onOpenSync)
            }

            PeopleRow(members, onPerson = { onOpen(HubRoute.Person(it)) }, modifier = Modifier.padding(top = 14.dp))
            Text(
                "Tap a person to see just their day, chores & goals.",
                modifier = Modifier.padding(top = 8.dp, bottom = 18.dp),
                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )

            SectionLabel("Everything else", Modifier.padding(bottom = 11.dp))
            FamilyRestNotice(
                visible = state.loaded && !state.isAuthoritative,
                onRetry = { coroutines.launch { hub.load(scope, gates.restModules) } },
                modifier = Modifier.padding(bottom = 11.dp),
            )

            val isDark = WF.colors.isDark
            val tiles = buildList {
                // First: the weekly ritual that FEEDS the rest of this grid.
                if (gates.weeklyPlanning) add(HubTileSpec("🗓️", "Weekly Planning", "Plan the week ahead", FamilyColor.Person2.tint(isDark), HubRoute.WeeklyPlanning))
                if (gates.chores) add(HubTileSpec("✅", "Chores", state.choresSubtitle, FamilyColor.Person3.tint(isDark), HubRoute.Chores, choreApprovals))
                if (gates.goals) add(HubTileSpec("🎯", "Goals", state.goalsSubtitle, WF.colors.successT, HubRoute.Goals))
                if (gates.rewards) add(HubTileSpec("⭐", "Rewards", state.rewardsSubtitle, WF.colors.warnT, HubRoute.Rewards, rewardApprovals))
                if (gates.lists) add(HubTileSpec("📋", "Lists", state.listsSubtitle, FamilyColor.Person1.tint(isDark), HubRoute.Lists))
                if (gates.pantry) add(HubTileSpec("🥫", "Pantry", "What’s on hand", WF.colors.warnT, HubRoute.Pantry))
                if (gates.rhythms) add(HubTileSpec("🔁", "Rhythms", "What should keep happening", WF.colors.infoT, HubRoute.Rhythms))
                // Photos and Settings are core and never gated.
                add(HubTileSpec("📷", "Photos", state.photosSubtitle, WF.colors.successT, HubRoute.Photos))
                add(HubTileSpec("⚙️", "Settings", "People, calendars, AI", WF.colors.panel, HubRoute.Settings))
            }
            // A fixed two-column grid inside the scroll: a lazy grid can't nest in a
            // scrolling column, and at most nine tiles there's nothing to virtualise.
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                tiles.chunked(2).forEach { pair ->
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        pair.forEach { HubTile(it, onOpen, Modifier.weight(1f)) }
                        if (pair.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

private data class HubTileSpec(
    val emoji: String,
    val name: String,
    val subtitle: String,
    val accent: Color,
    val route: HubRoute,
    val badge: Int = 0,
)

@Composable
private fun HubTile(spec: HubTileSpec, onOpen: (HubRoute) -> Unit, modifier: Modifier = Modifier) {
    // No clip ahead of the card: it would cut off WaffledCard's own shadow.
    WaffledCard(modifier = modifier.clickable { onOpen(spec.route) }, padding = 15.dp) {
        Row(verticalAlignment = Alignment.Top) {
            Box {
                Box(
                    Modifier.size(42.dp).background(spec.accent, RoundedCornerShape(12.dp)),
                    contentAlignment = Alignment.Center,
                ) { Text(spec.emoji, style = TextStyle(fontSize = 21.sp)) }
                if (spec.badge > 0) {
                    CountBadge(spec.badge, Modifier.align(Alignment.TopEnd).offset(x = 7.dp, y = (-7).dp))
                }
            }
            Spacer(Modifier.weight(1f))
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = WF.colors.ink3, modifier = Modifier.size(18.dp))
        }
        Text(
            spec.name,
            modifier = Modifier.padding(top = 11.dp),
            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ink,
        )
        // "N to approve" overrides the summary so the trail from the tab badge reads down.
        Text(
            if (spec.badge > 0) approvalLine(spec.badge) else spec.subtitle,
            modifier = Modifier.padding(top = 2.dp),
            style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
            color = if (spec.badge > 0) WF.colors.gold else WF.colors.ink3,
        )
    }
}

private fun approvalLine(n: Int) = if (n == 1) "1 to approve" else "$n to approve"

@Composable
private fun SyncButton(state: SyncState, onClick: () -> Unit) {
    Box(Modifier.size(36.dp).clip(CircleShape).clickable(onClick = onClick)) {
        Box(
            Modifier.size(36.dp).background(WF.colors.panel, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Sync, contentDescription = "Sync status", tint = WF.colors.ink2, modifier = Modifier.size(18.dp))
        }
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .size(9.dp)
                .background(syncDotColor(state), CircleShape)
                .border(BorderStroke(1.5.dp, WF.colors.canvas), CircleShape),
        )
    }
}

@Composable
internal fun syncDotColor(state: SyncState): Color = when (state) {
    SyncState.Connected -> FamilyColor.Person3.solid
    SyncState.Connecting -> WF.colors.gold
    SyncState.Offline, SyncState.Idle -> WF.colors.ink3
}

/**
 * Live members from the local mirror. iOS draws a static sample row before the first
 * sync; here an empty mirror shows only the Add chip, which is inert on iOS too.
 */
@Composable
private fun PeopleRow(members: List<Person>, onPerson: (String) -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        members.forEach { m ->
            PersonChip(m, Modifier.clip(RoundedCornerShape(WF.radius.sm)).clickable { onPerson(m.id) })
        }
        Column(Modifier.width(64.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Box(
                Modifier
                    .size(46.dp)
                    .background(WF.colors.panel, CircleShape)
                    .border(2.dp, WF.colors.hair, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Add, contentDescription = null, tint = WF.colors.ink3, modifier = Modifier.size(20.dp))
            }
            Text("Add", style = TextStyle(fontSize = 10.5.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink3)
        }
    }
}

@Composable
private fun PersonChip(m: Person, modifier: Modifier = Modifier) {
    Column(modifier.width(64.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Box {
            AvatarFromHex(m.colorHex, m.avatarEmoji?.takeIf { it.isNotBlank() } ?: "🙂", size = 46.dp)
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .size(14.dp)
                    .background(colorFromHex(m.colorHex) ?: WF.colors.ink3, CircleShape)
                    .border(2.dp, WF.colors.card, CircleShape),
            )
        }
        Text(m.name, maxLines = 1, style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
        Text(
            m.memberType?.replaceFirstChar { it.uppercase() }.orEmpty(),
            style = TextStyle(fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink3,
        )
    }
}

package app.waffled.feature.family

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Verified
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.ApprovalActionPair
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.model.Capability
import app.waffled.core.model.Person
import kotlinx.coroutines.launch

/** Whether `me` may act on either queue — the banner shows for nobody else. */
fun canApprove(me: Person?): Boolean =
    me != null && (me.can(Capability.CHORE_APPROVE) || me.can(Capability.REWARD_APPROVE))

/**
 * The gold "N to approve" entry card for Today, Chores and Rewards. Renders nothing for
 * someone who can't approve or for an authoritatively empty queue — but a queue that
 * failed to load still shows "Check approvals", so a missing count never hides the route.
 */
@Composable
fun ApprovalsBanner(
    model: ApprovalsModel,
    me: Person?,
    onOpen: () -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val s by model.state.collectAsStateWithLifecycle()
    if (!canApprove(me) || !s.showsEntryPoint) return
    val shape = RoundedCornerShape(WF.radius.lg)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(WF.colors.gold.copy(alpha = 0.10f), shape)
                .border(1.dp, WF.colors.gold.copy(alpha = 0.30f), shape)
                .clickable(onClick = onOpen)
                .padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(13.dp),
        ) {
            Box(
                Modifier.size(40.dp).background(WF.colors.gold, RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center,
            ) {
                // White on the saturated gold fill is the allowed literal-white case.
                Icon(Icons.Filled.Verified, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(s.entryTitle, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Black), color = WF.colors.ink)
                Text(
                    bannerPreview(s),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = WF.colors.gold, modifier = Modifier.size(20.dp))
        }
        FamilyRestNotice(visible = !s.loading && !s.isAuthoritative, onRetry = onRetry)
    }
}

internal fun bannerPreview(s: ApprovalsSnapshot): String {
    val names = s.redemptions.map { "${it.personName ?: "Someone"}’s ${it.title}" } +
        s.chores.map { "${it.personName ?: "Someone"}’s ${it.choreTitle}" }
    return names.take(3).joinToString(" · ").ifEmpty { "Review purchases & chores" }
}

/**
 * The approval queue — reward purchases and chore check-offs, cleared one tap at a time.
 * The port of iOS `ApprovalsView`.
 *
 * Each queue shows only to someone who can act on it: a chores-only approver never sees
 * reward purchases, and vice versa. [proofThumb] is the Chores module's proof thumbnail
 * (tapping it opens that module's review); null draws nothing.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ApprovalsScreen(
    model: ApprovalsModel,
    me: Person?,
    choresEnabled: Boolean,
    rewardsEnabled: Boolean,
    scope: Any,
    /** The symbol for a currency key (null = household default), e.g. "⭐". */
    currencySymbol: (String?) -> String,
    modifier: Modifier = Modifier,
    proofThumb: (@Composable (FamilyApi.ChoreInstance) -> Unit)? = null,
) {
    val s by model.state.collectAsStateWithLifecycle()
    val coroutines = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    suspend fun load() = model.load(scope, choresEnabled = choresEnabled, rewardsEnabled = rewardsEnabled)

    LaunchedEffect(scope, choresEnabled, rewardsEnabled) { load() }

    val showRedemptions = me?.can(Capability.REWARD_APPROVE) == true && s.redemptions.isNotEmpty()
    val showChores = me?.can(Capability.CHORE_APPROVE) == true && s.chores.isNotEmpty()

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = { coroutines.launch { refreshing = true; load(); refreshing = false } },
        modifier = modifier.fillMaxSize().background(WF.colors.canvas),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (s.loading && s.isEmpty) {
                WaffledLoading()
                return@Column
            }
            FamilyRestNotice(visible = !s.isAuthoritative, onRetry = { coroutines.launch { load() } })
            if (!showRedemptions && !showChores && s.isAuthoritative) {
                WaffledEmptyState(
                    emoji = "🎉",
                    title = "All caught up",
                    message = "No reward purchases or chores waiting on you.",
                )
            }
            if (showRedemptions) {
                SectionLabel("Reward purchases")
                s.redemptions.forEach { r ->
                    ApprovalRow(
                        avatarEmoji = r.personAvatar,
                        colorHex = r.personColor,
                        who = "${r.personName ?: "Someone"} wants",
                        what = "${r.emoji ?: "🎁"} ${r.title}",
                        coin = "${r.cost}${currencySymbol(r.currency)}",
                        denyLabel = "Deny",
                        onDeny = { coroutines.launch { model.decideRedemption(r.id, approve = false) } },
                        onApprove = { coroutines.launch { model.decideRedemption(r.id, approve = true) } },
                    )
                }
            }
            if (showChores) {
                SectionLabel("Chore check-offs", Modifier.padding(top = if (showRedemptions) 8.dp else 0.dp))
                s.chores.forEach { c ->
                    ApprovalRow(
                        avatarEmoji = c.emoji,
                        colorHex = null,
                        who = "${c.personName ?: "Someone"} finished",
                        what = "${c.emoji ?: "🧹"} ${c.choreTitle}",
                        coin = if (c.rewardAmount > 0) "${c.rewardAmount}${currencySymbol(c.rewardCurrency)}" else null,
                        denyLabel = "Not yet",
                        trailing = proofThumb?.let { thumb -> { thumb(c) } },
                        onDeny = { coroutines.launch { model.decideChore(c.id, approve = false) } },
                        onApprove = { coroutines.launch { model.decideChore(c.id, approve = true) } },
                    )
                }
            }
        }
    }
}

@Composable
private fun ApprovalRow(
    avatarEmoji: String?,
    colorHex: String?,
    who: String,
    what: String,
    coin: String?,
    denyLabel: String,
    onDeny: () -> Unit,
    onApprove: () -> Unit,
    trailing: (@Composable () -> Unit)? = null,
) {
    WaffledCard(padding = 14.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                AvatarFromHex(colorHex, avatarEmoji ?: "🙂", size = 36.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(who, style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            what,
                            modifier = Modifier.weight(1f, fill = false),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink,
                        )
                        if (coin != null) {
                            Text(
                                coin,
                                modifier = Modifier
                                    .background(WF.colors.gold.copy(alpha = 0.14f), RoundedCornerShape(WF.radius.pill))
                                    .padding(horizontal = 7.dp, vertical = 2.dp),
                                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Black),
                                color = WF.colors.gold,
                            )
                        }
                    }
                }
                trailing?.invoke()
            }
            ApprovalActionPair(denyLabel = denyLabel, isKiosk = false, onDeny = onDeny, onApprove = onApprove)
        }
    }
}

package app.waffled.feature.rewards

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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.NotificationsActive
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.DisclosureChevron
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.model.Person
import kotlinx.coroutines.launch

/**
 * The Rewards tab — the phone port of iOS `RewardsView`.
 *
 * The tab **is** the shop: a person-tab strip on top (like the calendar filters), the
 * selected person's shop below, and the parent actions in the header — approvals, spot
 * awards, and catalog management, each behind its own capability.
 *
 * Rewards is a **sub-flag of chores**, not a module of its own: the caller must have
 * checked [RewardsAccess.isVisible] before routing here. That gate needs both the chores
 * module and the household's `chores.rewards` flag.
 *
 * **Scope:** phone layout only — the kiosk header and the pushed (non-embedded) shop are
 * a later phase.
 */
@Composable
fun RewardsScreen(
    model: RewardsModel,
    /** The signed-in person — the source of every capability gate on this screen. */
    me: Person?,
    modifier: Modifier = Modifier,
) {
    val snapshot by model.state.collectAsStateWithLifecycle()
    val loading by model.loadingState.collectAsStateWithLifecycle()
    val failed by model.errorState.collectAsStateWithLifecycle()

    val economy = snapshot.value ?: RewardsEconomy()
    val people = economy.people

    var activePersonId by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<EditorTarget?>(null) }
    var showAward by remember { mutableStateOf(false) }
    var showManage by remember { mutableStateOf(false) }
    var showApprovals by remember { mutableStateOf(false) }

    // The three gates are INDEPENDENT: a person granted only `reward.approve` gets the
    // approvals bell and nothing else. `isAdmin` implies all three (see `Person.can`).
    val canManage = RewardsAccess.canManage(me)
    val canApprove = RewardsAccess.canApprove(me)
    val canGrant = RewardsAccess.canGrant(me)

    // Whoever was selected may have left the household between loads. Derived rather
    // than assigned, so this never writes state mid-composition.
    val activePerson = activePersonId?.takeIf { id -> people.any { it.personId == id } }
        ?: people.firstOrNull()?.personId

    LaunchedEffect(Unit) {
        if (!model.loaded) model.load()
    }

    Column(
        modifier
            .fillMaxSize()
            .background(WF.colors.canvas),
    ) {
        RewardsHeader(
            pendingCount = economy.pending.size,
            canApprove = canApprove,
            canGrant = canGrant && people.isNotEmpty(),
            canManage = canManage,
            onApprovals = { showApprovals = true },
            onAward = { showAward = true },
            onManage = { showManage = true },
        )

        if (people.isNotEmpty()) {
            PersonTabs(
                people = people,
                selectedId = activePerson,
                onSelect = { activePersonId = it },
            )
            Box(Modifier.fillMaxWidth().height(1.dp).background(WF.colors.hair))
        }

        when {
            activePerson != null -> RewardShopScreen(
                personId = activePerson,
                model = model,
                canManage = canManage,
                maySpend = RewardsAccess.maySpend(me, walletOwnerId = activePerson),
                onEdit = { editing = EditorTarget.Edit(it) },
            )

            loading && !model.loaded -> WaffledLoading(top = 60.dp)

            else -> WaffledEmptyState(
                emoji = if (failed) "😕" else "🎁",
                title = if (failed) "Couldn’t load rewards" else "No family members yet",
                message = if (failed) {
                    "Pull down on the shop to try again."
                } else {
                    "Add someone in Settings to start earning."
                },
            )
        }
    }

    editing?.let { target ->
        RewardEditorSheet(
            editing = (target as? EditorTarget.Edit)?.reward,
            currencies = model.spendableCurrencies,
            model = model,
            onDismiss = { editing = null },
        )
    }

    if (showAward) {
        AwardStarsPickerSheet(
            people = people,
            currencies = economy.currencies,
            model = model,
            onDismiss = { showAward = false },
        )
    }

    if (showManage) {
        ManageRewardsSheet(
            model = model,
            onAdd = { showManage = false; editing = EditorTarget.New },
            onEdit = { showManage = false; editing = EditorTarget.Edit(it) },
            onDismiss = { showManage = false },
        )
    }

    if (showApprovals) {
        ApprovalsSheet(
            model = model,
            onDismiss = { showApprovals = false },
        )
    }
}

/** What the editor sheet is doing. */
private sealed interface EditorTarget {
    data object New : EditorTarget
    data class Edit(val reward: RewardsApi.Reward) : EditorTarget
}

/** Title plus the three capability-gated actions. */
@Composable
private fun RewardsHeader(
    pendingCount: Int,
    canApprove: Boolean,
    canGrant: Boolean,
    canManage: Boolean,
    onApprovals: () -> Unit,
    onAward: () -> Unit,
    onManage: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "Rewards",
            modifier = Modifier.weight(1f),
            style = WF.type.hero,
            color = WF.colors.ink,
        )
        // An approver with an empty queue gets no bell — a badge-less bell that opens an
        // empty sheet is the kind of dead control this repo has audited out before.
        if (canApprove && pendingCount > 0) {
            Box(Modifier.clickable(onClick = onApprovals).padding(8.dp)) {
                Icon(
                    imageVector = Icons.Filled.NotificationsActive,
                    contentDescription = "$pendingCount waiting for approval",
                    tint = WF.colors.ink2,
                    modifier = Modifier.size(22.dp),
                )
                WaffledStatusBadge(
                    text = "$pendingCount",
                    color = WF.colors.primary,
                    modifier = Modifier.align(Alignment.TopEnd),
                    size = 10.sp,
                    weight = FontWeight.Black,
                )
            }
        }
        if (canGrant) {
            Icon(
                imageVector = Icons.Filled.Star,
                contentDescription = "Award stars",
                tint = WF.colors.gold,
                modifier = Modifier
                    .clickable(onClick = onAward)
                    .padding(8.dp)
                    .size(22.dp),
            )
        }
        if (canManage) {
            Icon(
                imageVector = Icons.Filled.Tune,
                contentDescription = "Manage rewards",
                tint = WF.colors.ink2,
                modifier = Modifier
                    .clickable(onClick = onManage)
                    .padding(8.dp)
                    .size(22.dp),
            )
        }
    }
}

/** The person-tab strip — pick whose shop the tab is showing. */
@Composable
private fun PersonTabs(
    people: List<RewardsApi.PersonBalance>,
    selectedId: String?,
    onSelect: (String) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        people.forEach { p ->
            PersonChip(
                person = p,
                selected = p.personId == selectedId,
                onClick = { onSelect(p.personId) },
            )
        }
    }
}

/**
 * The catalog manager — add, edit and restore rewards. `reward.manage` only.
 *
 * The archived section only appears for someone who can actually restore from it, and
 * only when the (manage-gated) archived fetch returned something.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ManageRewardsSheet(
    model: RewardsModel,
    onAdd: () -> Unit,
    onEdit: (RewardsApi.Reward) -> Unit,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val economy = model.economy
    var showArchived by remember { mutableStateOf(false) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "Manage rewards",
                    modifier = Modifier.weight(1f),
                    style = WF.type.serif(22.sp, FontWeight.Bold),
                    color = WF.colors.ink,
                )
                TextButton(onClick = onAdd) {
                    Icon(
                        imageVector = Icons.Filled.Add,
                        contentDescription = null,
                        tint = WF.colors.primary,
                        modifier = Modifier.size(14.dp),
                    )
                    Spacer(Modifier.size(4.dp))
                    Text("Add", style = WF.type.label, color = WF.colors.primary)
                }
            }

            SectionLabel(text = "Rewards")

            if (economy.rewards.isEmpty()) {
                Text(
                    text = "No rewards yet — tap Add to create one.",
                    modifier = Modifier.padding(vertical = 8.dp),
                    style = WF.type.bodySmall,
                    color = WF.colors.ink3,
                )
            } else {
                economy.rewards.forEach { reward ->
                    CatalogRow(
                        reward = reward,
                        symbol = model.symbol(reward.currency),
                        colorHex = model.currency(reward.currency)?.color,
                        onClick = { onEdit(reward) },
                    )
                }
            }

            if (economy.archived.isNotEmpty()) {
                Row(
                    Modifier
                        .clickable { showArchived = !showArchived }
                        .padding(top = 2.dp, bottom = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    DisclosureChevron(isOpen = showArchived)
                    Text(
                        text = "Archived (${economy.archived.size})",
                        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                }
                if (showArchived) {
                    economy.archived.forEach { reward ->
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            WaffledEmojiTile(
                                emoji = reward.emoji ?: "🎁",
                                size = 18.dp,
                                frame = 34.dp,
                                cornerRadius = 9.dp,
                                emojiAlpha = 0.6f,
                            )
                            Text(
                                text = reward.title,
                                modifier = Modifier.weight(1f),
                                style = TextStyle(fontSize = 14.sp),
                                color = WF.colors.ink2,
                                maxLines = 1,
                            )
                            Text(
                                text = "Restore",
                                modifier = Modifier.clickable {
                                    scope.launch { model.restoreReward(reward.id) }
                                },
                                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                                color = WF.colors.ai,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CatalogRow(
    reward: RewardsApi.Reward,
    symbol: String,
    colorHex: String?,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WaffledEmojiTile(emoji = reward.emoji ?: "🎁")
        Text(
            text = reward.title,
            modifier = Modifier.weight(1f),
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink,
            maxLines = 1,
        )
        CoinChip(symbol = symbol, colorHex = colorHex, amount = reward.cost)
    }
}

/**
 * The approvals queue — every pending redemption, with Deny/Approve.
 *
 * `isKiosk = false`: this is the phone layout, so [app.waffled.core.design.ApprovalActionPair]
 * draws its full-width pair rather than the tablet's inline capsules.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ApprovalsSheet(
    model: RewardsModel,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val pending = model.economy.pending

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Needs your OK",
                    style = WF.type.serif(22.sp, FontWeight.Bold),
                    color = WF.colors.ink,
                )
                if (pending.isNotEmpty()) {
                    WaffledStatusBadge(
                        text = "${pending.size}",
                        color = WF.colors.primary,
                        size = 12.sp,
                        weight = FontWeight.Black,
                    )
                }
            }

            if (pending.isEmpty()) {
                WaffledEmptyState(
                    emoji = "✅",
                    title = "All caught up",
                    message = "No reward requests are waiting.",
                    top = 24.dp,
                )
            } else {
                WaffledCard(padding = 14.dp) {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        pending.forEachIndexed { index, redemption ->
                            if (index > 0) RewardsDivider()
                            ApprovalRow(
                                redemption = redemption,
                                symbol = model.symbol(redemption.currency),
                                colorHex = model.currency(redemption.currency)?.color,
                                onDeny = { scope.launch { model.deny(redemption.id) } },
                                onApprove = { scope.launch { model.approve(redemption.id) } },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ApprovalRow(
    redemption: RewardsApi.RewardRedemption,
    symbol: String,
    colorHex: String?,
    onDeny: () -> Unit,
    onApprove: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AvatarFromHex(
                colorHex = redemption.personColor,
                emoji = redemption.personAvatar ?: "🙂",
                size = 36.dp,
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = "${redemption.personName ?: "Someone"} wants",
                    style = TextStyle(fontSize = 12.5.sp),
                    color = WF.colors.ink3,
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "${redemption.emoji ?: "🎁"} ${redemption.title}",
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink,
                        maxLines = 1,
                    )
                    CoinChip(symbol = symbol, colorHex = colorHex, amount = redemption.cost)
                }
            }
        }
        app.waffled.core.design.ApprovalActionPair(
            denyLabel = "Deny",
            isKiosk = false,
            onDeny = onDeny,
            onApprove = onApprove,
        )
    }
}

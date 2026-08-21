package app.waffled.feature.rewards

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridItemSpanScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Star
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.wfShadow1
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * One person's reward shop — their wallet, what they're saving toward, and the catalog
 * they can redeem from, grouped by category.
 *
 * Every number on this screen comes from the same one ledger: the wallet balance, the
 * jar's fill, each tile's "N more to unlock". They are four presentations, not four
 * balances — which is why nothing here does its own bookkeeping and the only arithmetic
 * is [RewardsMath] over what the server sent.
 *
 * **Scope:** phone layout only. The `embedded` iPad/kiosk variant is a later phase.
 */
@Composable
fun RewardShopScreen(
    personId: String,
    model: RewardsModel,
    canManage: Boolean,
    onEdit: (RewardsApi.Reward) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()

    var overview by remember(personId) { mutableStateOf<RewardsApi.PersonRewardOverview?>(null) }
    var category by remember(personId) { mutableStateOf<String?>(null) }
    var redeemFor by remember { mutableStateOf<RewardsApi.Reward?>(null) }
    var celebration by remember { mutableStateOf<Celebrated?>(null) }
    var showSavingPicker by remember { mutableStateOf(false) }
    var giving by remember { mutableStateOf(false) }

    val economy = model.economy
    val rewards = economy.rewards

    // The saving-toward pin lives on a per-person endpoint the model doesn't own, so it
    // is refetched when the person changes and once per write. Keying on the ECONOMY
    // instead would double-fetch on every write AND skip the refetch when a write's
    // reload failed — stale in exactly the case that matters. See `RewardsModel.revision`.
    val revision by model.revision.collectAsStateWithLifecycle()
    LaunchedEffect(personId, revision) {
        // Best-effort: the shop is perfectly usable without the pin, so a failure here
        // must not blank the catalog.
        overview = runCatching { model.api.personOverview(personId) }.getOrNull()
    }

    val saving = overview?.savingToward
    val walletKey = saving?.currency ?: model.defaultCurrencyKey
    val walletCurrency = model.currency(walletKey)

    /** Categories that actually hold a reward — only those earn a filter chip. */
    val presentCategories = remember(rewards) {
        val used = rewards.map { ShopCategory.of(it.category) }.toSet()
        ShopCategory.entries.filter { it in used }
    }
    // A chip whose category emptied out must not keep filtering. Derived, not assigned,
    // so this never writes state mid-composition.
    val activeCategory = category?.takeIf { key -> presentCategories.any { it.key == key } }
    val sections = remember(rewards, activeCategory) {
        presentCategories
            .filter { activeCategory == null || it.key == activeCategory }
            .map { cat -> cat to rewards.filter { ShopCategory.of(it.category) == cat } }
            .filter { it.second.isNotEmpty() }
    }

    LazyVerticalGrid(
        columns = GridCells.Fixed(2),
        modifier = modifier
            .fillMaxSize()
            .background(WF.colors.canvas),
        contentPadding = PaddingValues(
            start = 16.dp,
            end = 16.dp,
            top = 12.dp,
            // Content scrolls UNDER the tab bar.
            bottom = WF.spacing.tabBarClearance,
        ),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item(span = { FullRow }) {
            WalletHero(
                name = model.person(personId)?.name,
                symbol = walletCurrency?.symbol?.takeIf { it.isNotBlank() } ?: "⭐",
                label = walletCurrency?.label?.takeIf { it.isNotBlank() } ?: "Stars",
                balance = model.balance(personId, walletKey),
            )
        }

        item(span = { FullRow }) {
            SavingTowardCard(
                saving = saving,
                colorHex = walletCurrency?.color,
                symbol = walletCurrency?.symbol?.takeIf { it.isNotBlank() } ?: "⭐",
                // Anyone may choose their own target — the pin is a personal nudge, not
                // a catalog edit, so it is not gated on `reward.manage`.
                canPick = rewards.isNotEmpty(),
                onChange = { showSavingPicker = true },
                onRedeem = {
                    // Route the hero's Redeem through the same confirm sheet a tile uses,
                    // so the debit is always shown before it happens.
                    redeemFor = rewards.firstOrNull { it.id == saving?.id }
                },
            )
        }

        if (presentCategories.size > 1) {
            item(span = { FullRow }) {
                CategoryChips(
                    categories = presentCategories,
                    selected = activeCategory,
                    onSelect = { category = it },
                )
            }
        }

        when {
            rewards.isEmpty() && !model.loaded ->
                item(span = { FullRow }) { WaffledLoading(top = 48.dp) }

            rewards.isEmpty() -> item(span = { FullRow }) {
                Text(
                    text = "No rewards yet — a parent can add them.",
                    modifier = Modifier.fillMaxWidth().padding(vertical = 30.dp),
                    style = WF.type.body,
                    color = WF.colors.ink3,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }

            else -> sections.forEach { (cat, items) ->
                item(span = { FullRow }) {
                    SectionHeader(
                        category = cat,
                        canGet = items.count {
                            RewardsMath.canAfford(model.balance(personId, it.currency), it.cost)
                        },
                    )
                }
                items(items, key = { it.id }) { reward ->
                    RewardTile(
                        reward = reward,
                        category = cat,
                        symbol = model.symbol(reward.currency),
                        balance = model.balance(personId, reward.currency),
                        canManage = canManage,
                        busy = giving,
                        onRedeem = { redeemFor = reward },
                        onEdit = { onEdit(reward) },
                    )
                }
            }
        }
    }

    redeemFor?.let { reward ->
        RedeemShopSheet(
            reward = reward,
            currency = model.currency(reward.currency),
            balance = model.balance(personId, reward.currency),
            busy = giving,
            onDismiss = { redeemFor = null },
            onConfirm = {
                scope.launch {
                    giving = true
                    // Captured BEFORE the write, so the celebration's "13 → 3" line is
                    // still true once the reload has landed.
                    val before = model.balance(personId, reward.currency)
                    val ok = model.redeem(rewardId = reward.id, personId = personId)
                    giving = false
                    redeemFor = null
                    if (ok) {
                        // Let the confirm sheet finish dismissing before the celebration
                        // takes the screen; two sheets mid-transition fight each other.
                        delay(350)
                        celebration = Celebrated(reward, reward.requiresApproval, before)
                    }
                }
            },
        )
    }

    celebration?.let { c ->
        ShopCelebrationView(
            reward = c.reward,
            currency = model.currency(c.reward.currency),
            balanceBefore = c.balanceBefore,
            pending = c.pending,
            onClose = { celebration = null },
        )
    }

    if (showSavingPicker) {
        SavingTowardPickerSheet(
            options = overview?.rewardShop.orEmpty(),
            currentId = saving?.id,
            symbolFor = model::symbol,
            onPick = { rewardId ->
                showSavingPicker = false
                scope.launch { model.setSavingToward(personId = personId, rewardId = rewardId) }
            },
            onDismiss = { showSavingPicker = false },
        )
    }
}

/** What the celebration needs after the write has already changed the balance. */
private data class Celebrated(
    val reward: RewardsApi.Reward,
    val pending: Boolean,
    val balanceBefore: Int,
)

/**
 * The wallet hero — this person's balance in the currency they're saving in.
 *
 * The violet gradient replaces iOS's literal `Color(light: 0x9169EA, dark: 0x6E56CF)`
 * pair with `ai2 → ai`, which deepens in both themes (light 0xA48CF0 → 0x8C74E8, dark
 * 0x8C74E8 → 0x6E56CF) and so needs no platform-only colour. White text is correct on a
 * saturated coloured fill — this is not an `ink` surface.
 */
@Composable
private fun WalletHero(name: String?, symbol: String, label: String, balance: Int) {
    val onHero = WF.colors.onMedia
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(WF.radius.lg))
            .background(Brush.linearGradient(listOf(WF.colors.ai2, WF.colors.ai)))
            .padding(18.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(56.dp)
                .clip(RoundedCornerShape(WF.radius.pill))
                .background(onHero.copy(alpha = 0.22f)),
            contentAlignment = Alignment.Center,
        ) {
            Text(text = symbol, style = TextStyle(fontSize = 26.sp))
        }
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                text = "${(name ?: "My").uppercase()}’S ${label.uppercase()}",
                style = TextStyle(
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Black,
                    letterSpacing = 0.5.sp,
                ),
                color = onHero.copy(alpha = 0.85f),
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                Text(
                    text = "$balance",
                    style = TextStyle(fontSize = 34.sp, fontWeight = FontWeight.Black),
                    color = onHero,
                )
                Text(
                    text = symbol,
                    modifier = Modifier.padding(bottom = 4.dp),
                    style = TextStyle(fontSize = 18.sp),
                    color = onHero.copy(alpha = 0.9f),
                )
            }
        }
    }
}

/** The horizontal category filter. */
@Composable
private fun CategoryChips(
    categories: List<ShopCategory>,
    selected: String?,
    onSelect: (String?) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SelectableChip(label = "All", selected = selected == null) { onSelect(null) }
        categories.forEach { cat ->
            SelectableChip(
                label = "${cat.emoji} ${cat.label}",
                selected = selected == cat.key,
            ) { onSelect(cat.key) }
        }
    }
}

/**
 * A filter chip that fills with `ink` when on.
 *
 * Not `wfChip`: that modifier's selected state is a 12% *tint* wash, and these filters
 * are the app's high-contrast ink-fill family (matching the person tabs and iOS's shop
 * chips). Text on the fill is `onInk`, never white.
 */
@Composable
internal fun SelectableChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Text(
        text = label,
        modifier = Modifier
            .background(if (selected) WF.colors.ink else WF.colors.card, shape)
            .then(if (selected) Modifier else Modifier.border(1.dp, WF.colors.hair, shape))
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
        color = if (selected) WF.colors.onInk else WF.colors.ink,
    )
}

@Composable
private fun SectionHeader(category: ShopCategory, canGet: Int) {
    Row(
        Modifier.fillMaxWidth().padding(top = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "${category.emoji} ${category.label}",
            style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ink,
        )
        Spacer(Modifier.weight(1f))
        Text(
            text = "$canGet you can get",
            style = WF.type.bodySmall,
            color = WF.colors.ink3,
        )
    }
}

/**
 * One reward tile: a category-coloured thumb, the price, and either a Get it button or
 * how much further there is to go.
 *
 * All three numbers are the same balance seen three ways — affordability, the bar's
 * fill, and the shortfall — so they are all [RewardsMath] over one integer.
 */
@Composable
private fun RewardTile(
    reward: RewardsApi.Reward,
    category: ShopCategory,
    symbol: String,
    balance: Int,
    canManage: Boolean,
    busy: Boolean,
    onRedeem: () -> Unit,
    onEdit: () -> Unit,
) {
    val can = RewardsMath.canAfford(have = balance, cost = reward.cost)
    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        modifier = Modifier
            .clip(shape)
            .background(WF.colors.card)
            .border(1.dp, WF.colors.hair, shape)
            .wfShadow1(shape),
    ) {
        Box(Modifier.fillMaxWidth().height(92.dp)) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(if (can) category.gradient else Brush.linearGradient(listOf(WF.colors.panel, WF.colors.panel))),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = reward.emoji ?: "🎁",
                    // Emoji are colour glyphs, so an unaffordable one is faded rather
                    // than tinted — a text colour would simply be ignored.
                    modifier = Modifier.then(
                        if (can) Modifier else Modifier.alpha(0.55f),
                    ),
                    style = TextStyle(fontSize = 38.sp),
                )
            }
            if (!can) {
                Text(
                    text = "🔒",
                    modifier = Modifier.align(Alignment.TopStart).padding(7.dp),
                    style = TextStyle(fontSize = 14.sp),
                )
            }
            Row(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(7.dp)
                    .background(WF.colors.card, RoundedCornerShape(WF.radius.pill))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // iOS hardcodes a white price pill here. A `card` fill reads the same in
                // light and stays legible in dark (where `card` is the lighter surface),
                // so `ink` on `card` works over either category gradient without a
                // platform-only colour.
                Text(text = symbol, style = TextStyle(fontSize = 11.sp))
                Text(
                    text = "${reward.cost}",
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Black),
                    color = WF.colors.ink,
                )
            }
            if (canManage) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(6.dp)
                        .size(28.dp)
                        .clip(RoundedCornerShape(WF.radius.pill))
                        .background(WF.colors.card.copy(alpha = 0.92f))
                        .clickable(onClick = onEdit),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Edit,
                        contentDescription = "Edit ${reward.title}",
                        tint = WF.colors.ink2,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }

        Column(
            Modifier.padding(11.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Text(
                text = reward.title,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
                maxLines = 1,
            )
            Text(
                text = category.label.uppercase(),
                style = TextStyle(
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Black,
                    letterSpacing = 0.5.sp,
                ),
                color = WF.colors.ink3,
            )
            if (can) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(WF.colors.primary, RoundedCornerShape(WF.radius.pill))
                        .clip(RoundedCornerShape(WF.radius.pill))
                        .clickable(enabled = !busy, onClick = onRedeem)
                        .padding(vertical = 9.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Star,
                        contentDescription = null,
                        // A saturated coloured fill: white is the correct foreground.
                        tint = androidx.compose.ui.graphics.Color.White,
                        modifier = Modifier.size(13.dp),
                    )
                    Spacer(Modifier.size(4.dp))
                    Text(
                        text = "Get it",
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                        color = androidx.compose.ui.graphics.Color.White,
                    )
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(6.dp)
                            .clip(RoundedCornerShape(WF.radius.pill))
                            .background(WF.colors.panel),
                    ) {
                        Box(
                            Modifier
                                .fillMaxWidth(RewardsMath.progressFraction(balance, reward.cost))
                                .height(6.dp)
                                .background(WF.colors.primary),
                        )
                    }
                    Text(
                        text = "${RewardsMath.toGo(balance, reward.cost)} more to unlock",
                        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                }
            }
        }
    }
}

private val LazyGridItemSpanScope.FullRow: GridItemSpan
    get() = GridItemSpan(maxLineSpan)

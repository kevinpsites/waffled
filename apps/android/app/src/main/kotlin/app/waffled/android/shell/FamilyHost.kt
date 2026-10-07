package app.waffled.android.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.android.AppContainer
import app.waffled.core.design.WF
import app.waffled.core.model.WaffledModule
import app.waffled.core.network.WaffledJson
import app.waffled.feature.bites.WaffledBiteEntryCard
import app.waffled.feature.family.ApprovalsScreen
import app.waffled.feature.family.FamilyHubGates
import app.waffled.feature.family.FamilyScreen
import app.waffled.feature.family.PersonOverviewModel
import app.waffled.feature.family.PersonScreen
import app.waffled.feature.family.PersonSpotlightSlots
import app.waffled.feature.family.SyncStatusSheet
import app.waffled.feature.goals.goalCategoryColor
import app.waffled.feature.rewards.AwardStarsPickerSheet
import app.waffled.feature.rewards.RewardsAccess
import app.waffled.feature.rewards.RewardsApi
import app.waffled.feature.rewards.SavingTowardCard
import app.waffled.feature.rewards.SavingTowardPickerSheet
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.time.LocalDate

/** The Family tab root — the iOS `FamilyView` hub. Every tile pushes on this tab's stack. */
@Composable
fun FamilyTab(container: AppContainer, actions: ShellActions, modifier: Modifier = Modifier) {
    val sync = container.syncManager
    val modules by sync.modules.collectAsStateWithLifecycle()
    val members by sync.members.collectAsStateWithLifecycle()
    val syncState by sync.state.collectAsStateWithLifecycle()
    val events by sync.visibleEvents.collectAsStateWithLifecycle()
    val viewer by container.identity.viewer.collectAsStateWithLifecycle()
    val rewardsSub by container.identity.rewardsEnabled.collectAsStateWithLifecycle()
    val scope by container.sessionScope.collectAsStateWithLifecycle()
    var showSync by rememberSaveable { mutableStateOf(false) }

    FamilyScreen(
        hub = container.familyHub,
        approvals = container.approvals,
        gates = familyGates(modules, rewardsSub),
        members = members,
        me = viewer,
        syncState = syncState,
        scope = scope,
        onOpen = { hub -> actions.push(AppRoute.fromHub(hub)) },
        onOpenSync = { showSync = true },
        modifier = modifier,
        refreshBus = container.refreshBus,
    )

    if (showSync) {
        SyncStatusSheet(
            state = syncState,
            members = members,
            eventCount = events.size,
            onDismiss = { showSync = false },
        )
    }
}

internal fun familyGates(modules: app.waffled.core.sync.ModuleGate, rewardsSub: Boolean) = FamilyHubGates(
    chores = modules.isOn(WaffledModule.Chores),
    goals = modules.isOn(WaffledModule.Goals),
    rewards = modules.rewardsOn(rewardsSub),
    lists = modules.isOn(WaffledModule.Lists),
    pantry = modules.isOn(WaffledModule.Pantry),
    rhythms = modules.isOn(WaffledModule.Rhythms),
    weeklyPlanning = modules.isOn(WaffledModule.WeeklyPlanning),
)

@Composable
fun ApprovalsHost(container: AppContainer, modifier: Modifier = Modifier) {
    val modules by container.syncManager.modules.collectAsStateWithLifecycle()
    val viewer by container.identity.viewer.collectAsStateWithLifecycle()
    val rewardsSub by container.identity.rewardsEnabled.collectAsStateWithLifecycle()
    val scope by container.sessionScope.collectAsStateWithLifecycle()
    val economy by container.rewardsModel.state.collectAsStateWithLifecycle()
    val currencies = economy.value?.currencies.orEmpty()
    ApprovalsScreen(
        model = container.approvals,
        me = viewer,
        choresEnabled = modules.isOn(WaffledModule.Chores),
        rewardsEnabled = modules.rewardsOn(rewardsSub),
        scope = scope,
        currencySymbol = { key -> currencySymbol(currencies, key) },
        modifier = modifier,
    )
}

private fun currencySymbol(currencies: List<RewardsApi.Currency>, key: String?): String {
    val c = currencies.firstOrNull { it.key == key } ?: currencies.firstOrNull { it.isDefault }
    return c?.symbol?.takeIf { it.isNotBlank() } ?: "⭐"
}

/** One person's spotlight — iOS `PersonView`. */
@Composable
fun PersonHost(personId: String, container: AppContainer, actions: ShellActions, modifier: Modifier = Modifier) {
    val sync = container.syncManager
    val zone by sync.householdZone.collectAsStateWithLifecycle()
    val eventsByDay by sync.eventsByDay.collectAsStateWithLifecycle()
    val modules by sync.modules.collectAsStateWithLifecycle()
    val viewer by container.identity.viewer.collectAsStateWithLifecycle()
    val scope by container.sessionScope.collectAsStateWithLifecycle()
    val coroutines = rememberCoroutineScope()
    var awarding by remember { mutableStateOf(false) }

    val model = remember(personId, scope) {
        PersonOverviewModel.backedBy(
            personId = personId,
            api = container.familyApi,
            today = { LocalDate.now(sync.householdZone.value).toString() },
            refreshBus = container.refreshBus,
        )
    }
    val bitesOn = modules.isOn(WaffledModule.WaffledBites)

    PersonScreen(
        model = model,
        me = viewer,
        eventsByDay = eventsByDay,
        zone = zone,
        onOpen = { hub -> actions.push(AppRoute.fromHub(hub)) },
        onOpenEvent = { actions.openEvent(it.id) },
        onAdd = { actions.capture(false) },
        modifier = modifier,
        onAward = if (RewardsAccess.canGrant(viewer)) ({ awarding = true }) else null,
        slots = PersonSpotlightSlots(
            savingToward = { raw, canRedeem, onChanged ->
                SavingTowardSlot(container, personId, raw, canRedeem, onChanged) {
                    actions.push(AppRoute.RewardShop(personId))
                }
            },
            goalTint = { goalCategoryColor(it) },
            planningFocus = { PlanningFocusCard(it) },
            waffledBite = if (bitesOn) {
                { id, firstName ->
                    WaffledBiteEntryCard(
                        api = container.bitesApi,
                        personId = id,
                        firstName = firstName,
                        onOpenControls = { actions.push(AppRoute.WaffledBites(id, firstName)) },
                    )
                }
            } else {
                null
            },
        ),
    )

    if (awarding) {
        val economy by container.rewardsModel.state.collectAsStateWithLifecycle()
        val e = economy.value
        LaunchedEffect(Unit) { if (e == null) container.rewardsModel.load() }
        if (e != null) {
            // The sheet picks its recipient from [people]; offering only this person
            // pre-selects them, which is what an Award tap on their spotlight means.
            val people = e.people.filter { it.personId == personId }.ifEmpty { e.people }
            AwardStarsPickerSheet(
                people = people,
                currencies = e.currencies,
                model = container.rewardsModel,
                onDismiss = {
                    awarding = false
                    coroutines.launch { model.load() }
                },
            )
        }
    }
}

/** The Rewards module's saving-toward card, fed from the spotlight's raw `/overview`. */
@Composable
private fun SavingTowardSlot(
    container: AppContainer,
    personId: String,
    raw: JsonObject,
    canRedeem: Boolean,
    onChanged: () -> Unit,
    onOpenShop: () -> Unit,
) {
    val overview = remember(raw) {
        runCatching { WaffledJson.decodeFromJsonElement(RewardsApi.PersonRewardOverview.serializer(), raw) }.getOrNull()
    } ?: return
    val coroutines = rememberCoroutineScope()
    var picking by remember { mutableStateOf(false) }
    val saving = overview.savingToward
    val currency = overview.currencies.firstOrNull { it.key == saving?.currency }
        ?: overview.currencies.firstOrNull { it.isDefault }
    val symbolFor = { key: String ->
        overview.currencies.firstOrNull { it.key == key }?.symbol?.takeIf { it.isNotBlank() } ?: "⭐"
    }

    SavingTowardCard(
        saving = saving,
        colorHex = currency?.color,
        symbol = currency?.symbol?.takeIf { it.isNotBlank() } ?: "⭐",
        canPick = canRedeem,
        canRedeem = canRedeem,
        onChange = { picking = true },
        // Redeem goes through the shop's confirm sheet rather than spending on one tap.
        onRedeem = onOpenShop,
    )

    if (picking) {
        SavingTowardPickerSheet(
            options = overview.rewardShop,
            currentId = saving?.id,
            symbolFor = symbolFor,
            onPick = { id ->
                picking = false
                coroutines.launch {
                    container.rewardsModel.setSavingToward(personId, id)
                    onChanged()
                }
            },
            onDismiss = { picking = false },
        )
    }
}

/**
 * A pushed page whose screen draws no header: the shell's back row above a BOUNDED slot.
 * The slot is weighted, never scrolled — these screens scroll themselves, and a scrolling
 * parent would hand them infinite height.
 */
@Composable
fun PageWithBack(
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    title: String? = null,
    content: @Composable () -> Unit,
) {
    Column(modifier.fillMaxSize().background(WF.colors.canvas)) {
        BackRow(onBack = onBack, title = title)
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
    }
}

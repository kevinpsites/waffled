package app.waffled.feature.today

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.rememberCoroutineScope
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AICaptureBar
import app.waffled.core.design.Avatar
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.FamilyColor
import app.waffled.core.design.WF
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledModule
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RestNotice
import app.waffled.core.network.RestState
import app.waffled.core.sync.ModuleGate
import app.waffled.core.sync.SyncedEvent
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Today — the phone home surface. The port of `apps/ios/.../Features/Today/TodayView.swift`.
 *
 * Greeting + capture bar pinned at the top; the cards scroll under them (and under the tab
 * bar, hence [WF.spacing.tabBarClearance]).
 *
 * **The card set is server-driven and user-customisable**, so which cards render, in what
 * order, and which pair up all come from [TodayLayoutModel] via [TodayCards]. Cards owned
 * by other feature modules — countdowns, lists, pantry, Family Night, the goals hero — are
 * passed in as [cardContent]; a key with no content is skipped entirely rather than left as
 * a gap. Everything is module-gated: a card whose module is off never appears.
 *
 * ⚠️ This reads the **mobile** layout. The web keeps its own (3-column, reorder-only).
 *
 * Scope: phone only. The tablet `KioskDashboard` is a separate view tree.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodayScreen(
    dash: DashboardModel,
    layout: TodayLayoutModel,
    /** Already filtered per viewer and bucketed by local day — do NOT re-derive. */
    eventsByDay: Map<LocalDate, List<SyncedEvent>>,
    /** The HOUSEHOLD's zone, not the device's. */
    zone: ZoneId,
    modules: ModuleGate,
    members: List<Person>,
    currentPersonId: String?,
    modifier: Modifier = Modifier,
    /** Bumped by writes elsewhere in the app; Today re-fetches the affected cards. */
    refreshBus: RefreshBus? = null,
    /** Cards owned by other feature modules, by card key. Absent keys simply don't render. */
    cardContent: Map<String, @Composable () -> Unit> = emptyMap(),
    /** The parent-only "Needs your OK" banner — the family feature owns its model. */
    approvalsBanner: (@Composable () -> Unit)? = null,
    onCapture: () -> Unit = {},
    onDictate: () -> Unit = {},
    onOpenCalendar: () -> Unit = {},
    onOpenEvent: (SyncedEvent) -> Unit = {},
    onOpenPerson: (String) -> Unit = {},
    onOpenChores: () -> Unit = {},
    onOpenGrocery: () -> Unit = {},
    onOpenReviewEvents: () -> Unit = {},
    onOpenRecipe: (TonightRecipe) -> Unit = {},
    onCookRecipe: (TonightRecipe) -> Unit = {},
    onOpenMeal: (TonightMeal) -> Unit = {},
    onCookMeal: (TonightMeal) -> Unit = {},
) {
    val tonight by dash.tonightSnapshot.collectAsStateWithLifecycle()
    val chores by dash.choresSnapshot.collectAsStateWithLifecycle()
    val grocery by dash.grocerySnapshot.collectAsStateWithLifecycle()
    val goals by dash.goalsSnapshot.collectAsStateWithLifecycle()
    val recap by dash.recapSnapshot.collectAsStateWithLifecycle()
    val suggestions by dash.suggestionsSnapshot.collectAsStateWithLifecycle()
    val weather by dash.weatherSnapshot.collectAsStateWithLifecycle()
    val layoutState by layout.state.collectAsStateWithLifecycle()

    // "Today" in the household's zone, re-derived only when the zone changes or the day
    // rolls over — never inside a render pass.
    var today by remember(zone) { mutableStateOf(LocalDate.now(zone)) }

    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }

    suspend fun reload() {
        dash.load(today.toString())
        dash.loadGoals()
    }

    LaunchedEffect(zone) { layout.load() }
    LaunchedEffect(zone) { dash.loadWeather() }

    // The cards refetch on every return to the foreground, not just on first composition.
    // They are REST-backed, so a chore ticked on the web or another phone while this was
    // backgrounded arrives silently — nothing would ever tell us. `LifecycleResumeEffect`
    // also fires on the first RESUMED transition, so this IS the initial load; adding a
    // separate LaunchedEffect alongside it would just double-fetch on entry.
    LifecycleResumeEffect(zone, today) {
        val job = scope.launch { reload() }
        onPauseOrDispose { job.cancel() }
    }

    // Day rollover while the screen stays open: at (household-tz) midnight "today" changes,
    // so the dinner and chores on screen are suddenly yesterday's. Sleep to just past each
    // midnight and re-key; the agenda re-derives itself from the new day's lookup.
    LaunchedEffect(zone) {
        while (true) {
            kotlinx.coroutines.delay(millisUntilNextDay(ZonedDateTime.now(zone)))
            today = LocalDate.now(zone)
        }
    }

    // These cards are REST-backed, so a change made elsewhere — the web app, another phone,
    // another tab in this app — arrives silently. The bus is how a local write tells us.
    //
    // `RefreshBus.events` replays its last value, so entering Today after any earlier bump
    // costs one duplicate fetch. Left as-is deliberately: `drop(1)` would swallow the FIRST
    // genuine bump in a session that has had none, which is the worse failure.
    LaunchedEffect(refreshBus, zone) {
        refreshBus?.events?.collectLatest { domain ->
            if (DashboardModel.affectsDashboard(domain)) dash.load(today.toString())
            if (DashboardModel.affectsGoals(domain)) dash.loadGoals()
        }
    }

    var showCustomize by remember { mutableStateOf(false) }

    val rows = remember(layoutState, modules, cardContent.keys) {
        TodayCards.rows(
            order = layoutState.order,
            hidden = layoutState.hidden,
            modules = modules,
            // The four cards this module draws itself, plus whatever the host wired.
            available = setOf(
                TodayCards.AGENDA, TodayCards.TONIGHT, TodayCards.CHORES, TodayCards.GROCERY,
            ) + cardContent.keys,
        )
    }

    val greetingMember = remember(members, currentPersonId) {
        members.firstOrNull { it.id == currentPersonId }
            ?: members.firstOrNull { it.memberType == "adult" }
            ?: members.firstOrNull()
    }

    val todaysEvents = TodayFormat.eventsOn(eventsByDay, today)

    val actions = remember(
        onOpenCalendar, onOpenEvent, onOpenChores, onOpenGrocery,
        onOpenRecipe, onCookRecipe, onOpenMeal, onCookMeal, today,
    ) {
        TodayActions(
            onOpenCalendar, onOpenEvent, onOpenChores, onOpenGrocery,
            onOpenRecipe, onCookRecipe, onOpenMeal, onCookMeal,
            onRetryDashboard = { scope.launch { dash.load(today.toString()) } },
            onRetryGoals = { scope.launch { dash.loadGoals() } },
        )
    }

    Column(modifier.fillMaxSize().background(WF.colors.canvas)) {
        StickyHeader(
            member = greetingMember,
            weather = weather.value,
            zone = zone,
            onCapture = onCapture,
            onDictate = onDictate,
            onCustomize = { showCustomize = true },
            onOpenPerson = onOpenPerson,
        )

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch {
                    reload()
                    refreshing = false
                }
            },
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    start = 18.dp,
                    end = 18.dp,
                    top = 6.dp,
                    // Cards scroll UNDER the tab bar.
                    bottom = WF.spacing.tabBarClearance,
                ),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                // Parent-only "Needs your OK" — gated with chores, since nothing can be in
                // the chore/reward approval queues without it.
                if (approvalsBanner != null && modules.isOn(WaffledModule.Chores)) {
                    item(key = "approvals") { approvalsBanner() }
                }

                // The goal-recap review banner (the calendar-goal bridge) — gated with
                // goals so it can't surface for a disabled feature.
                val recapRows = recap.value.orEmpty()
                val suggestionRows = suggestions.value.orEmpty()
                val reviewState = RestState.combined(listOf(recap.rest, suggestions.rest))
                if (modules.isOn(WaffledModule.Goals) && RestNotice.of(reviewState) != null) {
                    item(key = "reviewNotice") {
                        RestStateNotice(reviewState, retry = actions.onRetryGoals)
                    }
                }
                if (modules.isOn(WaffledModule.Goals) &&
                    (recapRows.isNotEmpty() || suggestionRows.isNotEmpty())
                ) {
                    item(key = "review") {
                        ReviewEventsBanner(
                            recapTitles = recapRows.map { it.title },
                            suggestionTitles = suggestionRows.map { it.title },
                            onOpen = onOpenReviewEvents,
                        )
                    }
                }

                items(rows, key = { it.id }) { row ->
                    val cards = CardData(
                        tonightMeal = tonight.value?.firstOrNull(),
                        tonightState = tonight.rest,
                        chores = chores.value.orEmpty(),
                        choresState = chores.rest,
                        groceryRemaining = grocery.value ?: 0,
                        groceryState = grocery.rest,
                        goalsState = goals.rest,
                        events = todaysEvents,
                    )
                    when (row) {
                        is TodayCards.CardRow.Single ->
                            CardView(row.key, cards, zone, cardContent, actions)

                        is TodayCards.CardRow.Pair -> Row(
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            // Intrinsic height on the row plus fillMaxHeight on each card,
                            // so the shorter of the pair stretches instead of leaving the
                            // ragged edge iOS doesn't have.
                            modifier = Modifier.height(IntrinsicSize.Min),
                        ) {
                            listOf(row.first, row.second).forEach { key ->
                                CardView(
                                    key = key,
                                    cards = cards,
                                    zone = zone,
                                    cardContent = cardContent,
                                    actions = actions,
                                    modifier = Modifier.weight(1f).fillMaxHeight(),
                                    stretch = true,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (showCustomize) {
        CustomizeTodaySheet(
            order = layoutState.order,
            hidden = layoutState.hidden,
            canEditFamily = layoutState.canEditFamily,
            onDismiss = { showCustomize = false },
            onSave = { scope, order, hidden -> layout.save(scope, order, hidden) },
            onReset = { scope -> layout.reset(scope) },
        )
    }
}

/** Everything the four locally-owned cards render, gathered once per row. */
private data class CardData(
    val tonightMeal: TonightMeal?,
    val tonightState: RestState,
    val chores: List<TodayApi.PersonChores>,
    val choresState: RestState,
    val groceryRemaining: Int,
    val groceryState: RestState,
    val goalsState: RestState,
    val events: List<SyncedEvent>,
)

/** Every tap a card can make. Bundled so the dispatcher isn't a fifteen-argument function. */
class TodayActions(
    val onOpenCalendar: () -> Unit = {},
    val onOpenEvent: (SyncedEvent) -> Unit = {},
    val onOpenChores: () -> Unit = {},
    val onOpenGrocery: () -> Unit = {},
    val onOpenRecipe: (TonightRecipe) -> Unit = {},
    val onCookRecipe: (TonightRecipe) -> Unit = {},
    val onOpenMeal: (TonightMeal) -> Unit = {},
    val onCookMeal: (TonightMeal) -> Unit = {},
    val onRetryDashboard: () -> Unit = {},
    val onRetryGoals: () -> Unit = {},
)

/** Dispatch one card key to its content. An unknown or unwired key renders nothing. */
@Composable
private fun CardView(
    key: String,
    cards: CardData,
    zone: ZoneId,
    cardContent: Map<String, @Composable () -> Unit>,
    actions: TodayActions,
    modifier: Modifier = Modifier,
    /** In a 2-up pair: the card fills what its notice leaves, so the pair lines up. */
    stretch: Boolean = false,
) {
    when (key) {
        TodayCards.AGENDA -> AgendaCard(
            events = cards.events,
            zone = zone,
            onOpenCalendar = actions.onOpenCalendar,
            onOpenEvent = actions.onOpenEvent,
            modifier = modifier,
        )

        TodayCards.TONIGHT -> Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RestStateNotice(cards.tonightState, retry = actions.onRetryDashboard)
            TonightCard(
                meal = cards.tonightMeal,
                loaded = cards.tonightState.isAuthoritative,
                onOpenRecipe = actions.onOpenRecipe,
                onCookRecipe = actions.onCookRecipe,
                onOpenMeal = actions.onOpenMeal,
                onCookMeal = actions.onCookMeal,
            )
        }

        // The tallies are derived from the same list the avatars come from, so one snapshot
        // read drives the whole card — reading them off the model would recompose only by
        // luck of a sibling parameter changing.
        TodayCards.CHORES -> Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RestStateNotice(cards.choresState, retry = actions.onRetryDashboard, compact = true)
            ChoresCard(
                people = cards.chores,
                done = cards.chores.sumOf { it.done },
                total = cards.chores.sumOf { it.total },
                stars = cards.chores.sumOf { it.stars },
                state = cards.choresState,
                onOpen = actions.onOpenChores,
                modifier = if (stretch) Modifier.weight(1f) else Modifier,
            )
        }

        TodayCards.GROCERY -> Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RestStateNotice(cards.groceryState, retry = actions.onRetryDashboard, compact = true)
            GroceryCard(
                remaining = cards.groceryRemaining,
                state = cards.groceryState,
                onOpen = actions.onOpenGrocery,
                modifier = if (stretch) Modifier.weight(1f) else Modifier,
            )
        }

        // The goals hero belongs to the goals feature; Today owns the fetch, so the notice
        // about that fetch sits above whatever the host draws.
        TodayCards.GOALS -> cardContent[key]?.let { content ->
            Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                RestStateNotice(cards.goalsState, retry = actions.onRetryGoals)
                content()
            }
        }

        // Countdowns, lists, pantry and Family Night belong to other feature modules; the
        // host supplies them through `cardContent`.
        else -> cardContent[key]?.invoke()
    }
}

/**
 * The fixed top of Today: the greeting row and the capture bar, on an opaque canvas so the
 * cards scroll out of sight beneath them.
 */
@Composable
private fun StickyHeader(
    member: Person?,
    weather: TodayApi.Weather?,
    zone: ZoneId,
    onCapture: () -> Unit,
    onDictate: () -> Unit,
    onCustomize: () -> Unit,
    onOpenPerson: (String) -> Unit,
) {
    // Re-read the clock only when the zone changes; the strings are stable for the session
    // (and the rollover effect re-keys the screen at midnight anyway).
    val now = remember(zone) { Instant.now() }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(WF.colors.canvas)
            .statusBarsPadding()
            .padding(start = 18.dp, end = 18.dp, top = 8.dp, bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = TodayFormat.dateLine(now, zone),
                        style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink2,
                    )
                    TodayFormat.weatherChip(weather)?.let {
                        Text(
                            text = it,
                            style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink3,
                        )
                    }
                }
                Text(
                    text = TodayFormat.greeting(now, zone),
                    style = WF.type.serif(30.sp, FontWeight.Bold),
                    color = WF.colors.ink,
                )
            }

            Box(
                modifier = Modifier
                    .size(40.dp)
                    .background(WF.colors.panel, CircleShape)
                    .clip(CircleShape)
                    .clickable(onClick = onCustomize),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Filled.Tune,
                    contentDescription = "Customize Today",
                    tint = WF.colors.ink3,
                    modifier = Modifier.size(18.dp),
                )
            }

            if (member != null) {
                AvatarFromHex(
                    colorHex = member.colorHex,
                    emoji = member.displayEmoji,
                    size = 46.dp,
                    modifier = Modifier
                        .clip(CircleShape)
                        .clickable { onOpenPerson(member.id) },
                )
            } else {
                Avatar(person = FamilyColor.Person2, emoji = "🦊", size = 46.dp)
            }
        }

        // The Capture sheet itself is Wave C; the host decides what tapping this does.
        AICaptureBar(onTap = onCapture, onMic = onDictate)
    }

}

/** Milliseconds until just past the next local midnight. */
internal fun millisUntilNextDay(now: ZonedDateTime): Long {
    val nextMidnight = now.toLocalDate().plusDays(1).atStartOfDay(now.zone)
    // A second past, so the recomputed "today" can't land on the boundary itself.
    return java.time.Duration.between(now, nextMidnight).toMillis().coerceAtLeast(0) + 1_000
}

package app.waffled.feature.today

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AICaptureBar
import app.waffled.core.design.Avatar
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.FamilyColor
import app.waffled.core.design.WF
import app.waffled.core.model.Person
import app.waffled.core.network.RefreshBus
import app.waffled.core.sync.ModuleGate
import app.waffled.core.sync.SyncedEvent
import kotlinx.coroutines.flow.collectLatest
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
    val tonight by dash.tonightState.collectAsStateWithLifecycle()
    val chores by dash.choresState.collectAsStateWithLifecycle()
    val grocery by dash.groceryState.collectAsStateWithLifecycle()
    val recap by dash.recapState.collectAsStateWithLifecycle()
    val suggestions by dash.suggestionsState.collectAsStateWithLifecycle()
    val weather by dash.weatherState.collectAsStateWithLifecycle()
    val layoutState by layout.state.collectAsStateWithLifecycle()

    // "Today" in the household's zone, re-derived only when the zone changes or the day
    // rolls over — never inside a render pass.
    var today by remember(zone) { mutableStateOf(LocalDate.now(zone)) }

    LaunchedEffect(zone) { layout.load() }
    LaunchedEffect(zone) { dash.loadWeather() }
    LaunchedEffect(zone, today) { dash.load(today.toString()) }
    LaunchedEffect(zone) { dash.loadGoals() }

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

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = 18.dp,
                end = 18.dp,
                top = 6.dp,
                // Cards scroll UNDER the tab bar.
                bottom = WF.spacing.tabBarClearance,
            ),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // Parent-only "Needs your OK" — gated with chores, since nothing can be in the
            // chore/reward approval queues without it.
            if (approvalsBanner != null && modules.isOn(app.waffled.core.model.WaffledModule.Chores)) {
                item(key = "approvals") { approvalsBanner() }
            }

            // The goal-recap review banner (the calendar↔goal bridge) — gated with goals so
            // it can't surface for a disabled feature.
            val recapRows = recap.value.orEmpty()
            val suggestionRows = suggestions.value.orEmpty()
            if (modules.isOn(app.waffled.core.model.WaffledModule.Goals) &&
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
                when (row) {
                    is TodayCards.CardRow.Single -> CardView(
                        key = row.key,
                        dash = dash,
                        tonightLoaded = tonight.loaded,
                        tonightMeal = tonight.value?.firstOrNull(),
                        chores = chores.value.orEmpty(),
                        choresLoaded = chores.loaded,
                        groceryRemaining = grocery.value ?: 0,
                        groceryLoaded = grocery.loaded,
                        events = todaysEvents,
                        zone = zone,
                        cardContent = cardContent,
                        onOpenCalendar = onOpenCalendar,
                        onOpenEvent = onOpenEvent,
                        onOpenChores = onOpenChores,
                        onOpenGrocery = onOpenGrocery,
                        onOpenRecipe = onOpenRecipe,
                        onCookRecipe = onCookRecipe,
                        onOpenMeal = onOpenMeal,
                        onCookMeal = onCookMeal,
                    )

                    is TodayCards.CardRow.Pair -> Row(
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        modifier = Modifier.height(androidx.compose.foundation.layout.IntrinsicSize.Min),
                    ) {
                        listOf(row.first, row.second).forEach { key ->
                            Box(Modifier.weight(1f).fillMaxWidth()) {
                                CardView(
                                    key = key,
                                    dash = dash,
                                    tonightLoaded = tonight.loaded,
                                    tonightMeal = tonight.value?.firstOrNull(),
                                    chores = chores.value.orEmpty(),
                                    choresLoaded = chores.loaded,
                                    groceryRemaining = grocery.value ?: 0,
                                    groceryLoaded = grocery.loaded,
                                    events = todaysEvents,
                                    zone = zone,
                                    cardContent = cardContent,
                                    onOpenCalendar = onOpenCalendar,
                                    onOpenEvent = onOpenEvent,
                                    onOpenChores = onOpenChores,
                                    onOpenGrocery = onOpenGrocery,
                                    onOpenRecipe = onOpenRecipe,
                                    onCookRecipe = onCookRecipe,
                                    onOpenMeal = onOpenMeal,
                                    onCookMeal = onCookMeal,
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

/** Dispatch one card key to its content. An unknown/unwired key renders nothing. */
@Composable
private fun CardView(
    key: String,
    dash: DashboardModel,
    tonightLoaded: Boolean,
    tonightMeal: TonightMeal?,
    chores: List<TodayApi.PersonChores>,
    choresLoaded: Boolean,
    groceryRemaining: Int,
    groceryLoaded: Boolean,
    events: List<SyncedEvent>,
    zone: ZoneId,
    cardContent: Map<String, @Composable () -> Unit>,
    onOpenCalendar: () -> Unit,
    onOpenEvent: (SyncedEvent) -> Unit,
    onOpenChores: () -> Unit,
    onOpenGrocery: () -> Unit,
    onOpenRecipe: (TonightRecipe) -> Unit,
    onCookRecipe: (TonightRecipe) -> Unit,
    onOpenMeal: (TonightMeal) -> Unit,
    onCookMeal: (TonightMeal) -> Unit,
) {
    when (key) {
        TodayCards.AGENDA -> AgendaCard(events, zone, onOpenCalendar, onOpenEvent)
        TodayCards.TONIGHT -> TonightCard(
            meal = tonightMeal,
            loaded = tonightLoaded,
            onOpenRecipe = onOpenRecipe,
            onCookRecipe = onCookRecipe,
            onOpenMeal = onOpenMeal,
            onCookMeal = onCookMeal,
        )

        TodayCards.CHORES -> ChoresCard(
            people = chores,
            done = dash.choreDone,
            total = dash.choreTotal,
            stars = dash.choreStars,
            loaded = choresLoaded,
            onOpen = onOpenChores,
        )

        TodayCards.GROCERY -> GroceryCard(groceryRemaining, groceryLoaded, onOpenGrocery)
        // Countdowns, lists, pantry, Family Night and the goals hero belong to other
        // feature modules; the host supplies them.
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

    Spacer(Modifier.height(0.dp))
}

/** Milliseconds until just past the next local midnight. */
internal fun millisUntilNextDay(now: ZonedDateTime): Long {
    val nextMidnight = now.toLocalDate().plusDays(1).atStartOfDay(now.zone)
    // A second past, so the recomputed "today" can't land on the boundary itself.
    return java.time.Duration.between(now, nextMidnight).toMillis().coerceAtLeast(0) + 1_000
}

package app.waffled.feature.kiosktoday

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AICaptureBar
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledMenuPill
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledDates
import app.waffled.core.model.WaffledModule
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.sync.ModuleGate
import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.calendar.CountdownsCard
import app.waffled.feature.calendar.CountdownsModel
import app.waffled.feature.family.ApprovalsModel
import app.waffled.feature.familynight.FamilyNightCard
import app.waffled.feature.familynight.FamilyNightModel
import app.waffled.feature.goals.GoalHeroCard
import app.waffled.feature.goals.GoalsApi
import app.waffled.feature.pantry.PantryModel
import app.waffled.feature.pantry.PantryTodayCard
import app.waffled.feature.rhythms.RhythmsModel
import app.waffled.feature.rhythms.RhythmsTodayCard
import app.waffled.feature.today.RestStateNotice
import app.waffled.feature.today.TodayCards
import app.waffled.feature.today.TodayFormat
import app.waffled.feature.today.TonightMeal
import app.waffled.feature.today.TonightRecipe
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime

/** Where a card tap sends the kiosk shell. The shell maps these onto its own rail. */
enum class KioskTodayDestination { Calendar, Meals, Tasks, Lists, Goals, Pantry, Rhythms }

/**
 * The tablet Today page — port of iOS `Features/Kiosk/KioskDashboard.swift`. Three
 * columns from a per-device preset ([DashLayout]); cards route to the shell's pages via
 * [navigate] and drill-ins are the host's to present.
 *
 * Optional models feed the cards other features own; a null model hides its card.
 */
@Composable
fun KioskTodayScreen(
    model: KioskTodayModel,
    /** Already filtered per viewer and bucketed in the household zone (`SyncManager.eventsByDay`). */
    eventsByDay: Map<LocalDate, List<SyncedEvent>>,
    /** The HOUSEHOLD's zone. */
    zone: ZoneId,
    modules: ModuleGate,
    members: List<Person>,
    currentPersonId: String?,
    /** Per-device prefs the host persists (iOS `waffled.kioskDashLayout` / `waffled.kioskGoalId`). */
    layoutRaw: String,
    pinnedGoalId: String,
    onPrefsChange: (layoutRaw: String, pinnedGoalId: String) -> Unit,
    navigate: (KioskTodayDestination) -> Unit,
    modifier: Modifier = Modifier,
    refreshBus: RefreshBus? = null,
    approvals: ApprovalsModel? = null,
    /** The viewer holds `chore.approve` / `reward.approve`. */
    canApprove: Boolean = false,
    rewardsOn: Boolean = false,
    /**
     * The SAME scope key `app` gives the shared [ApprovalsModel] (it changes on sign-in /
     * server switch). A different key makes each load reset the other's queue.
     */
    dataScope: Any,
    countdowns: CountdownsModel? = null,
    pantry: PantryModel? = null,
    rhythms: RhythmsModel? = null,
    familyNight: FamilyNightModel? = null,
    onCapture: () -> Unit = {},
    onDictate: () -> Unit = {},
    onOpenEvent: (SyncedEvent) -> Unit = {},
    onOpenEventId: (String) -> Unit = {},
    onOpenRecipe: (TonightRecipe) -> Unit = {},
    onCookRecipe: (TonightRecipe) -> Unit = {},
    onOpenMeal: (TonightMeal) -> Unit = {},
    onCookMeal: (TonightMeal) -> Unit = {},
    onOpenGoal: (GoalsApi.Goal) -> Unit = {},
    onLogGoal: (GoalsApi.Goal) -> Unit = {},
    onOpenApprovals: () -> Unit = {},
    onOpenReview: () -> Unit = {},
    /** Reload what this page does not own (module flags, synced surfaces) — on resume and at midnight. */
    onRefreshSurfaces: suspend () -> Unit = {},
    /**
     * The Weekly Planning nudge, appended last in the meals column like iOS. A slot, because
     * the card needs `feature:planning`'s environment, which only `app` can build; the host
     * gates it on the `weeklyPlanning` module.
     */
    planningCard: (@Composable () -> Unit)? = null,
) {
    val chores by model.choresSnapshot.collectAsStateWithLifecycle()
    val meals by model.mealsSnapshot.collectAsStateWithLifecycle()
    val grocery by model.grocerySnapshot.collectAsStateWithLifecycle()
    val settling by model.settling.collectAsStateWithLifecycle()
    val goals by model.goalsSnapshot.collectAsStateWithLifecycle()
    val recap by model.recapSnapshot.collectAsStateWithLifecycle()
    val suggestions by model.suggestionsSnapshot.collectAsStateWithLifecycle()
    val weather by model.weather.collectAsStateWithLifecycle()

    val scope = rememberCoroutineScope()
    var today by remember(zone) { mutableStateOf(LocalDate.now(zone)) }
    // Bumped on resume / midnight so the self-loading cards (rhythms, pantry, …) refetch.
    var surfaceRev by remember { mutableIntStateOf(0) }
    var showAddGrocery by remember { mutableStateOf(false) }

    val layout = DashLayout.parse(layoutRaw)
    val prefs = KioskDashPrefs(layout, pinnedGoalId)
    val memberIds = remember(members) { members.mapTo(HashSet()) { it.id } }
    val membersById = remember(members) { members.associateBy { it.id } }
    val goalRows = goals.value.orEmpty()
    val kioskGoal = remember(goalRows, pinnedGoalId, memberIds) {
        KioskGoalPick.featured(goalRows, pinnedGoalId, memberIds)
    }
    val week = remember(eventsByDay, today) { KioskTodayFormat.week(eventsByDay, today) }
    val groceryActive = remember(grocery.value, settling) {
        KioskTodayModel.activeGrocery(grocery.value.orEmpty(), settling)
    }

    suspend fun reloadApprovals() {
        approvals?.load(dataScope, choresEnabled = modules.isOn(WaffledModule.Chores), rewardsEnabled = rewardsOn)
    }

    suspend fun reloadAll() = coroutineScope {
        launch { onRefreshSurfaces() }
        launch { model.loadChores() }
        launch { model.loadMeals(today.toString()) }
        launch { model.loadGrocery() }
        launch { model.loadGoals() }
        launch { model.loadReview() }
        launch { reloadApprovals() }
        surfaceRev++
    }

    LaunchedEffect(zone) { model.loadWeather() }

    // REST data changes silently elsewhere, so every return to the foreground (including
    // the first) refetches; this is also the always-on wall's only unattended refresh.
    LifecycleResumeEffect(zone, today, dataScope) {
        val job = scope.launch { reloadAll() }
        onPauseOrDispose { job.cancel() }
    }

    // Day rollover on the always-on display: sleep to just past household midnight and re-key.
    LaunchedEffect(zone) {
        while (true) {
            delay(millisUntilNextDay(ZonedDateTime.now(zone)))
            today = LocalDate.now(zone)
        }
    }

    LaunchedEffect(refreshBus, zone, today) {
        refreshBus?.events?.collectLatest { domain ->
            when (domain) {
                RefreshDomain.Chores -> { model.loadChores(); reloadApprovals() }
                RefreshDomain.Rewards, RefreshDomain.Modules -> reloadApprovals()
                RefreshDomain.Meals -> model.loadMeals(today.toString())
                RefreshDomain.Lists, RefreshDomain.Pantry -> model.loadGrocery()
                RefreshDomain.Goals -> coroutineScope {
                    launch { model.loadGoals() }
                    launch { model.loadReview() }
                }
                RefreshDomain.Photos -> Unit
            }
        }
    }

    val retryChores: () -> Unit = { scope.launch { model.loadChores() } }
    val retryMeals: () -> Unit = { scope.launch { model.loadMeals(today.toString()) } }
    val retryGrocery: () -> Unit = { scope.launch { model.loadGrocery() } }
    val retryGoals: () -> Unit = { scope.launch { model.loadGoals() } }

    @Composable
    fun tonightCard() {
        val meal = meals.value?.tonight
        TonightKioskCard(
            meal = meal,
            state = meals.rest,
            onRetry = retryMeals,
            onOpenRecipe = { meal?.recipeSummary?.let(onOpenRecipe) },
            onCookRecipe = { meal?.recipeSummary?.let(onCookRecipe) },
            onOpenMeal = { meal?.let(onOpenMeal) },
            onCookMeal = { meal?.let(onCookMeal) },
        )
    }

    @Composable
    fun weekDinners() = WeekDinnersCard(meals.value?.week.orEmpty()) { navigate(KioskTodayDestination.Meals) }

    @Composable
    fun column(kind: KioskColumn, colModifier: Modifier) {
        when (kind) {
            KioskColumn.Agenda -> Column(colModifier, verticalArrangement = Arrangement.spacedBy(22.dp)) {
                AgendaWeekCard(
                    week = week, today = today, zone = zone, members = membersById,
                    onOpenCalendar = { navigate(KioskTodayDestination.Calendar) },
                    onOpenEvent = onOpenEvent,
                    // A scrolling week takes the column's spare height; an empty one hugs its copy.
                    modifier = if (week.isEmpty()) Modifier else Modifier.weight(1f),
                )
                countdowns?.let { CountdownsCard(it, onOpenEvent = onOpenEventId, refreshKey = surfaceRev) }
                if (pantry != null && modules.isOn(WaffledModule.Pantry)) {
                    PantryTodayCard(pantry, onOpen = { navigate(KioskTodayDestination.Pantry) }, refreshKey = surfaceRev)
                }
            }

            KioskColumn.Meals -> Column(
                colModifier.verticalScroll(rememberScrollState()).padding(bottom = 8.dp),
                verticalArrangement = Arrangement.spacedBy(22.dp),
            ) {
                tonightCard()
                weekDinners()
                if (familyNight != null && modules.isOn(WaffledModule.FamilyNight)) {
                    FamilyNightCard(familyNight, kiosk = true, refreshKey = surfaceRev)
                }
                planningCard?.invoke()
            }

            KioskColumn.ChoreGrocery -> Column(colModifier, verticalArrangement = Arrangement.spacedBy(22.dp)) {
                FamilyChoresCard(chores.value.orEmpty(), chores.rest, retryChores) {
                    navigate(KioskTodayDestination.Tasks)
                }
                // Renders nothing when the register is quiet — same rule as the web card.
                if (rhythms != null && modules.isOn(WaffledModule.Rhythms)) {
                    RhythmsTodayCard(
                        rhythms, onOpen = { navigate(KioskTodayDestination.Rhythms) }, kiosk = true, refreshKey = surfaceRev,
                    )
                }
                // Grocery stays last: it takes what the column has left and scrolls inside.
                GroceryKioskCard(
                    active = groceryActive,
                    state = grocery.rest,
                    onRetry = retryGrocery,
                    onOpenLists = { navigate(KioskTodayDestination.Lists) },
                    onToggle = { item -> scope.launch { model.toggleGrocery(item.id, scope) } },
                    onAdd = { showAddGrocery = true },
                    modifier = Modifier.weight(1f),
                )
            }

            KioskColumn.Goal -> Column(
                colModifier.verticalScroll(rememberScrollState()).padding(bottom = 8.dp),
                verticalArrangement = Arrangement.spacedBy(22.dp),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    RestStateNotice(goals.rest, retry = retryGoals)
                    if (KioskTodayRules.showsGoalCard(goalRows.isNotEmpty(), goals.rest)) {
                        GoalCardWithPicker(
                            goal = kioskGoal,
                            goals = goalRows,
                            goalsLoaded = goals.rest.isAuthoritative,
                            pinnedGoalId = pinnedGoalId,
                            memberIds = memberIds,
                            currentPersonId = currentPersonId,
                            onOpen = onOpenGoal,
                            onSeeAll = { navigate(KioskTodayDestination.Goals) },
                            onLog = onLogGoal,
                            onPin = { id -> prefs.pinning(id).let { onPrefsChange(it.layout.raw, it.pinnedGoalId) } },
                        )
                    }
                }
                if (KioskTodayRules.goalColumnShowsTonight(meals.value?.tonight != null, meals.rest)) {
                    tonightCard()
                } else {
                    weekDinners()
                }
            }
        }
    }

    Column(modifier.fillMaxSize().background(WF.colors.canvas)) {
        Header(
            zone = zone,
            weather = TodayFormat.weatherChip(weather),
            layout = layout,
            onLayout = { onPrefsChange(it.raw, pinnedGoalId) },
            onCapture = onCapture,
            onDictate = onDictate,
        )
        Column(
            Modifier
                .fillMaxSize()
                .padding(start = 40.dp, end = 40.dp, top = 2.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Banners(
                approvals = approvals,
                showApprovals = modules.isOn(WaffledModule.Chores) && canApprove,
                recapTitles = if (modules.isOn(WaffledModule.Goals)) recap.value.orEmpty().map { it.title } else emptyList(),
                suggestionTitles = if (modules.isOn(WaffledModule.Goals)) suggestions.value.orEmpty().map { it.title } else emptyList(),
                onOpenApprovals = onOpenApprovals,
                onOpenReview = onOpenReview,
            )
            Row(
                Modifier.fillMaxSize(),
                horizontalArrangement = Arrangement.spacedBy(22.dp),
                verticalAlignment = Alignment.Top,
            ) {
                layout.columns.forEach { (kind, weight) ->
                    column(kind, Modifier.weight(weight).fillMaxHeight())
                }
            }
        }
    }

    if (showAddGrocery) {
        AddGrocerySheet(
            onAdd = { name -> scope.launch { model.addGrocery(name) } },
            onDismiss = { showAddGrocery = false },
        )
    }
}

@Composable
private fun Banners(
    approvals: ApprovalsModel?,
    showApprovals: Boolean,
    recapTitles: List<String>,
    suggestionTitles: List<String>,
    onOpenApprovals: () -> Unit,
    onOpenReview: () -> Unit,
) {
    val queue = approvals?.state?.collectAsStateWithLifecycle()?.value
    val approvalsBar = showApprovals && queue != null && queue.showsEntryPoint
    val reviewBar = recapTitles.isNotEmpty() || suggestionTitles.isNotEmpty()
    if (!approvalsBar && !reviewBar) return
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (approvalsBar) {
            KioskBanner(
                title = queue.entryTitle,
                subtitle = KioskTodayFormat.approvalsSubtitle(queue.redemptions, queue.chores),
                cta = "Review",
                accent = WF.colors.gold.copy(alpha = 0.35f),
                icon = { ApprovalsBannerIcon() },
                iconFill = SolidColor(WF.colors.gold),
                onClick = onOpenApprovals,
            )
        }
        if (reviewBar) {
            KioskBanner(
                title = TodayCards.reviewRecapTitle(recapTitles.size, suggestionTitles.size),
                subtitle = KioskTodayFormat.reviewSubtitle(recapTitles + suggestionTitles),
                cta = "Review & log",
                accent = WF.colors.ai.copy(alpha = 0.3f),
                icon = { ReviewBannerIcon() },
                iconFill = Brush.linearGradient(listOf(WF.colors.ai2, WF.colors.ai)),
                onClick = onOpenReview,
            )
        }
    }
}

/** Greeting + layout menu + capture bar, then date · time · weather. */
@Composable
private fun Header(
    zone: ZoneId,
    weather: String?,
    layout: DashLayout,
    onLayout: (DashLayout) -> Unit,
    onCapture: () -> Unit,
    onDictate: () -> Unit,
) {
    // The clock line ticks every 30s, as iOS's TimelineView does.
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = Instant.now()
        }
    }
    var menuOpen by remember { mutableStateOf(false) }
    val line = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold)

    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.canvas)
            .statusBarsPadding()
            .padding(start = 40.dp, end = 40.dp, top = 22.dp, bottom = 10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(TodayFormat.greeting(now, zone), style = WF.type.serif(40.sp), color = WF.colors.ink)
            Spacer(Modifier.weight(1f))
            Box {
                WaffledMenuPill(layout.label, Modifier.clickable { menuOpen = true })
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DashLayout.entries.forEach { l ->
                        DropdownMenuItem(
                            text = { Text(l.label) },
                            onClick = { menuOpen = false; onLayout(l) },
                            trailingIcon = if (l == layout) {
                                { Icon(Icons.Filled.Check, contentDescription = "Selected") }
                            } else {
                                null
                            },
                        )
                    }
                }
            }
            AICaptureBar(modifier = Modifier.weight(1f, fill = false).then(CaptureBarMaxWidth), onTap = onCapture, onMic = onDictate)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(WaffledDates.format(now, "EEEE, MMMM d", zone), style = line, color = WF.colors.ink2)
            Dot()
            Text(WaffledDates.format(now, "h:mm a", zone), style = line, color = WF.colors.ink2)
            if (weather != null) {
                Dot()
                Text(weather, style = line, color = WF.colors.ink2)
            }
        }
    }
}

@Composable
private fun Dot() =
    Text("·", style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink3)

/**
 * The goals feature's hero card plus a pin picker. iOS's kiosk hero carries its own pin
 * menu; the Android card exposes only `onSwitch`, so the picker hangs off that.
 */
@Composable
private fun GoalCardWithPicker(
    goal: GoalsApi.Goal?,
    goals: List<GoalsApi.Goal>,
    goalsLoaded: Boolean,
    pinnedGoalId: String,
    memberIds: Set<String>,
    currentPersonId: String?,
    onOpen: (GoalsApi.Goal) -> Unit,
    onSeeAll: () -> Unit,
    onLog: (GoalsApi.Goal) -> Unit,
    onPin: (String) -> Unit,
) {
    var picking by remember { mutableStateOf(false) }
    Box {
        GoalHeroCard(
            goal = goal,
            goalsLoaded = goalsLoaded,
            householdMemberIds = memberIds,
            myPersonId = currentPersonId,
            onOpen = onOpen,
            onSeeAll = onSeeAll,
            onLog = onLog,
            onSwitch = if (goals.size > 1) ({ picking = true }) else null,
        )
        DropdownMenu(expanded = picking, onDismissRequest = { picking = false }) {
            DropdownMenuItem(
                text = { Text("Automatic") },
                onClick = { picking = false; onPin("") },
                trailingIcon = if (pinnedGoalId.isEmpty()) {
                    { Icon(Icons.Filled.Check, contentDescription = "Selected") }
                } else {
                    null
                },
            )
            goals.forEach { g ->
                DropdownMenuItem(
                    text = { Text(listOfNotNull(g.emoji, g.title).joinToString(" ")) },
                    onClick = { picking = false; onPin(g.id) },
                    trailingIcon = if (g.id == pinnedGoalId) {
                        { Icon(Icons.Filled.Check, contentDescription = "Selected") }
                    } else {
                        null
                    },
                )
            }
        }
    }
}

/** Milliseconds until just past the next household midnight. */
internal fun millisUntilNextDay(now: ZonedDateTime): Long {
    val nextMidnight = now.toLocalDate().plusDays(1).atStartOfDay(now.zone)
    return java.time.Duration.between(now, nextMidnight).toMillis().coerceAtLeast(0) + 1_000
}

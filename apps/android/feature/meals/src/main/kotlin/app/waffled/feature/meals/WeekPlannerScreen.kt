package app.waffled.feature.meals

import app.waffled.core.model.HouseholdWeekStart
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Autorenew
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.model.RecipeRef
import kotlinx.coroutines.launch

/**
 * The weekly meal planner — a day-by-day list of what is planned, with plan / change /
 * move / clear, and the ✨ "Plan my week" sheet.
 *
 * **Phone layout only.** iOS also has an iPad meal-type x day grid; that is out of scope
 * here and noted in the hand-off.
 *
 * Two seams keep this module independent of the recipes feature: [recipePicker] is a
 * host-supplied picker that answers with a [RecipeRef], and [onOpenRecipe] hands a recipe
 * id back to whoever owns recipe detail.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WeekPlannerScreen(
    model: WeekPlannerModel,
    /** The household's `week_start`, or null when no household row has synced yet. */
    householdWeekStart: HouseholdWeekStart?,
    /** Household size, for the plan sheet's "whole family" option. */
    familySize: Int,
    /** The library pool the plan sheet falls back to when the model repeats itself. */
    libraryRecipes: List<RecipeRef>,
    onOpenRecipe: (String) -> Unit,
    onOpenMeal: (MealDTO) -> Unit,
    recipePicker: @Composable (onPick: (RecipeRef) -> Unit, onDismiss: () -> Unit) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val entries by model.entries.collectAsStateWithLifecycle()
    val loading by model.loading.collectAsStateWithLifecycle()
    val moveError by model.moveError.collectAsStateWithLifecycle()

    // Precomputed once per data change — never in a row. Date math in a render path is
    // one of the two documented performance traps carried over from iOS.
    val days = remember(entries, model.weekOffset.collectAsStateWithLifecycle().value) { model.days(entries) }
    val hasEmptyNight = remember(entries) { model.hasEmptyNight(entries) }

    var pickTarget by remember { mutableStateOf<Pair<String, String>?>(null) }
    var moveSource by remember { mutableStateOf<WeekEntryDTO?>(null) }
    var planningWeek by remember { mutableStateOf(false) }

    PullToRefreshBox(
        isRefreshing = loading,
        onRefresh = { scope.launch { model.reloadIfAllowed() } },
        modifier = modifier.fillMaxSize().background(WF.colors.canvas),
    ) {
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(
                start = 16.dp, end = 16.dp, top = 6.dp, bottom = WF.spacing.tabBarClearance,
            ),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item(key = "header") {
                PeriodHeader(
                    title = model.weekLabel,
                    jumpLabel = if (model.isThisWeek) null else "Jump to this week",
                    onPrevious = { scope.launch { model.step(-1) } },
                    onNext = { scope.launch { model.step(1) } },
                    onJump = { scope.launch { model.jumpToThisWeek() } },
                )
            }
            if (moveError != null) {
                item(key = "move-error") {
                    DismissibleErrorBanner(message = moveError.orEmpty(), onDismiss = model::dismissMoveError)
                }
            }
            if (hasEmptyNight) {
                item(key = "plan-cta") {
                    PlanCta("Plan my week", onClick = { planningWeek = true })
                }
            }
            items(days, key = { it.ymd }) { day ->
                DayCard(
                    day = day,
                    primarySlots = model.primarySlots,
                    onPlan = { slot -> pickTarget = day.ymd to slot },
                    onOpen = { entry -> openEntry(entry, onOpenRecipe, onOpenMeal) },
                    onChange = { entry -> pickTarget = entry.date to entry.mealType },
                    onMove = { entry -> moveSource = entry },
                    onRemove = { entry -> scope.launch { model.clear(entry.date, entry.mealType) } },
                )
            }
        }
    }

    pickTarget?.let { (date, slot) ->
        recipePicker(
            { recipe ->
                pickTarget = null
                scope.launch { model.plan(date, slot, recipe.id) }
            },
            { pickTarget = null },
        )
    }

    moveSource?.let { source ->
        val targets = remember(source, entries) { model.moveTargets(source.date, source.mealType) }
        val labels = remember(days) { days.associate { it.ymd to "${it.weekdayLabel} ${it.dayLabel}" } }
        MoveMealSheet(
            movingTitle = source.displayTitle,
            movingEmoji = source.displayEmoji,
            targets = targets,
            dayLabel = { labels[it] ?: it },
            onPick = { target ->
                moveSource = null
                scope.launch { model.move(source.date, source.mealType, target.date, target.mealType) }
            },
            onDismiss = { moveSource = null },
        )
    }

    if (planningWeek) {
        PlanWeekSheet(
            start = MealsFormat.ymd(model.weekStart),
            weekDays = model.weekDays,
            familySize = familySize,
            libraryRecipes = libraryRecipes,
            householdWeekStart = householdWeekStart,
            api = model.api,
            recipePicker = recipePicker,
            onApplied = { scope.launch { model.load() } },
            onDismiss = { planningWeek = false },
        )
    }
}

/**
 * Open a planned slot.
 *
 * A plate-backed slot has no `recipeId`, so opening by recipe alone made the tap dead on a
 * dinner that was fully planned — check the plate FIRST. Free-text nights link nothing and
 * stay inert.
 */
private fun openEntry(
    entry: WeekEntryDTO,
    onOpenRecipe: (String) -> Unit,
    onOpenMeal: (MealDTO) -> Unit,
) {
    entry.platePlaceholder?.let { return onOpenMeal(it) }
    entry.recipeId?.let(onOpenRecipe)
}

/**
 * One day of the week.
 *
 * Meals interleave chronologically: for each primary slot, the planned entry if there is
 * one, otherwise a "Plan <Slot>" button — so the card reads in meal order rather than
 * entries-then-buttons. Snacks and any other non-primary slot render after dinner.
 */
@Composable
private fun DayCard(
    day: PlannerDay,
    primarySlots: List<String>,
    onPlan: (String) -> Unit,
    onOpen: (WeekEntryDTO) -> Unit,
    onChange: (WeekEntryDTO) -> Unit,
    onMove: (WeekEntryDTO) -> Unit,
    onRemove: (WeekEntryDTO) -> Unit,
) {
    WaffledCard(padding = 14.dp) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                day.weekdayLabel,
                style = WF.type.sectionLabel,
                color = if (day.isToday) WF.colors.primary else WF.colors.ink2,
            )
            Text(day.dayLabel, style = WF.type.caption, color = WF.colors.ink3)
            if (day.isToday) {
                Text(
                    "TODAY",
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(WF.colors.primaryT)
                        .padding(horizontal = 7.dp, vertical = 3.dp),
                    style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.Black),
                    color = WF.colors.primary,
                )
            }
        }
        Spacer(Modifier.size(10.dp))
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            primarySlots.forEach { slot ->
                val entry = day.entry(slot)
                if (entry != null) {
                    EntryRow(entry, onOpen, onChange, onMove, onRemove)
                } else {
                    PlanSlotButton("Plan ${MealsFormat.slotLabel(slot)}", onClick = { onPlan(slot) })
                }
            }
            // An existing snack (or any other non-primary meal type) still shows, in slot
            // order — it just isn't offered as an add button.
            day.entries.filterNot { it.mealType in primarySlots }.forEach { entry ->
                EntryRow(entry, onOpen, onChange, onMove, onRemove)
            }
        }
    }
}

@Composable
private fun EntryRow(
    entry: WeekEntryDTO,
    onOpen: (WeekEntryDTO) -> Unit,
    onChange: (WeekEntryDTO) -> Unit,
    onMove: (WeekEntryDTO) -> Unit,
    onRemove: (WeekEntryDTO) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier
                .weight(1f)
                .clip(RoundedCornerShape(WF.radius.sm))
                .clickable(enabled = entry.isOpenable) { onOpen(entry) },
            horizontalArrangement = Arrangement.spacedBy(11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(11.dp))
                    .background(WF.colors.panel),
                contentAlignment = Alignment.Center,
            ) {
                Text(entry.displayEmoji, style = TextStyle(fontSize = 22.sp))
            }
            Column(Modifier.weight(1f)) {
                Text(
                    entry.displayTitle,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (entry.mealType != "dinner") {
                        PlanTag(MealsFormat.slotLabel(entry.mealType))
                    }
                    if (entry.isMealBacked) {
                        val n = entry.dishCount
                        PlanTag("🥘 $n ${if (n == 1) "dish" else "dishes"}")
                    }
                    entry.recipe?.cookTimeMinutes?.let {
                        Text("🕐 ${it}m", style = WF.type.caption, color = WF.colors.ink3)
                    }
                    entry.cook?.name?.let {
                        Text("👩‍🍳 $it", style = WF.type.caption, color = WF.colors.ink3)
                    }
                }
            }
        }
        Box {
            Icon(
                Icons.Filled.MoreVert,
                contentDescription = "Actions for ${entry.displayTitle}",
                tint = WF.colors.ink3,
                modifier = Modifier
                    .size(30.dp)
                    .clip(CircleShape)
                    .clickable { menuOpen = true }
                    .padding(6.dp),
            )
            MealRowMenu(
                expanded = menuOpen,
                onDismiss = { menuOpen = false },
                items = listOf(
                    MenuAction("Change", Icons.Filled.Autorenew, onClick = { onChange(entry) }),
                    MenuAction("Move…", Icons.Filled.SwapHoriz, onClick = { onMove(entry) }),
                    MenuAction("Remove", Icons.Filled.Delete, onClick = { onRemove(entry) }, destructive = true),
                ),
            )
        }
    }
}

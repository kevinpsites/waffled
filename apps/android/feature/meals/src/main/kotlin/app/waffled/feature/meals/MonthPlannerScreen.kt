package app.waffled.feature.meals

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Autorenew
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.WF
import app.waffled.core.model.RecipeRef
import kotlinx.coroutines.launch

/**
 * The monthly meal planner — a 6x7 grid of the month's **dinners**, mirroring the web's
 * dinner-only month view.
 *
 * Tapping a planned night opens its actions (open / change / move / remove); tapping an
 * empty in-month night opens the picker. **Phone layout only.**
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MonthPlannerScreen(
    model: MonthPlannerModel,
    householdWeekStart: HouseholdWeekStart?,
    familySize: Int,
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
    val anchor by model.anchor.collectAsStateWithLifecycle()

    // One pass per data change, never per cell.
    val cells = remember(entries, anchor) { model.cells(entries) }
    val weeks = remember(cells) { cells.chunked(7) }

    var pickDate by remember { mutableStateOf<String?>(null) }
    var actionTarget by remember { mutableStateOf<WeekEntryDTO?>(null) }
    var moveSource by remember { mutableStateOf<WeekEntryDTO?>(null) }
    var planningMonth by remember { mutableStateOf(false) }

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
                    title = model.monthYearLabel,
                    jumpLabel = if (model.isCurrentMonth) null else "Jump to this month",
                    onPrevious = { scope.launch { model.step(-1) } },
                    onNext = { scope.launch { model.step(1) } },
                    onJump = { scope.launch { model.jumpToThisMonth() } },
                )
            }
            if (moveError != null) {
                item(key = "move-error") {
                    DismissibleErrorBanner(message = moveError.orEmpty(), onDismiss = model::dismissMoveError)
                }
            }
            item(key = "hint") {
                Text(
                    "Dinners for the month · tap to add or open.",
                    style = WF.type.caption,
                    color = WF.colors.ink3,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item(key = "plan-cta") {
                PlanCta("Plan my month", onClick = { planningMonth = true })
            }
            item(key = "weekdays") {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    model.weekdaySymbols.forEach { symbol ->
                        Text(
                            symbol,
                            modifier = Modifier.weight(1f),
                            style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Black),
                            color = WF.colors.ink3,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
            items(weeks, key = { it.first().ymd }) { week ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    week.forEach { cell ->
                        MonthDayCell(
                            cell = cell,
                            modifier = Modifier.weight(1f),
                            onTap = {
                                if (!cell.inMonth) return@MonthDayCell
                                val entry = cell.entry
                                if (entry != null) actionTarget = entry else pickDate = cell.ymd
                            },
                        )
                    }
                }
            }
        }
    }

    actionTarget?.let { entry ->
        MonthNightActions(
            entry = entry,
            onOpen = {
                actionTarget = null
                entry.platePlaceholder?.let(onOpenMeal) ?: entry.recipeId?.let(onOpenRecipe)
            },
            onChange = {
                actionTarget = null
                pickDate = entry.date
            },
            onMove = {
                actionTarget = null
                moveSource = entry
            },
            onRemove = {
                actionTarget = null
                scope.launch { model.clear(entry.date) }
            },
            onDismiss = { actionTarget = null },
        )
    }

    pickDate?.let { date ->
        recipePicker(
            { recipe ->
                pickDate = null
                scope.launch { model.plan(date, recipe.id) }
            },
            { pickDate = null },
        )
    }

    moveSource?.let { source ->
        val targets = remember(source, entries) { model.moveTargets(source.date) }
        MoveMealSheet(
            movingTitle = source.displayTitle,
            movingEmoji = source.displayEmoji,
            targets = targets,
            dayLabel = { MealsFormat.reviewDayLabel(it) },
            onPick = { target ->
                moveSource = null
                scope.launch { model.move(source.date, target.date) }
            },
            onDismiss = { moveSource = null },
        )
    }

    if (planningMonth) {
        PlanMonthSheet(
            monthStart = MealsFormat.ymd(model.monthStart),
            monthLabel = model.monthLabel,
            familySize = familySize,
            libraryRecipes = libraryRecipes,
            householdWeekStart = householdWeekStart,
            api = model.api,
            recipePicker = recipePicker,
            onApplied = { scope.launch { model.load() } },
            onDismiss = { planningMonth = false },
        )
    }
}

@Composable
private fun MonthDayCell(cell: MonthCell, onTap: () -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(10.dp)
    val highlighted = cell.isToday && cell.inMonth
    Column(
        modifier
            .aspectRatio(0.82f)
            .clip(shape)
            .background(if (cell.inMonth) WF.colors.card else Color.Transparent)
            .border(
                width = if (highlighted) 2.dp else 1.dp,
                color = if (highlighted) WF.colors.primary else WF.colors.hair,
                shape = shape,
            )
            .alpha(if (cell.inMonth) 1f else 0.4f)
            .clickable(enabled = cell.inMonth, onClick = onTap)
            .padding(horizontal = 4.dp, vertical = 5.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            cell.dayNumber,
            modifier = Modifier.fillMaxWidth(),
            style = TextStyle(
                fontSize = 11.sp,
                fontWeight = if (cell.isToday) FontWeight.Black else FontWeight.SemiBold,
            ),
            color = when {
                cell.isToday -> WF.colors.primary
                cell.inMonth -> WF.colors.ink2
                else -> WF.colors.ink3
            },
        )
        if (cell.entry != null && cell.inMonth) {
            Text(cell.emoji, style = TextStyle(fontSize = 17.sp))
            Text(
                cell.entry.displayTitle,
                style = TextStyle(fontSize = 9.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink2,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
            )
        } else if (cell.inMonth) {
            Spacer(Modifier.weight(1f))
            Text("+", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink3)
            Spacer(Modifier.weight(1f))
        }
    }
}

/**
 * The tap actions for a planned night.
 *
 * A sheet rather than a long-press menu: iOS uses a tap-based confirmation dialog here
 * precisely so the gesture doesn't fight the drag, and the same reasoning holds for a
 * grid cell too small to host a reliable long-press target.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MonthNightActions(
    entry: WeekEntryDTO,
    onOpen: () -> Unit,
    onChange: () -> Unit,
    onMove: () -> Unit,
    onRemove: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp)) {
            Text(entry.displayTitle, style = WF.type.sectionTitle, color = WF.colors.ink)
            Text(MealsFormat.reviewDayLabel(entry.date), style = WF.type.micro, color = WF.colors.ink3)
            Spacer(Modifier.size(14.dp))
            // A plate-backed night has no recipeId; opening by recipe alone made the tap
            // dead on a dinner that was fully planned.
            if (entry.isOpenable) {
                ActionRow(
                    if (entry.isMealBacked) "Open meal" else "Open recipe",
                    Icons.Filled.OpenInNew,
                    onOpen,
                )
            }
            ActionRow("Change", Icons.Filled.Autorenew, onChange)
            ActionRow("Move…", Icons.Filled.SwapHoriz, onMove)
            ActionRow("Remove", Icons.Filled.Delete, onRemove, destructive = true)
            Spacer(Modifier.size(WF.spacing.tabBarClearance))
        }
    }
}

@Composable
private fun ActionRow(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    onClick: () -> Unit,
    destructive: Boolean = false,
) {
    val tint = if (destructive) WF.colors.danger else WF.colors.ink
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(WF.radius.sm))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.material3.Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        Text(label, style = WF.type.label, color = tint)
    }
}

package app.waffled.feature.meals

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.DisclosureChevron
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledFieldCard
import app.waffled.core.design.WaffledMenuPill
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.WeekdayToggleChip
import app.waffled.core.model.RecipeRef
import kotlinx.coroutines.launch

/**
 * The AI "Plan my month ✨" flow.
 *
 * Guardrails — which weeknights, cooking-for, repeat rotation + gap, quick-weeknight cap,
 * leftover nights, per-weekday theme nights, use-up, keep-in-mind — then one draft of the
 * whole month, then a per-night review grouped into collapsible weeks that the user
 * curates (lock / swap / pick / move / skip / reshuffle). Nothing saves until Save.
 *
 * Phone layout only.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlanMonthSheet(
    monthStart: String,
    monthLabel: String,
    familySize: Int,
    libraryRecipes: List<RecipeRef>,
    householdWeekStart: HouseholdWeekStart?,
    api: MealsApi,
    recipePicker: @Composable (onPick: (RecipeRef) -> Unit, onDismiss: () -> Unit) -> Unit,
    onApplied: () -> Unit,
    onDismiss: () -> Unit,
) {
    val model = remember(monthStart) {
        PlanMonthModel(
            api = api, libraryRecipes = libraryRecipes, householdWeekStart = householdWeekStart,
            familySize = familySize, monthStart = monthStart,
        )
    }
    val scope = rememberCoroutineScope()
    val phase by model.phase.collectAsStateWithLifecycle()

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(Modifier.fillMaxSize()) {
            SheetHeader("Plan $monthLabel", onDismiss)
            when (phase) {
                PlanPhase.Config -> MonthConfig(model, monthLabel) { scope.launch { model.suggest() } }
                PlanPhase.Loading -> PlanLoadingView(
                    "Drafting your month…",
                    "Asking the kitchen AI — a month can take a moment on a local model.",
                )
                PlanPhase.Review -> MonthReview(model, recipePicker) {
                    scope.launch {
                        model.apply()
                        onApplied()
                        onDismiss()
                    }
                }
                PlanPhase.Empty -> PlanMessageView(
                    "🎉",
                    "Every night this month is already planned.",
                    "Nothing to draft — you're set.",
                )
                PlanPhase.Failed -> {
                    val message by model.errorMessage.collectAsStateWithLifecycle()
                    PlanMessageView(
                        "😕",
                        "Couldn't plan the month",
                        message ?: "The AI provider didn't respond. Try again.",
                        onRetry = model::backToConfig,
                    )
                }
            }
        }
    }
}

/** The theme-night options, mirroring the web's list. */
private val THEME_OPTIONS = listOf(
    "meatless" to "Meatless",
    "tacos" to "Taco night",
    "pizza" to "Pizza night",
    "pasta" to "Pasta night",
    "seafood" to "Seafood",
    "soup" to "Soup & salad",
    "breakfast" to "Breakfast for dinner",
    "grill" to "Grill night",
    "takeout" to "Takeout",
    "leftovers" to "Leftovers",
)

/** Sunday = 0, the server's weekday convention. */
private val DAY_NAMES = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

@Composable
private fun MonthConfig(model: PlanMonthModel, monthLabel: String, onSuggest: () -> Unit) {
    val weekdays by model.weekdays.collectAsStateWithLifecycle()
    val cookingFor by model.cookingFor.collectAsStateWithLifecycle()
    val allowRepeats by model.allowRepeats.collectAsStateWithLifecycle()
    val repeatGapDays by model.repeatGapDays.collectAsStateWithLifecycle()
    val quickWeeknights by model.quickWeeknights.collectAsStateWithLifecycle()
    val weeknightMax by model.weeknightMax.collectAsStateWithLifecycle()
    val leftovers by model.leftovers.collectAsStateWithLifecycle()
    val themes by model.themes.collectAsStateWithLifecycle()
    val useUp by model.useUp.collectAsStateWithLifecycle()
    val useUpInput by model.useUpInput.collectAsStateWithLifecycle()
    val keepInMind by model.keepInMind.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text(
                "Waffled drafts a dinner rotation for the month from your recipe library, " +
                    "then you tweak it.",
                style = WF.type.body,
                color = WF.colors.ink3,
            )

            WaffledFieldCard(title = "Which days?") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    DAY_NAMES.forEachIndexed { dow, name ->
                        WeekdayToggleChip(
                            label = name,
                            isOn = dow in weekdays,
                            onClick = { model.toggleWeekday(dow) },
                        )
                    }
                }
            }

            PlanConfigCard {
                CookingForRow(cookingFor, model.familySize) { model.cookingFor.value = it }
            }

            PlanConfigCard {
                PlanConfigRow(label = "Allow repeat meals (a rotation)") {
                    WaffledSwitch(allowRepeats) { model.allowRepeats.value = it }
                }
                if (allowRepeats) {
                    Spacer(Modifier.size(12.dp))
                    PlanConfigRow(label = "No closer than") {
                        OptionPill(
                            label = "$repeatGapDays days",
                            options = listOf(3, 5, 7, 10, 14).map { it to "$it days" },
                            onSelect = { model.repeatGapDays.value = it },
                        )
                    }
                }
            }

            PlanConfigCard {
                PlanConfigRow(label = "Quick weeknights") {
                    WaffledSwitch(quickWeeknights) { model.quickWeeknights.value = it }
                }
                if (quickWeeknights) {
                    Spacer(Modifier.size(12.dp))
                    PlanConfigRow(label = "Under") {
                        OptionPill(
                            label = "$weeknightMax min",
                            options = listOf(20, 30, 45).map { it to "$it min" },
                            onSelect = { model.weeknightMax.value = it },
                        )
                    }
                }
                Spacer(Modifier.size(12.dp))
                PlanConfigRow(label = "Leftover nights after a big cook") {
                    WaffledSwitch(leftovers) { model.leftovers.value = it }
                }
            }

            if (weekdays.isNotEmpty()) {
                WaffledFieldCard(title = "Theme nights · optional") {
                    val sorted = weekdays.sorted()
                    sorted.forEachIndexed { index, dow ->
                        PlanConfigRow(
                            label = DAY_NAMES[dow],
                            modifier = Modifier.padding(vertical = 9.dp),
                        ) {
                            OptionPill(
                                label = themes[dow]?.let { key ->
                                    THEME_OPTIONS.firstOrNull { it.first == key }?.second
                                } ?: "No theme",
                                options = listOf<String?>(null).plus(THEME_OPTIONS.map { it.first })
                                    .map { key ->
                                        key to (THEME_OPTIONS.firstOrNull { it.first == key }?.second ?: "No theme")
                                    },
                                onSelect = { model.setTheme(dow, it) },
                            )
                        }
                        if (index < sorted.size - 1) HorizontalDivider(color = WF.colors.hair)
                    }
                }
            }

            UseUpCard(
                items = useUp,
                input = useUpInput,
                onInputChange = { model.useUpInput.value = it },
                onAdd = model::addUseUp,
                onRemove = model::removeUseUp,
            )

            WaffledFieldCard(title = "Keep in mind") {
                WaffledTextField(
                    value = keepInMind,
                    onValueChange = { model.keepInMind.value = it },
                    placeholder = "e.g. school nights are hectic · no pork",
                    singleLine = false,
                )
            }
            Spacer(Modifier.size(WF.spacing.xxl))
        }
        PlanApplyBar(
            isBusy = false,
            isInactive = weekdays.isEmpty(),
            isDisabled = weekdays.isEmpty(),
            label = "✨ Plan $monthLabel",
            onClick = onSuggest,
        )
    }
}

@Composable
private fun MonthReview(
    model: PlanMonthModel,
    recipePicker: @Composable (onPick: (RecipeRef) -> Unit, onDismiss: () -> Unit) -> Unit,
    onApply: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val suggestions by model.suggestions.collectAsStateWithLifecycle()
    val locked by model.locked.collectAsStateWithLifecycle()
    val drafting by model.draftingDates.collectAsStateWithLifecycle()
    val redrafting by model.redrafting.collectAsStateWithLifecycle()
    val applying by model.applying.collectAsStateWithLifecycle()
    val via by model.via.collectAsStateWithLifecycle()
    val notice by model.notice.collectAsStateWithLifecycle()
    val plannedDates by model.plannedDates.collectAsStateWithLifecycle()
    val dirty by model.dirty.collectAsStateWithLifecycle()
    val collapsed by model.collapsedWeeks.collectAsStateWithLifecycle()

    val groups = remember(suggestions) { model.weekGroups(suggestions) }

    var pickDate by remember { mutableStateOf<String?>(null) }
    var moveCard by remember { mutableStateOf<PlanCardDTO?>(null) }

    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.weight(1f),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item(key = "review-header") {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Your month", style = WF.type.sectionTitle, color = WF.colors.ink)
                        val subtitle = buildList {
                            via?.let { add("Drafted via ${MealPlanText.viaLabel(it)}") }
                            if (plannedDates.isNotEmpty()) add("${plannedDates.size} already planned")
                        }.joinToString(" · ")
                        if (subtitle.isNotEmpty()) {
                            Text(subtitle, style = WF.type.micro, color = WF.colors.ink3)
                        }
                    }
                    PlanReshuffleButton(
                        isBusy = redrafting && drafting.size > 1,
                        isDisabled = redrafting || model.unlockedDates.isEmpty(),
                        onClick = { scope.launch { model.reshuffle() } },
                    )
                }
            }
            notice?.let { text -> item(key = "notice") { PlanNotice(text) } }

            groups.forEach { (key, cards) ->
                val isCollapsed = key in collapsed
                item(key = "week-$key") {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(WF.radius.sm))
                            .clickable { model.toggleWeek(key) }
                            .padding(horizontal = 4.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        DisclosureChevron(isOpen = !isCollapsed)
                        Text(
                            "Week of ${MealsFormat.reviewWeekLabel(key)}",
                            style = WF.type.sectionLabel,
                            color = WF.colors.ink2,
                        )
                        Spacer(Modifier.weight(1f))
                        Text("${cards.size}", style = WF.type.micro, color = WF.colors.ink3)
                    }
                }
                if (!isCollapsed) {
                    items(cards.size, key = { cards[it].date }) { index ->
                        val card = cards[index]
                        val isLocked = card.date in locked
                        MealPlanReviewCard(
                            card = card,
                            dayLabel = MealsFormat.reviewDayLabel(card.date),
                            isLocked = isLocked,
                            isBusy = card.date in drafting,
                            metaTags = buildList {
                                card.minutes?.let { add("🕐 ${it}m") }
                                add(if (card.recipeId != null) "📖 Library" else "✨ Special")
                                // A night that was already planned and hasn't been edited
                                // is deliberately left alone by the apply.
                                if (card.date in plannedDates && card.date !in dirty) {
                                    add("Was planned")
                                } else {
                                    card.note?.takeIf(String::isNotEmpty)?.let(::add)
                                }
                            },
                            belowTitleNote = null,
                            actionsDisabled = redrafting || isLocked,
                            onSwap = { scope.launch { model.swap(card) } },
                            onPick = { pickDate = card.date },
                            onMove = { moveCard = card },
                            onToggleLock = { model.toggleLock(card.date) },
                            onSkip = { model.skip(card) },
                        )
                    }
                }
            }
            item(key = "review-hint") {
                Text(
                    "Tap a week to collapse it · lock / swap / pick / move · ✕ to skip.",
                    style = WF.type.caption,
                    color = WF.colors.ink3,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        PlanApplyBar(
            isBusy = applying,
            isInactive = suggestions.isEmpty(),
            isDisabled = suggestions.isEmpty() || applying || redrafting,
            label = if (applying) "Saving…" else "Save month & build list",
            onClick = onApply,
        )
    }

    pickDate?.let { date ->
        recipePicker(
            { recipe ->
                model.pick(date, recipe)
                pickDate = null
            },
            { pickDate = null },
        )
    }

    moveCard?.let { card ->
        MovePlanCardSheet(
            card = card,
            others = suggestions.filterNot { it.date == card.date || it.date in locked },
            onPick = { target ->
                model.moveCard(card.date, target.date)
                moveCard = null
            },
            onDismiss = { moveCard = null },
        )
    }
}

/**
 * A menu pill backed by a list of options.
 *
 * `WaffledMenuPill` is the shared label; the menu behind it is the same `DropdownMenu`
 * family the rest of the app uses.
 */
@Composable
private fun <T> OptionPill(
    label: String,
    options: List<Pair<T, String>>,
    onSelect: (T) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        WaffledMenuPill(
            text = label,
            modifier = Modifier
                .clip(RoundedCornerShape(WF.radius.pill))
                .clickable { open = true },
        )
        MealRowMenu(
            expanded = open,
            onDismiss = { open = false },
            items = options.map { (value, text) ->
                MenuAction(text, Icons.Filled.Check, onClick = { onSelect(value) })
            },
        )
    }
}

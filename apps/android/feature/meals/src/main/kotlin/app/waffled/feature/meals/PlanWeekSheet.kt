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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledFieldCard
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.WeekdayToggleChip
import app.waffled.core.model.RecipeRef
import kotlinx.coroutines.launch
import java.time.LocalDate

/**
 * The AI "Plan my week ✨" flow.
 *
 * A short config (meal · days · who you're cooking for · use-up · try-something-new ·
 * keep-in-mind) → one draft call → a review of per-night cards the user curates: **lock**
 * a night, **swap** to re-roll it, **pick** a recipe by hand, **move** it onto another
 * night, or **reshuffle** everything unlocked. Nothing is saved until Add.
 *
 * Phone layout only — iOS also has a two-column iPad sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlanWeekSheet(
    start: String,
    weekDays: List<LocalDate>,
    familySize: Int,
    libraryRecipes: List<RecipeRef>,
    householdWeekStart: HouseholdWeekStart?,
    api: MealsApi,
    recipePicker: @Composable (onPick: (RecipeRef) -> Unit, onDismiss: () -> Unit) -> Unit,
    onApplied: () -> Unit,
    onDismiss: () -> Unit,
) {
    val model = remember(start) {
        PlanWeekModel(
            api = api, libraryRecipes = libraryRecipes, householdWeekStart = householdWeekStart,
            familySize = familySize, start = start, weekDays = weekDays,
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
            SheetHeader("Plan my week", onDismiss)
            when (phase) {
                PlanPhase.Config -> WeekConfig(model) { scope.launch { model.suggest() } }
                PlanPhase.Loading -> PlanLoadingView(
                    "Drafting your week…",
                    "Asking the kitchen AI — this can take a moment on a local model.",
                )
                PlanPhase.Review -> WeekReview(model, recipePicker) {
                    scope.launch {
                        model.apply()
                        onApplied()
                        onDismiss()
                    }
                }
                PlanPhase.Empty -> PlanMessageView(
                    "🎉",
                    "Every night this week is already planned.",
                    "Nothing to suggest — you're all set.",
                )
                PlanPhase.Failed -> {
                    val message by model.errorMessage.collectAsStateWithLifecycle()
                    PlanMessageView(
                        "😕",
                        "Couldn't plan the week",
                        message ?: "The AI provider didn't respond. Try again.",
                        onRetry = model::backToConfig,
                    )
                }
            }
        }
    }
}

/** The Cancel · title bar every plan sheet shares. */
@Composable
internal fun SheetHeader(title: String, onDismiss: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "Cancel",
            style = WF.type.label,
            color = WF.colors.primary,
            modifier = Modifier
                .clip(RoundedCornerShape(WF.radius.pill))
                .clickable(onClick = onDismiss)
                .padding(horizontal = 8.dp, vertical = 6.dp),
        )
        Spacer(Modifier.weight(1f))
        Text(title, style = WF.type.cardTitle, color = WF.colors.ink)
        Spacer(Modifier.weight(1f))
        // Balances the Cancel label so the title stays centred.
        Spacer(Modifier.size(56.dp))
    }
}

@Composable
private fun WeekConfig(model: PlanWeekModel, onSuggest: () -> Unit) {
    val mealType by model.mealType.collectAsStateWithLifecycle()
    val selectedDays by model.selectedDays.collectAsStateWithLifecycle()
    val cookingFor by model.cookingFor.collectAsStateWithLifecycle()
    val useUp by model.useUp.collectAsStateWithLifecycle()
    val useUpInput by model.useUpInput.collectAsStateWithLifecycle()
    val wantToTry by model.wantToTry.collectAsStateWithLifecycle()
    val wantToTryInput by model.wantToTryInput.collectAsStateWithLifecycle()
    val trySomethingNew by model.trySomethingNew.collectAsStateWithLifecycle()
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
                "Tell Waffled the guardrails — it drafts the meals and the grocery list in one go.",
                style = WF.type.body,
                color = WF.colors.ink3,
            )

            WaffledFieldCard(title = "Plan which meal?") {
                SegmentedRow(
                    options = listOf("breakfast", "lunch", "dinner"),
                    selected = mealType,
                    label = MealsFormat::slotLabel,
                    onSelect = { model.mealType.value = it },
                )
            }

            WaffledFieldCard(title = "Which days?") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    model.days.forEach { day ->
                        val key = MealsFormat.ymd(day)
                        WeekdayToggleChip(
                            label = MealsFormat.weekdayShort(day).lowercase().replaceFirstChar { it.uppercase() },
                            isOn = key in selectedDays,
                            onClick = { model.toggleDay(key) },
                        )
                    }
                }
            }

            PlanConfigCard {
                CookingForRow(cookingFor, model.familySize) { model.cookingFor.value = it }
            }

            UseUpCard(
                items = useUp,
                input = useUpInput,
                onInputChange = { model.useUpInput.value = it },
                onAdd = model::addUseUp,
                onRemove = model::removeUseUp,
            )

            PlanConfigCard {
                PlanConfigRow(
                    label = "Try something new",
                    subtitle = "Work at least one brand-new dish into the week.",
                ) {
                    WaffledSwitch(trySomethingNew) { model.trySomethingNew.value = it }
                }
            }

            UseUpCard(
                items = wantToTry,
                input = wantToTryInput,
                onInputChange = { model.wantToTryInput.value = it },
                onAdd = model::addWantToTry,
                onRemove = model::removeWantToTry,
                title = "Dishes to try",
                placeholder = "Add a dish to try",
            )

            WaffledFieldCard(title = "Keep in mind") {
                WaffledTextField(
                    value = keepInMind,
                    onValueChange = { model.keepInMind.value = it },
                    placeholder = "e.g. Lottie skips spicy · Tue & Thu are busy",
                    singleLine = false,
                )
            }
            Spacer(Modifier.size(WF.spacing.xxl))
        }
        PlanApplyBar(
            isBusy = false,
            isDisabled = selectedDays.isEmpty(),
            label = "✨ Plan my week",
            onClick = onSuggest,
        )
    }
}

@Composable
private fun WeekReview(
    model: PlanWeekModel,
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
                        Text("Here's your week", style = WF.type.sectionTitle, color = WF.colors.ink)
                        via?.let {
                            Text(
                                "Drafted via ${MealPlanText.viaLabel(it)}",
                                style = WF.type.micro,
                                color = WF.colors.ink3,
                            )
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
            items(suggestions, key = { it.date }) { card ->
                val isLocked = card.date in locked
                MealPlanReviewCard(
                    card = card,
                    dayLabel = MealsFormat.reviewDayLabel(card.date),
                    isLocked = isLocked,
                    isBusy = card.date in drafting,
                    metaTags = buildList {
                        card.minutes?.let { add("🕐 ${it}m") }
                        add(if (card.recipeId != null) "📖 From library" else "✨ New dish")
                    },
                    belowTitleNote = card.note,
                    actionsDisabled = redrafting || isLocked,
                    onSwap = { scope.launch { model.swap(card) } },
                    onPick = { pickDate = card.date },
                    onMove = { moveCard = card },
                    onToggleLock = { model.toggleLock(card.date) },
                )
            }
            item(key = "review-hint") {
                Text(
                    "Lock the nights you love, swap or pick the rest.",
                    style = WF.type.caption,
                    color = WF.colors.ink3,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        PlanApplyBar(
            isBusy = applying,
            isDisabled = suggestions.isEmpty() || applying || redrafting,
            label = if (applying) "Adding…" else "Add ${suggestions.size} & build list",
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
 * Move a review card onto another night — the replacement for the iOS card drag.
 *
 * Locked nights are filtered out by the caller rather than shown and refused, so the list
 * only offers moves that will actually happen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MovePlanCardSheet(
    card: PlanCardDTO,
    others: List<PlanCardDTO>,
    onPick: (PlanCardDTO) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp)) {
            Text("Swap with…", style = WF.type.sectionTitle, color = WF.colors.ink)
            Spacer(Modifier.size(8.dp))
            PlanCardChip(card.emoji, card.title)
            Spacer(Modifier.size(14.dp))
            LazyColumn(Modifier.fillMaxWidth()) {
                items(others, key = { it.date }) { other ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(WF.radius.sm))
                            .clickable { onPick(other) }
                            .padding(horizontal = 12.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(MealsFormat.reviewDayLabel(other.date), style = WF.type.micro, color = WF.colors.ink3)
                            Text(other.title, style = WF.type.label, color = WF.colors.ink)
                        }
                    }
                }
            }
            Spacer(Modifier.size(WF.spacing.tabBarClearance))
        }
    }
}

/**
 * A segmented picker.
 *
 * Hand-rolled rather than Material3's `SegmentedButton`: the app installs no
 * `MaterialTheme`, so every M3 control renders from the baseline colour scheme unless each
 * of its colours is overridden — and `SegmentedButtonDefaults` has more of them than this
 * is worth. `core:design` has no segmented control to reuse; it is the obvious candidate
 * to add, since the meals shell needs one too.
 */
@Composable
internal fun SegmentedRow(
    options: List<String>,
    selected: String,
    label: (String) -> String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(WF.radius.md))
            .background(WF.colors.panel)
            .padding(3.dp),
    ) {
        options.forEach { option ->
            val isOn = option == selected
            Box(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(WF.radius.sm))
                    .background(if (isOn) WF.colors.card else Color.Transparent)
                    .clickable { onSelect(option) }
                    .padding(vertical = 9.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label(option),
                    style = TextStyle(
                        fontSize = 14.sp,
                        fontWeight = if (isOn) FontWeight.Bold else FontWeight.Medium,
                    ),
                    color = if (isOn) WF.colors.ink else WF.colors.ink3,
                )
            }
        }
    }
}

/** M3's `Switch`, with the colours the app's own theme would have supplied. */
@Composable
internal fun WaffledSwitch(checked: Boolean, onChange: (Boolean) -> Unit) {
    Switch(
        checked = checked,
        onCheckedChange = onChange,
        colors = SwitchDefaults.colors(
            checkedThumbColor = Color.White,
            checkedTrackColor = WF.colors.ai,
            uncheckedThumbColor = WF.colors.card,
            uncheckedTrackColor = WF.colors.panel,
            uncheckedBorderColor = WF.colors.hair,
        ),
    )
}

/** "Cooking for" — the whole family, or an explicit head count. */
@Composable
internal fun CookingForRow(cookingFor: Int, familySize: Int, onSelect: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    PlanConfigRow(label = "Cooking for") {
        Box {
            app.waffled.core.design.WaffledMenuPill(
                text = if (cookingFor == 0) "$familySize · whole family" else "$cookingFor",
                modifier = Modifier
                    .clip(RoundedCornerShape(WF.radius.pill))
                    .clickable { open = true },
            )
            MealRowMenu(
                expanded = open,
                onDismiss = { open = false },
                items = buildList {
                    add(
                        MenuAction(
                            "$familySize · whole family",
                            Icons.Filled.Group,
                            onClick = { onSelect(0) },
                        ),
                    )
                    (1..8).forEach { n ->
                        add(
                            MenuAction(
                                "$n",
                                Icons.Filled.Person,
                                onClick = { onSelect(n) },
                            ),
                        )
                    }
                },
            )
        }
    }
}

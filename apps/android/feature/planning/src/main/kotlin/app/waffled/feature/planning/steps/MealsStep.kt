package app.waffled.feature.planning.steps

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.Pill
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledImages
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.colorFromHex
import app.waffled.core.design.wfChip
import app.waffled.core.model.Capability
import app.waffled.core.model.HouseholdWeekStart
import app.waffled.core.model.RecipeRef
import app.waffled.core.network.MediaUrl
import app.waffled.feature.lists.ListsApi
import app.waffled.feature.meals.MealsApi
import app.waffled.feature.meals.PlanWeekSheet
import app.waffled.feature.planning.PlanningEnvironment
import app.waffled.feature.planning.PlanningStepProps
import app.waffled.feature.planning.api.PlanningMealsApi
import app.waffled.feature.planning.planningOptionChrome
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch

/** The one place the Meals model is built, so the body and the footer build the same thing. */
internal fun mealsStepModel(props: PlanningStepProps): PlanningMealsModel =
    PlanningMealsStepStore.model(props.sessionId, props.weekStart) { newMealsModel(props.env) }

private fun newMealsModel(env: PlanningEnvironment): PlanningMealsModel {
    val api = PlanningMealsApi(env.http)
    val meals = MealsApi(env.client, env.tokens)
    val lists = ListsApi(env.client, env.tokens)
    val type = PlanningMealsModel.MEAL_TYPE
    return PlanningMealsModel(
        fetchView = { week, chore -> api.view(week, chore) },
        fill = { week, cards -> api.fill(week, cards) },
        undo = { week, filled -> api.undo(week, filled) },
        setShopper = { week, dueOn, personId, dueTime, chore -> api.setShopper(week, dueOn, personId, dueTime, chore) },
        planSlot = { date, recipeId, title -> meals.planMeal(date, type, recipeId = recipeId, title = title) },
        planPlate = { date, mealId -> meals.scheduleMeal(mealId, date, type) },
        clearSlot = { date -> meals.clearMeal(date, type) },
        addGrocery = { name -> lists.addGroceryItem(name) },
        fetchGroceries = { week -> lists.groceryBoard(week).items },
        checkGrocery = { id, checked -> lists.patchItem(id, checked = checked) },
    )
}

/**
 * Weekly Planning · step 7 "Meals" — seven nights, each with ITS EVENTS ABOVE ITS DISH.
 * Port of iOS `MealsStepView`. The step owns no data: a tap on a night writes through the
 * Meals screen's own routes, and the fill lives in the footer, which is why the model sits
 * in [PlanningMealsStepStore]. No outer scroll — the shell owns it.
 */
@Composable
fun MealsStepBody(props: PlanningStepProps) {
    val storeKey = PlanningMealsStepStore.key(props.sessionId, props.weekStart)
    val model = remember(storeKey) { mealsStepModel(props) }
    val state by model.state.collectAsState()
    val env = props.env
    val members by env.sync.members.collectAsState()
    val me by env.sync.currentPerson.collectAsState()
    val scope = rememberCoroutineScope()
    val library = remember(env) { PlanningMealsLibrary(PlanningMealsApi(env.http), MealsApi(env.client, env.tokens)) }

    var editing by remember(storeKey) { mutableStateOf<String?>(null) }
    var shopping by remember(storeKey) { mutableStateOf(false) }
    var groceryList by remember { mutableStateOf(false) }
    val frozen = props.busy || state.busy

    LaunchedEffect(storeKey) { model.enter(props.weekStart, PlanningMealsCrumb.dates(props.step.data)) }
    // One push after every applied read and landed write; null passes straight through here
    // (unlike Goals) because it is the real answer "the app picked nothing".
    LaunchedEffect(state.rev) { props.setDecisionData(state.crumb) }
    // The BODY reports the fill's busy: it is stable for the whole step, while the footer
    // swaps controls mid-write.
    LaunchedEffect(state.busy) { props.reportBusy(state.busy) }
    DisposableEffect(storeKey) {
        // This step lends the banner nothing: no composer that would really act on a note.
        props.lendVerb(null)
        onDispose {
            props.reportBusy(false)
            props.lendVerb(null)
        }
    }

    fun write(work: suspend () -> Boolean) {
        scope.launch { if (work()) props.refresh() }
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        state.errorMessage?.let { DismissibleErrorBanner(message = it, onDismiss = model::dismissError) }
        when {
            !state.loaded -> WaffledLoading()
            state.view == null -> WaffledEmptyState(
                emoji = "🍽️",
                title = "Couldn’t read this week’s meals",
                message = "Reload, or skip this step — skipping is a real answer.",
            )
            else -> {
                state.rows.forEach { row -> NightCard(row, frozen, env.baseUrl) { editing = row.date } }
                state.view?.groceries?.let { g ->
                    GroceryLine(
                        state = state,
                        groceries = g,
                        frozen = frozen,
                        onAdd = { name -> model.addGrocery(name, props.weekStart) },
                        onOpenList = { groceryList = true },
                        onOpenShopper = { shopping = true },
                    )
                }
                PlanningMealsText.keptSentence(state.kept)?.let {
                    Text(it, style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink2)
                }
            }
        }
    }

    state.rows.firstOrNull { it.date == editing }?.let { night ->
        MealsStepNightPicker(
            night = night,
            library = library,
            baseUrl = env.baseUrl,
            onPickRecipe = { id -> write { model.planNight(props.weekStart, night.date, recipeId = id, title = null) } },
            onPickPlate = { id -> write { model.planNightAsPlate(props.weekStart, night.date, id) } },
            onPickTitle = { title -> write { model.planNight(props.weekStart, night.date, recipeId = null, title = title) } },
            onClear = { write { model.clearNight(props.weekStart, night.date) } },
            onDismiss = { editing = null },
        )
    }

    if (groceryList) {
        MealsStepGroceryListSheet(model = model, weekStart = props.weekStart, onDismiss = { groceryList = false })
    }

    if (shopping) {
        MealsStepShopperSheet(
            weekStart = props.weekStart,
            nights = state.rows,
            trip = state.view?.shopping,
            people = members,
            myPersonId = me?.id,
            canManage = me?.can(Capability.CHORE_MANAGE) == true,
            busy = frozen,
            onSave = { dueOn, personId, dueTime ->
                write { model.setShopper(props.weekStart, dueOn, personId, dueTime) }
            },
            onDismiss = { shopping = false },
        )
    }

    // THE PLANNER IS PRESENTED FROM THE BODY though its button is in the footer: the footer
    // swaps controls once a fill lands, so a sheet there would hang off a vanishing control.
    if (state.plannerOpen) {
        val libState by library.state.collectAsState()
        LaunchedEffect(Unit) { library.load() }
        val weekStart by env.sync.householdWeekStart.collectAsState()
        PlanWeekSheet(
            start = props.weekStart,
            weekDays = PlanningMealsPlan.plannerDays(state.emptyDates),
            familySize = maxOf(1, members.size),
            libraryRecipes = remember(libState.recipes) {
                libState.recipes.map { RecipeRef(it.id, it.title, it.emoji, it.imageUrl) }
            },
            householdWeekStart = HouseholdWeekStart.parse(weekStart),
            api = remember(env) { MealsApi(env.client, env.tokens) },
            recipePicker = { onPick, onDismiss ->
                PlanningRecipePickerSheet(library = library, baseUrl = env.baseUrl, onDismiss = onDismiss) { recipe ->
                    onPick(RecipeRef(recipe.id, recipe.title, recipe.emoji, recipe.imageUrl))
                }
            },
            onApplied = {},
            onDismiss = { model.setPlanner(false) },
            mealTypes = listOf(PlanningMealsModel.MEAL_TYPE),
            initialDays = state.emptyDates,
            note = PlanningMealsText.plannerNote(state.emptyDates.size),
            onApply = { cards ->
                val landed = model.applyPlan(props.weekStart, cards)
                if (landed) props.refresh()
                landed
            },
        )
    }
}

@Composable
private fun NightCard(row: PlanningMealsNightRow, frozen: Boolean, baseUrl: String, onTap: () -> Unit) {
    WaffledCard(padding = 13.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(row.dow, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.ExtraBold), color = WF.colors.ink)
                Text(row.monthDay, style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
            }
            // The events come FIRST — they are the context that decides the night.
            if (row.events.isEmpty()) {
                Text("Nothing on", style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    row.events.forEach { e ->
                        Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(7.dp).background(colorFromHex(e.colorHex) ?: WF.colors.ink3, CircleShape))
                            Text(
                                e.title,
                                modifier = Modifier.weight(1f),
                                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                                color = WF.colors.ink2,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(e.clock, style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
                        }
                    }
                }
            }
            Dish(row, frozen, baseUrl, onTap)
        }
    }
}

/** Four states legible at a glance: planned, empty, auto-filled, eating out. */
@Composable
private fun Dish(row: PlanningMealsNightRow, frozen: Boolean, baseUrl: String, onTap: () -> Unit) {
    val dinner = row.dinner
    Row(
        Modifier
            .fillMaxWidth()
            .alpha(if (frozen) 0.6f else 1f)
            .planningOptionChrome(selected = row.auto, tint = WF.colors.ai)
            .clickable(enabled = !frozen, onClick = onTap)
            .semantics {
                contentDescription = dinner?.let { "${it.title ?: "Planned"} on ${row.dow} — change it" } ?: "Plan ${row.dow}"
            }
            .padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (dinner != null) {
            DishThumb(dinner.imageUrl, dinner.emoji ?: row.fallbackEmoji, baseUrl)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    dinner.title ?: "Planned",
                    style = TextStyle(fontSize = 14.5.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                row.attribution?.let {
                    Text(it, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3, maxLines = 1)
                }
            }
            if (row.auto) WaffledStatusBadge(text = "✨ auto", color = WF.colors.ai)
        } else {
            WaffledEmojiTile(emoji = "＋", size = 20.dp, frame = 44.dp)
            Text(
                "Nothing planned",
                modifier = Modifier.weight(1f),
                style = TextStyle(fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink2,
            )
        }
    }
}

/** The dish photo through the shared Coil loader (memory-cached), else its emoji tile. */
@Composable
internal fun DishThumb(imageUrl: String?, emoji: String, baseUrl: String) {
    val url = MediaUrl.resolve(imageUrl, baseUrl)
    val shape = RoundedCornerShape(12.dp)
    if (url == null) {
        WaffledEmojiTile(emoji = emoji, size = 22.dp, frame = 44.dp)
    } else {
        AsyncImage(
            model = WaffledImages.request(LocalContext.current, url, MediaUrl.cacheKey(imageUrl)),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.size(44.dp).clip(shape).background(WF.colors.panel, shape),
        )
    }
}

/**
 * ONE LINE, not a panel. Adding is a BURST: the field keeps focus (and the keyboard) after
 * each item, so it is never disabled by a write and an add never refreshes the shell —
 * either would drop focus.
 */
@Composable
private fun GroceryLine(
    state: PlanningMealsState,
    groceries: app.waffled.feature.planning.api.PlanningMealsGroceries,
    frozen: Boolean,
    onAdd: suspend (String) -> Boolean,
    onOpenList: () -> Unit,
    onOpenShopper: () -> Unit,
) {
    var draft by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    fun add() {
        val name = draft
        if (name.isBlank()) return
        scope.launch {
            if (onAdd(name)) {
                draft = ""
                runCatching { focus.requestFocus() }
            }
        }
    }

    WaffledCard(padding = 13.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("🛒", fontSize = 17.sp)
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("Groceries", style = TextStyle(fontSize = 14.5.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                    Text(PlanningMealsText.grocerySub(state.groceryAdded), style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
                }
            }
            Pill(
                text = PlanningMealsText.groceryPill(groceries),
                modifier = Modifier
                    .clip(RoundedCornerShape(WF.radius.pill))
                    .clickable(onClick = onOpenList)
                    .semantics { contentDescription = "${PlanningMealsText.groceryPill(groceries)}. Opens this week’s grocery list" },
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                WaffledTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.weight(1f).focusRequester(focus),
                    placeholder = "Add to groceries…",
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    // Done adds and keeps the keyboard up, rather than closing it.
                    keyboardActions = KeyboardActions(onDone = { add() }),
                )
                val canAdd = !frozen && draft.isNotBlank()
                Text(
                    "Add",
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(if (canAdd) WF.colors.primary else WF.colors.primary.copy(alpha = 0.4f))
                        .clickable(enabled = canAdd) { add() }
                        .padding(horizontal = 18.dp, vertical = 12.dp),
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                    // White on a saturated primary fill, which stays saturated in dark.
                    color = androidx.compose.ui.graphics.Color.White,
                )
            }
            // The trip is a REAL one-off chore; with chores off the control goes away.
            if (state.view?.choresOn == true) {
                val trip = state.view.shopping
                Text(
                    PlanningMealsText.tripLabel(trip),
                    modifier = Modifier
                        .wfChip(selected = trip != null)
                        .clickable(enabled = !frozen, onClick = onOpenShopper)
                        .padding(horizontal = 13.dp, vertical = 8.dp),
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                    color = if (trip == null) WF.colors.primary else WF.colors.ink,
                )
            }
            Spacer(Modifier.size(0.dp))
        }
    }
}


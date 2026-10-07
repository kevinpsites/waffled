package app.waffled.feature.planning.steps

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledFieldCard
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.wfChip
import app.waffled.core.model.Person
import app.waffled.feature.lists.ListItemDTO
import app.waffled.feature.meals.LibraryEntry
import app.waffled.feature.meals.LibraryFilter
import app.waffled.feature.meals.LibraryFilters
import app.waffled.feature.meals.LibraryType
import app.waffled.feature.meals.MealDTO
import app.waffled.feature.meals.MealsApi
import app.waffled.feature.meals.RecipeSummary
import app.waffled.feature.planning.api.PlanningMealsApi
import app.waffled.feature.planning.api.PlanningMealsShopper
import app.waffled.feature.planning.api.PlanningShoppingTrip
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

// Weekly Planning · step 7 (Meals) — the surfaces a night opens. iOS uses the recipes
// feature's own library screen in pick mode; that feature is NOT a planning dependency, so
// the night picker is a small stand-in over the same `api/recipes` read and the meals
// module's `LibraryFilter` rules (it also offers plates). The planner's manual pick uses
// the recipes feature's real `RecipePickerSheet`.

/** The recipe + plate library, loaded fresh each time a picker opens (empty is a valid answer). */
class PlanningMealsLibrary(private val api: PlanningMealsApi, private val meals: MealsApi) {
    data class State(
        val loaded: Boolean = false,
        val recipes: List<RecipeSummary> = emptyList(),
        val plates: List<MealDTO> = emptyList(),
        val haystacks: Map<String, String> = emptyMap(),
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    suspend fun load() {
        val recipes = attempt { api.recipes() } ?: _state.value.recipes
        val plates = attempt { meals.savedMeals() } ?: _state.value.plates
        _state.value = State(true, recipes, plates, LibraryFilter.haystacks(recipes, plates))
    }

    private suspend fun <T> attempt(call: suspend () -> T): T? = try {
        call()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }
}

/**
 * What a tap on a night opens. The three placeholder chips write exactly the literals the
 * Meals screen writes, so a night planned here and there is the same row.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun MealsStepNightPicker(
    night: PlanningMealsNightRow,
    library: PlanningMealsLibrary,
    baseUrl: String,
    onPickRecipe: (String) -> Unit,
    onPickPlate: (String) -> Unit,
    onPickTitle: (String) -> Unit,
    onClear: () -> Unit,
    onDismiss: () -> Unit,
) {
    var freeText by remember(night.date) { mutableStateOf("") }
    fun submitFreeText() {
        val title = freeText.trim()
        if (title.isEmpty()) return
        onPickTitle(title)
        onDismiss()
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("${night.dow} dinner · ${night.monthDay}", style = WF.type.serif(18.sp), color = WF.colors.ink)
                Text(
                    night.dinner?.let { "Currently ${it.title ?: "planned"}" } ?: "Nothing planned yet",
                    style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PLACEHOLDERS.forEach { (emoji, title) ->
                    Text(
                        "$emoji $title",
                        modifier = Modifier
                            .wfChip(selected = false)
                            .clickable {
                                onPickTitle(title)
                                onDismiss()
                            }
                            .padding(horizontal = 12.dp, vertical = 7.dp),
                        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink,
                    )
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                WaffledTextField(
                    value = freeText,
                    onValueChange = { freeText = it },
                    modifier = Modifier.weight(1f),
                    placeholder = "Or name it yourself…",
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { submitFreeText() }),
                )
                if (freeText.isNotBlank()) {
                    Text(
                        "Plan it",
                        modifier = Modifier.clickable { submitFreeText() }.padding(6.dp),
                        style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.primary,
                    )
                }
            }
            if (night.dinner != null) {
                Text(
                    "Clear this night",
                    modifier = Modifier.clickable {
                        onClear()
                        onDismiss()
                    },
                    style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.danger,
                )
            }
            HorizontalDivider(color = WF.colors.hair)
            LibraryList(
                library = library,
                baseUrl = baseUrl,
                types = LibraryType.entries,
                onPick = { entry ->
                    when (entry) {
                        is LibraryEntry.Recipe -> onPickRecipe(entry.id)
                        is LibraryEntry.Meal -> onPickPlate(entry.id)
                    }
                    onDismiss()
                },
            )
        }
    }
}

/** EXACTLY the literals the Meals screen writes, so its classifiers read them the same. */
private val PLACEHOLDERS = listOf("🥡" to "Eating out", "🍱" to "Leftovers", "✨" to "Try something new")

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LibraryList(
    library: PlanningMealsLibrary,
    baseUrl: String,
    types: List<LibraryType>,
    onPick: (LibraryEntry) -> Unit,
) {
    val state by library.state.collectAsState()
    LaunchedEffect(Unit) { library.load() }
    var query by remember { mutableStateOf("") }
    var type by remember { mutableStateOf(types.first()) }
    val entries = remember(state, query, type) {
        LibraryFilter.entries(state.recipes, state.plates, LibraryFilters(query = query, type = type), state.haystacks)
    }

    WaffledTextField(value = query, onValueChange = { query = it }, placeholder = "Search recipes and plates")
    if (types.size > 1) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            types.forEach { t ->
                Text(
                    t.chip,
                    modifier = Modifier
                        .wfChip(selected = t == type)
                        .clickable { type = t }
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                    color = if (t == type) WF.colors.primary else WF.colors.ink2,
                )
            }
        }
    }
    when {
        !state.loaded -> WaffledLoading(top = 16.dp)
        entries.isEmpty() -> Text(
            if (state.recipes.isEmpty() && state.plates.isEmpty()) "No recipes yet." else "Nothing matches.",
            style = TextStyle(fontSize = 13.sp),
            color = WF.colors.ink3,
        )
        else -> LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(entries, key = { (if (it.isMeal) "m:" else "r:") + it.id }) { entry ->
                val (emoji, image) = when (entry) {
                    is LibraryEntry.Recipe -> (entry.recipe.emoji ?: "🍽️") to entry.recipe.imageUrl
                    is LibraryEntry.Meal -> (entry.meal.emojis.firstOrNull() ?: "🍽️") to null
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onPick(entry) }
                        .padding(vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(11.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    DishThumb(image, emoji, baseUrl)
                    Column(Modifier.weight(1f)) {
                        Text(
                            entry.title,
                            style = TextStyle(fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        val sub = listOfNotNull(
                            if (entry.isMeal) "a whole plate" else null,
                            entry.totalMinutes?.takeIf { it > 0 }?.let { "$it min" },
                        ).joinToString(" · ")
                        if (sub.isNotEmpty()) Text(sub, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
                    }
                }
            }
        }
    }
}

/**
 * Who's shopping, and when. Saving writes a REAL one-off chore; `dueOn` null is "no trip
 * this week", which removes the chore rather than leaving one nobody planned.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun MealsStepShopperSheet(
    weekStart: String,
    nights: List<PlanningMealsNightRow>,
    trip: PlanningShoppingTrip?,
    people: List<Person>,
    myPersonId: String?,
    /** `chore.manage`: handing the trip to somebody ELSE needs it; yourself or nobody doesn't. */
    canManage: Boolean,
    busy: Boolean,
    onSave: (dueOn: String?, personId: String?, dueTime: String?) -> Unit,
    onDismiss: () -> Unit,
) {
    var personId by remember { mutableStateOf(trip?.personId) }
    // Default to the LAST night of the week: pencilled in beats blank, one tap to change.
    var dueOn by remember { mutableStateOf(trip?.dueOn ?: nights.lastOrNull()?.date ?: weekStart) }
    var hasTime by remember { mutableStateOf(trip?.dueTime != null) }
    val (h, m) = remember { parseClock(trip?.dueTime) }
    val time = rememberTimePickerState(initialHour = h, initialMinute = m)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("The shopping trip", style = WF.type.serif(18.sp), color = WF.colors.ink)
            Text(
                "It lands on the Tasks board as a real assignment — leaving it up for grabs is a real answer.",
                style = TextStyle(fontSize = 13.sp),
                color = WF.colors.ink2,
            )
            WaffledFieldCard(title = "Who’s going") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    PersonChip(null, "Up for grabs", null, personId, myPersonId, canManage) { personId = it }
                    people.forEach { p -> PersonChip(p.id, p.name, p.avatarEmoji, personId, myPersonId, canManage) { personId = it } }
                }
                if (!canManage) {
                    Text("Only a parent can hand the shopping to somebody else.", style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
                }
            }
            WaffledFieldCard(title = "Which day") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    nights.forEach { night ->
                        val on = dueOn == night.date
                        Text(
                            night.dow,
                            modifier = Modifier
                                .wfChip(selected = on)
                                .clickable { dueOn = night.date }
                                .padding(horizontal = 13.dp, vertical = 7.dp),
                            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                            color = if (on) WF.colors.primary else WF.colors.ink2,
                        )
                    }
                }
            }
            WaffledFieldCard(title = "What time") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Set a time",
                        modifier = Modifier.weight(1f),
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink,
                    )
                    Switch(checked = hasTime, onCheckedChange = { hasTime = it })
                }
                if (hasTime) TimePicker(state = time)
            }
            if (trip != null) {
                Text(
                    "No trip this week",
                    modifier = Modifier
                        .alpha(if (busy) 0.5f else 1f)
                        .clickable(enabled = !busy) {
                            onSave(null, null, null)
                            onDismiss()
                        },
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.danger,
                )
            }
            WaffledPrimaryCTA(
                label = if (trip == null) "Add it to Tasks" else "Update the trip",
                isBusy = busy,
                onClick = {
                    onSave(dueOn, personId, if (hasTime) hhmm(time.hour, time.minute) else null)
                    onDismiss()
                },
            )
        }
    }
}

@Composable
private fun PersonChip(
    id: String?,
    label: String,
    emoji: String?,
    selected: String?,
    myPersonId: String?,
    canManage: Boolean,
    onSelect: (String?) -> Unit,
) {
    val allowed = PlanningMealsShopper.mayAssign(id, myPersonId, canManage)
    val on = selected == id
    Text(
        listOfNotNull(emoji, label).joinToString(" "),
        modifier = Modifier
            .alpha(if (allowed) 1f else 0.4f)
            .wfChip(selected = on)
            .clickable(enabled = allowed) { onSelect(id) }
            .padding(horizontal = 13.dp, vertical = 7.dp),
        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
        color = if (on) WF.colors.primary else WF.colors.ink2,
    )
}

/** "09:00" → (9, 0), defaulting to a plausible 9am. */
private fun parseClock(hhmm: String?): Pair<Int, Int> {
    val parts = hhmm?.split(":")
    val h = parts?.getOrNull(0)?.toIntOrNull()
    val m = parts?.getOrNull(1)?.toIntOrNull()
    return if (parts?.size == 2 && h != null && m != null) h to m else 9 to 0
}

/** POSIX 24-hour `HH:mm` — the route matches `^\d{2}:\d{2}$` and drops anything else. */
internal fun hhmm(hour: Int, minute: Int): String = "%02d:%02d".format(hour, minute)

/** The planned week's grocery list: tick an item off or put it back. Editing stays on the board. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MealsStepGroceryListSheet(model: PlanningMealsModel, weekStart: String, onDismiss: () -> Unit) {
    val state by model.state.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { model.loadGroceries(weekStart) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("This week’s groceries", style = WF.type.serif(18.sp), color = WF.colors.ink)
            state.groceryError?.let {
                Text(it, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.danger)
            }
            val toBuy = state.groceriesToBuy
            val inCart = state.groceriesInCart
            when {
                state.groceries == null && state.groceryError == null -> WaffledLoading(top = 16.dp)
                toBuy.isEmpty() && inCart.isEmpty() ->
                    Text("Nothing on this week’s list yet.", style = TextStyle(fontSize = 13.sp), color = WF.colors.ink3)
                else -> {
                    WaffledFieldCard(title = "To buy · ${toBuy.size}") {
                        toBuy.forEach { GroceryRow(it) { scope.launch { model.setGroceryChecked(it, weekStart) } } }
                    }
                    if (inCart.isNotEmpty()) {
                        WaffledFieldCard(title = "In the cart · ${inCart.size}") {
                            inCart.forEach { GroceryRow(it) { scope.launch { model.setGroceryChecked(it, weekStart) } } }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GroceryRow(item: ListItemDTO, onToggle: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onToggle)
            .semantics { contentDescription = if (item.checked) "Put ${item.name} back" else "Check off ${item.name}" }
            .padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            if (item.checked) "✓" else "○",
            style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
            color = if (item.checked) WF.colors.success else WF.colors.ink3,
        )
        Text(
            item.name,
            modifier = Modifier.weight(1f),
            style = TextStyle(
                fontSize = 14.5.sp,
                fontWeight = FontWeight.Medium,
                textDecoration = if (item.checked) TextDecoration.LineThrough else null,
            ),
            color = if (item.checked) WF.colors.ink3 else WF.colors.ink,
        )
        item.quantity?.let {
            Text(it, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink2)
        }
    }
}


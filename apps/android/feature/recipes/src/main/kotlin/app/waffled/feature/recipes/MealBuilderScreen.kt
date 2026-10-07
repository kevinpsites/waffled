package app.waffled.feature.recipes

import app.waffled.core.model.HouseholdWeekStart
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.LocalFireDepartment
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledTextField
import app.waffled.core.model.Person
import app.waffled.core.network.MediaUrl
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** How the builder opened. */
sealed interface MealBuilderStart {
    /** A blank plate (the library's "New meal"). */
    data object Fresh : MealBuilderStart

    /** Seeded with one recipe as the main ("Build a meal around this"). */
    data class Around(val recipe: RecipeSummary) : MealBuilderStart

    /** Editing a plate that already exists. */
    data class Editing(val meal: MealDTO) : MealBuilderStart
}

/**
 * **Meal Builder** — compose a plate: a named, multi-recipe meal ("BBQ Sunday" = BBQ
 * Chicken (main) + Potato Salad + Coleslaw (sides) + Peach Cobbler (dessert)).
 *
 * Dishes are grouped by role in one flat run, the name is edited inline, and a pinned ink
 * bar carries the plate stats, the "Keep in library" toggle and the two actions.
 *
 * The plate is created **lazily** ([MealBuilderModel]): opening this screen posts nothing,
 * and every mutation answers with the whole plate, so the screen repaints from the
 * response rather than refetching.
 *
 * **Re-filing a dish is a row menu, not a drag.** Compose has no `.onMove` for a
 * `LazyColumn`, and hand-rolling drag-and-drop is the unbudgeted subproject that burned
 * iOS twice. The drop *rule* is fully ported and tested ([PlateReorder]) so the gesture
 * can be added later without re-deriving anything; the menu writes the same
 * `patchDish` + `reorder` pair a drop would.
 */
@Composable
fun MealBuilderScreen(
    model: MealBuilderModel,
    modifier: Modifier = Modifier,
    start: MealBuilderStart = MealBuilderStart.Fresh,
    /** The household, for the per-dish cook picker. Empty ⇒ no cook control at all. */
    members: List<Person> = emptyList(),
    baseUrl: String = "",
    onDone: () -> Unit = {},
    /**
     * Open the recipe/plate picker for one role. The host supplies it (typically
     * [RecipePickerSheet]) so this screen never owns a second library.
     */
    onAddDish: (PlateRole) -> Unit = {},
    /**
     * Cook the whole plate — every dish at once, each keeping its own place in its own
     * method. The host hands this to `CookSessionStore.startPlate`; it is offered only
     * once the plate exists server-side, because that is what Cook Mode fetches by.
     */
    onCookPlate: ((MealDTO) -> Unit)? = null,
    /** The household's `week_start`, so "This week" in the schedule sheet matches the planner. */
    householdWeekStart: HouseholdWeekStart? = null,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val name by model.nameState.collectAsStateWithLifecycle()
    val message by model.messageState.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var scheduling by remember { mutableStateOf(false) }
    var seeded by remember { mutableStateOf(false) }

    // "Build a meal around this" opens with the recipe already chosen as the main. Adding
    // it is what triggers the lazy create, so there is still exactly one path that
    // creates a plate.
    LaunchedEffect(start) {
        if (seeded) return@LaunchedEffect
        seeded = true
        if (start is MealBuilderStart.Around) model.addRecipe(start.recipe.id, PlateRoles.main)
    }

    // The toast clears itself; leaving it up would make the next action's result
    // ambiguous.
    LaunchedEffect(message) {
        if (message != null) {
            delay(4000)
            model.message = null
        }
    }

    val byId = remember(state.groups) {
        state.groups.flatMap { it.dishes }.associateBy { it.recipeId }
    }
    val rows = remember(state.groups) { PlateReorder.rows(state.groups) }

    Box(modifier.fillMaxSize().background(WF.colors.canvas)) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "Build a meal",
                    Modifier.weight(1f),
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                )
                state.meal?.takeIf { it.recipes.isNotEmpty() }?.let { meal ->
                    onCookPlate?.let { cook ->
                        Text(
                            "👨‍🍳 Cook",
                            Modifier
                                .clickable { cook(meal) }
                                .padding(end = 14.dp),
                            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink2,
                        )
                    }
                }
                Text(
                    "Done",
                    Modifier.clickable(onClick = onDone),
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.primary,
                )
            }

            LazyColumn(
                Modifier.weight(1f),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    start = 16.dp, end = 16.dp, bottom = 16.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .background(WF.colors.card, RoundedCornerShape(WF.radius.md))
                            .padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        // Committed on focus loss / Done, never per keystroke: a debounce
                        // here would race the lazy create.
                        WaffledTextField(
                            value = name,
                            onValueChange = { model.name = it },
                            placeholder = MealBuilderModel.NEW_NAME,
                            keyboardActions = androidx.compose.foundation.text.KeyboardActions(
                                onDone = { scope.launch { model.commitRename() } },
                            ),
                            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                                imeAction = androidx.compose.ui.text.input.ImeAction.Done,
                            ),
                        )
                        Text(
                            "Tap the name to rename this meal.",
                            style = TextStyle(fontSize = 12.sp),
                            color = WF.colors.ink3,
                        )
                    }
                }

                // ONE flat run — a header row per role, then that role's dishes, then its
                // ＋. `PlateReorder.rows` is the SINGLE definition of that order, so the
                // view and any future drop handler cannot drift apart.
                items(rows, key = { row ->
                    when (row) {
                        is PlateReorder.Row.Header -> "h:${row.role}"
                        is PlateReorder.Row.Item -> "i:${row.id}"
                    }
                }) { row ->
                    when (row) {
                        is PlateReorder.Row.Header -> {
                            val group = state.groups.first { it.role.key == row.role }
                            Row(
                                Modifier.padding(top = 6.dp),
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                SectionLabel(group.role.label)
                                if (group.dishes.isNotEmpty()) {
                                    Text(
                                        "${group.dishes.size}",
                                        Modifier
                                            .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
                                            .padding(horizontal = 6.dp, vertical = 1.dp),
                                        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Black),
                                        color = WF.colors.ink3,
                                    )
                                }
                            }
                        }

                        is PlateReorder.Row.Item -> when {
                            row.id.startsWith("add:") -> {
                                val role = PlateRoles.ordered.first { it.key == row.section }
                                // The ＋ carries THIS group's role. Sending no role files
                                // everything under the server default — the "I can't add
                                // a main" bug the web shipped.
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .background(WF.colors.card2, RoundedCornerShape(WF.radius.md))
                                        .clip(RoundedCornerShape(WF.radius.md))
                                        .clickable { onAddDish(role) }
                                        .padding(horizontal = 12.dp, vertical = 12.dp),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Icon(
                                        Icons.Filled.Add,
                                        null,
                                        tint = WF.colors.primary,
                                        modifier = Modifier.size(17.dp),
                                    )
                                    Text(
                                        role.addLabel,
                                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                                        color = WF.colors.ink2,
                                    )
                                }
                            }

                            row.id.startsWith("empty:") -> Row(
                                Modifier
                                    .fillMaxWidth()
                                    .background(WF.colors.card, RoundedCornerShape(WF.radius.md))
                                    .padding(12.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(
                                    Icons.Filled.Inbox,
                                    null,
                                    tint = WF.colors.ink3,
                                    modifier = Modifier.size(14.dp),
                                )
                                Text(
                                    "Nothing here yet — use “Move to…” on a dish.",
                                    style = TextStyle(fontSize = 13.sp),
                                    color = WF.colors.ink3,
                                )
                            }

                            else -> byId[row.id]?.let { dish ->
                                PlateDishRow(
                                    dish = dish,
                                    members = members,
                                    baseUrl = baseUrl,
                                    onAssignCook = { scope.launch { model.assignCook(dish.recipeId, it) } },
                                    onMove = { scope.launch { model.moveDish(dish.recipeId, it) } },
                                    onRemove = { scope.launch { model.removeDish(dish.recipeId) } },
                                )
                            }
                        }
                    }
                }
            }

            PlateBar(
                state = state,
                isEmpty = model.isEmpty,
                onServings = { scope.launch { model.changeServings(it) } },
                onToggleSaved = { scope.launch { model.toggleSaved() } },
                onAddToList = { scope.launch { model.addToGrocery() } },
                onSchedule = { scheduling = true },
            )
        }

        message?.let { text ->
            Text(
                text = text,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .padding(top = 8.dp)
                    .background(WF.colors.ink, RoundedCornerShape(WF.radius.pill))
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                // On a solid `ink` fill, never literal white.
                color = WF.colors.onInk,
            )
        }
    }

    if (scheduling) {
        // The same sheet the recipe detail uses; only what scheduling MEANS differs — a
        // plate goes to its own endpoint, which schedules every dish at once.
        RecipeScheduleSheet(
            householdWeekStart = householdWeekStart,
            title = model.displayName,
            eyebrow = "Schedule this meal",
            onDismiss = { scheduling = false },
            onSchedule = { date, mealType ->
                val ok = model.schedule(date, mealType)
                if (ok) model.message = "Scheduled."
                ok
            },
        )
    }
}

/**
 * The pinned stats + actions bar.
 *
 * `WF.colors.ink` is the repo's inverted-fill idiom and flips in both themes — which is
 * exactly why every label on it is `onInk` and never a literal white (ink becomes a warm
 * off-white in dark mode). The one exception is the coral action, which stays saturated
 * across themes, so white is right on it.
 */
@Composable
private fun PlateBar(
    state: MealBuilderModel.State,
    isEmpty: Boolean,
    onServings: (Int) -> Unit,
    onToggleSaved: () -> Unit,
    onAddToList: () -> Unit,
    onSchedule: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.ink)
            .navigationBarsPadding()
            .padding(horizontal = 16.dp)
            .padding(top = 12.dp, bottom = 10.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.Bottom) {
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                BarLabel("SERVES")
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    // Hand-rolled rather than a Material stepper: the native control draws
                    // its own scheme colours, which read as a disabled system widget
                    // dropped onto the ink bar.
                    StepGlyph(Icons.Filled.Remove, "Fewer servings") { onServings(state.servings - 1) }
                    Text(
                        "${state.servings}",
                        Modifier.widthIn(min = 20.dp),
                        style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.onInk,
                    )
                    StepGlyph(Icons.Filled.Add, "More servings") { onServings(state.servings + 1) }
                }
            }
            Spacer(Modifier.weight(1f))
            BarStat("Hands-on", "≈ ${MealBuilderModel.hoursMinutes(state.meal?.totalMinutes)}")
            BarStat("Groceries", "${state.meal?.toBuy ?: 0} to buy")
        }

        Row(
            Modifier.alpha(if (isEmpty) 0.5f else 1f),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Disabled on a blank plate, like both bar buttons: flipping it there triggers
            // the lazy create and leaves a dishless "New meal" card in the library
            // forever, which is nobody's intent.
            Switch(
                checked = state.isSaved,
                onCheckedChange = { onToggleSaved() },
                enabled = !isEmpty,
                colors = SwitchDefaults.colors(
                    checkedThumbColor = WF.colors.onInk,
                    checkedTrackColor = WF.colors.primary,
                    uncheckedThumbColor = WF.colors.onInk,
                    uncheckedTrackColor = WF.colors.onInk.copy(alpha = 0.20f),
                ),
            )
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    "Keep in library",
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.onInk,
                )
                // It applies the moment it's flipped — a state, not a pending action
                // waiting on Schedule or Add-to-list.
                Text(
                    if (state.isSaved) "Saved — it’s in your library" else "One-off — not saved",
                    style = TextStyle(fontSize = 11.sp),
                    color = WF.colors.onInk.copy(alpha = 0.6f),
                )
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            BarButton("Add plate to list", filled = false, enabled = !isEmpty && !state.busy, Modifier.weight(1f), onAddToList)
            BarButton("Schedule", filled = true, enabled = !isEmpty && !state.busy, Modifier.weight(1f), onSchedule)
        }
    }
}

@Composable
private fun BarLabel(text: String) {
    Text(
        text,
        style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.Black, letterSpacing = 0.4.sp),
        color = WF.colors.onInk.copy(alpha = 0.55f),
    )
}

@Composable
private fun BarStat(label: String, value: String) {
    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(1.dp)) {
        BarLabel(label.uppercase())
        Text(
            value,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.onInk,
        )
    }
}

@Composable
private fun StepGlyph(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .size(26.dp)
            .background(WF.colors.onInk.copy(alpha = 0.14f), CircleShape)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, label, tint = WF.colors.onInk, modifier = Modifier.size(12.dp))
    }
}

@Composable
private fun BarButton(
    label: String,
    filled: Boolean,
    enabled: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.sm)
    Box(
        modifier
            .alpha(if (enabled) 1f else 0.5f)
            .background(if (filled) WF.colors.primary else WF.colors.onInk.copy(alpha = 0.14f), shape)
            .clip(shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
            // Coral stays saturated in both themes, so white is correct on it; the ghost
            // button sits on ink and must use onInk.
            color = if (filled) Color.White else WF.colors.onInk,
        )
    }
}

/**
 * A plate row: the dish, its time + shopping claim, and its own cook.
 *
 * A four-dish plate has up to four cooks, which is why the cook picker hangs off the row
 * and not off the plate.
 */
@Composable
fun PlateDishRow(
    dish: MealDishDTO,
    members: List<Person>,
    modifier: Modifier = Modifier,
    baseUrl: String = "",
    onAssignCook: ((String?) -> Unit)? = null,
    onMove: ((PlateRole) -> Unit)? = null,
    onRemove: (() -> Unit)? = null,
    /** Cook this one dish (the plate detail wires it; the builder doesn't). */
    onCook: (() -> Unit)? = null,
) {
    var showMenu by remember { mutableStateOf(false) }
    var showCooks by remember { mutableStateOf(false) }

    Row(
        modifier
            .fillMaxWidth()
            .background(WF.colors.card, RoundedCornerShape(WF.radius.md))
            .padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RecipeHero(
            imageUrl = MediaUrl.resolve(dish.imageUrl, baseUrl),
            cacheKey = MediaUrl.cacheKey(dish.imageUrl),
            emoji = dish.emoji,
            category = dish.category,
            modifier = Modifier.size(46.dp).clip(RoundedCornerShape(11.dp)),
            height = 46.dp,
            emojiSize = 20,
        )

        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                dish.displayTitle,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                dish.totalMinutes?.takeIf { it > 0 }?.let { MetaBit("🕐", "${it}m") }
                // `onHand == null` means the pantry module is off — "we can't say".
                // Render nothing rather than a "0 of N" badge, which claims something
                // untrue.
                when (val claim = OnHandClaim.of(dish.onHand, dish.toBuy)) {
                    OnHandClaim.NothingToSay -> Unit
                    OnHandClaim.AllOnHand -> Text(
                        "✓ all on hand",
                        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.success,
                    )

                    is OnHandClaim.ToBuy -> Text(
                        "${claim.count} to buy",
                        Modifier
                            .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
                            .padding(horizontal = 7.dp, vertical = 2.dp),
                        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink2,
                    )
                }
            }
            if (onAssignCook != null || dish.cook?.name != null) {
                Box {
                    CookChip(dish, enabled = onAssignCook != null) { showCooks = true }
                    DropdownMenu(
                        expanded = showCooks,
                        onDismissRequest = { showCooks = false },
                        containerColor = WF.colors.card,
                    ) {
                        for (m in members) {
                            DropdownMenuItem(
                                text = { Text("${m.displayEmoji}  ${m.name}", color = WF.colors.ink) },
                                onClick = { showCooks = false; onAssignCook?.invoke(m.id) },
                            )
                        }
                        // "Nobody" must CLEAR the cook — the server tells an absent
                        // cookPersonId (leave it alone) apart from an explicit null.
                        DropdownMenuItem(
                            text = { Text("Nobody", color = WF.colors.danger) },
                            onClick = { showCooks = false; onAssignCook?.invoke(null) },
                        )
                    }
                }
            }
        }

        onCook?.let {
            Row(
                Modifier
                    .background(WF.colors.primary, RoundedCornerShape(WF.radius.pill))
                    .clip(RoundedCornerShape(WF.radius.pill))
                    .clickable(onClick = it)
                    .padding(horizontal = 11.dp, vertical = 7.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Filled.LocalFireDepartment,
                    null,
                    tint = Color.White,
                    modifier = Modifier.size(11.dp),
                )
                Text(
                    "Cook",
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
                    color = Color.White,
                )
            }
        }

        if (onMove != null || onRemove != null) {
            Box {
                Icon(
                    Icons.Filled.MoreVert,
                    "Dish actions",
                    tint = WF.colors.ink3,
                    modifier = Modifier.size(32.dp).clip(CircleShape).clickable { showMenu = true }.padding(8.dp),
                )
                DropdownMenu(
                    expanded = showMenu,
                    onDismissRequest = { showMenu = false },
                    containerColor = WF.colors.card,
                ) {
                    onMove?.let { move ->
                        for (role in PlateRoles.ordered) {
                            if (role.key == dish.role) continue
                            DropdownMenuItem(
                                text = { Text("Move to ${role.label}", color = WF.colors.ink) },
                                onClick = { showMenu = false; move(role) },
                            )
                        }
                    }
                    onRemove?.let { remove ->
                        DropdownMenuItem(
                            text = { Text("Remove from plate", color = WF.colors.danger) },
                            leadingIcon = {
                                Icon(
                                    Icons.Filled.Delete,
                                    null,
                                    tint = WF.colors.danger,
                                    modifier = Modifier.size(16.dp),
                                )
                            },
                            onClick = { showMenu = false; remove() },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CookChip(dish: MealDishDTO, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
            .clip(RoundedCornerShape(WF.radius.pill))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val cook = dish.cook
        if (cook?.name != null) {
            AvatarFromHex(cook.colorHex, cook.avatarEmoji ?: "🙂", size = 18.dp)
            Text(
                cook.name,
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink2,
            )
        } else {
            Icon(Icons.Filled.PersonAdd, null, tint = WF.colors.ink3, modifier = Modifier.size(12.dp))
            Text(
                "Add cook",
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
        }
    }
}

package app.waffled.feature.recipes

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.wfField
import kotlinx.coroutines.launch

/**
 * The Recipes library — the searchable / sortable / filterable card grid, with saved
 * plates in the same grid. The phone layout of iOS `RecipesLibraryView`.
 *
 * The same screen doubles as **the picker**: pass [onPickRecipe] and a card calls back
 * instead of opening the detail. That is deliberately one screen rather than two — a
 * picker that browses differently from the library is a second thing to learn.
 *
 * **Scope:** phone layout only (a fixed 2-column grid; the iPad adaptive grid is not
 * ported).
 */
@Composable
fun RecipesLibraryScreen(
    model: RecipesModel,
    modifier: Modifier = Modifier,
    /** Browse mode: open the recipe's detail. Ignored when [onPickRecipe] is set. */
    onOpenRecipe: (RecipeSummary) -> Unit = {},
    /** Browse mode: open the plate. */
    onOpenMeal: (MealDTO) -> Unit = {},
    /** Pick mode: hand the recipe back instead of opening it. */
    onPickRecipe: ((RecipeSummary) -> Unit)? = null,
    /**
     * Pick mode, plates. When picking is on but this is null the caller can only use a
     * single recipe, so plates are **hidden** rather than rendered as a control that does
     * nothing when tapped.
     */
    onPickMeal: ((MealDTO) -> Unit)? = null,
    /**
     * A plate to leave out — the one currently being built. Adding a plate to itself
     * flattens it into itself, silently renumbering every dish it already has.
     */
    excludeMealId: String? = null,
    /**
     * Browse mode: the "＋ New" menu; null hides an entry. In pick mode these are ignored —
     * the picker hosts the editor / builder itself and hands the result straight back.
     */
    onNewRecipe: (() -> Unit)? = null,
    onNewMeal: (() -> Unit)? = null,
    /** Seed the library pre-filtered — the "Cook from your pantry" and "🆕 New" deep-links. */
    initialProtein: String? = null,
    initialNewOnly: Boolean = false,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var filters by remember {
        mutableStateOf(
            LibraryFilters(
                protein = initialProtein?.let { setOf(it) } ?: emptySet(),
                onlyNew = initialNewOnly,
            ),
        )
    }
    var recentScope by remember { mutableStateOf(RecentRecipeScope.Me) }
    val picking = onPickRecipe != null
    val offer = LibraryNewOffer.of(canPickMeal = !picking || onPickMeal != null)
    // Pick mode creates in place rather than navigating: a plan sheet behind the picker
    // holds an unsaved draft that navigating away would discard.
    var creatingForPick by remember { mutableStateOf(false) }
    var buildingForPick by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { model.load() }
    LaunchedEffect(recentScope) { model.loadRecent(recentScope) }

    // Plates the current caller can actually use.
    val pickableMeals = remember(state.meals, picking, onPickMeal, excludeMealId) {
        when {
            picking && onPickMeal == null -> emptyList()
            excludeMealId != null -> state.meals.filterNot { it.id == excludeMealId }
            else -> state.meals
        }
    }
    // Precomputed per data load and per filter change, never per frame.
    val rows = remember(state.recipes, pickableMeals, state.haystacks, filters) {
        model.rows(filters, pickableMeals)
    }

    Box(modifier.fillMaxSize().background(WF.colors.canvas)) {
        LazyVerticalGrid(
            columns = GridCells.Fixed(2),
            contentPadding = PaddingValues(
                start = 16.dp,
                end = 16.dp,
                top = 10.dp,
                // Every screen scrolls UNDER the tab bar.
                bottom = WF.spacing.tabBarClearance,
            ),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                LibrarySearchField(filters.query) { filters = filters.copy(query = it) }
            }
            item(span = { GridItemSpan(maxLineSpan) }) {
                LibraryControlsBar(
                    filters = filters,
                    cuisines = model.cuisines(),
                    proteins = model.proteins(),
                    dietary = model.dietaryValues(),
                    hasMeals = pickableMeals.isNotEmpty(),
                    onFilters = { filters = it },
                    onNewRecipe = if (picking) ({ creatingForPick = true }) else onNewRecipe,
                    onNewMeal = when {
                        !picking -> onNewMeal
                        offer.offersMeal -> ({ buildingForPick = true })
                        else -> null
                    },
                )
            }
            if (filters.any) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    ActiveFilterBar(filters) { filters = it }
                }
            }
            if (state.recent.isNotEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    RecentRail(
                        recent = state.recent,
                        scopeValue = recentScope,
                        onScope = { recentScope = it },
                        onOpen = { r -> onPickRecipe?.invoke(r) ?: onOpenRecipe(r) },
                        toRow = { model.toRow(LibraryEntry.Recipe(it)) },
                    )
                }
            }

            when {
                state.loading && state.recipes.isEmpty() ->
                    item(span = { GridItemSpan(maxLineSpan) }) { WaffledLoading() }

                state.recipes.isEmpty() && state.meals.isEmpty() ->
                    item(span = { GridItemSpan(maxLineSpan) }) {
                        WaffledEmptyState(
                            emoji = if (state.error) "🔌" else "📖",
                            title = if (state.error) "Couldn’t load your recipes." else "No recipes yet",
                            message = if (state.error) null
                            else "Import some with `just import-recipes`, or add one with ＋.",
                        )
                    }

                rows.isEmpty() ->
                    item(span = { GridItemSpan(maxLineSpan) }) {
                        WaffledEmptyState("🔍", "Nothing matches", message = "Try clearing filters.")
                    }

                else -> items(rows, key = { it.id }) { row ->
                    LibraryCard(
                        row = row,
                        onClick = {
                            when (val e = row.entry) {
                                is LibraryEntry.Recipe ->
                                    onPickRecipe?.invoke(e.recipe) ?: onOpenRecipe(e.recipe)

                                is LibraryEntry.Meal ->
                                    onPickMeal?.invoke(e.meal) ?: onOpenMeal(e.meal)
                            }
                        },
                    )
                }
            }
        }
    }

    if (creatingForPick) {
        PickerFullScreen(onDismiss = { creatingForPick = false }) {
            RecipeEditorScreen(
                api = model.api,
                baseUrl = model.baseUrl,
                onCancel = { creatingForPick = false },
                onSaved = { saved ->
                    creatingForPick = false
                    scope.launch { model.load() }
                    onPickRecipe?.invoke(saved)
                },
            )
        }
    }
    if (buildingForPick && onPickMeal != null) {
        PickerFullScreen(onDismiss = { buildingForPick = false }) {
            PickerMealBuilder(
                library = model,
                onCancel = { buildingForPick = false },
                onUse = { plate ->
                    buildingForPick = false
                    scope.launch { model.load() }
                    onPickMeal(plate)
                },
            )
        }
    }
}

/** A full-screen modal over the picker, so creating never navigates away from it. */
@Composable
private fun PickerFullScreen(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    androidx.compose.ui.window.Dialog(
        onDismissRequest = onDismiss,
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(Modifier.fillMaxSize().background(WF.colors.canvas)) { content() }
    }
}

/**
 * The Meal Builder opened from inside a picker: its own role pickers browse the same
 * library, and "Use this meal" hands the saved plate back to the slot being filled.
 */
@Composable
private fun PickerMealBuilder(library: RecipesModel, onCancel: () -> Unit, onUse: (MealDTO) -> Unit) {
    val scope = rememberCoroutineScope()
    val builder = remember { MealBuilderModel(MealBuilderApi.live(library.api)) }
    var addingTo by remember { mutableStateOf<PlateRole?>(null) }
    MealBuilderScreen(
        model = builder,
        baseUrl = library.baseUrl,
        onDone = onCancel,
        onAddDish = { addingTo = it },
        onUse = onUse,
    )
    addingTo?.let { role ->
        RecipePickerSheet(
            model = library,
            title = role.addLabel,
            onDismiss = { addingTo = null },
            onPickRecipe = { ref -> scope.launch { builder.addRecipe(ref.id, role) } },
            onPickMeal = { id, _ -> scope.launch { builder.addSavedMeal(id) } },
            excludeMealId = builder.mealId,
        )
    }
}

@Composable
private fun LibrarySearchField(query: String, onQuery: (String) -> Unit) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.panel, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .padding(horizontal = 13.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Search, null, tint = WF.colors.ink3, modifier = Modifier.size(14.dp))
        // WaffledTextField draws its own boxed chrome, which would fight this capsule —
        // so the search field is the one place we reach for the primitive underneath it.
        // Everything else on this screen uses the shared field.
        androidx.compose.foundation.text.BasicTextField(
            value = query,
            onValueChange = onQuery,
            singleLine = true,
            modifier = Modifier.weight(1f).padding(vertical = 12.dp),
            textStyle = TextStyle(fontSize = 15.sp, color = WF.colors.ink),
            cursorBrush = androidx.compose.ui.graphics.SolidColor(WF.colors.primary),
            keyboardOptions = KeyboardOptions(
                capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.None,
                autoCorrectEnabled = false,
            ),
            decorationBox = { inner ->
                if (query.isEmpty()) {
                    Text(
                        "Search recipes, meals, a veggie…",
                        style = TextStyle(fontSize = 15.sp),
                        color = WF.colors.ink3,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                inner()
            },
        )
        if (query.isNotEmpty()) {
            Icon(
                Icons.Filled.Close,
                "Clear search",
                tint = WF.colors.ink3,
                modifier = Modifier.size(16.dp).clickable { onQuery("") },
            )
        }
    }
}

/** Sort + facets live in the content, not a top bar, so the tab chrome stays put. */
@Composable
private fun LibraryControlsBar(
    filters: LibraryFilters,
    cuisines: List<String>,
    proteins: List<String>,
    dietary: List<String>,
    hasMeals: Boolean,
    onFilters: (LibraryFilters) -> Unit,
    onNewRecipe: (() -> Unit)?,
    onNewMeal: (() -> Unit)?,
) {
    var showFilters by remember { mutableStateOf(false) }
    var showNew by remember { mutableStateOf(false) }

    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            ControlPill(
                icon = Icons.Filled.FilterList,
                text = filters.sort.label,
                active = filters.any,
                onClick = { showFilters = true },
            )
            DropdownMenu(
                expanded = showFilters,
                onDismissRequest = { showFilters = false },
                containerColor = WF.colors.card,
            ) {
                MenuSectionLabel("Sort")
                for (s in RecipeSort.entries) {
                    CheckableMenuItem(s.label, filters.sort == s) { onFilters(filters.copy(sort = s)) }
                }
                // Plates carry no cuisine / protein / dietary metadata, so every facet
                // below legitimately drops them — the control that *selects* them has to
                // be a TYPE filter, or it would filter itself out.
                if (hasMeals) {
                    MenuSectionLabel("Show")
                    for (t in LibraryType.entries) {
                        CheckableMenuItem(t.chip, filters.type == t) { onFilters(filters.copy(type = t)) }
                    }
                }
                FacetSection("Cuisine", cuisines, filters.cuisine) {
                    onFilters(filters.copy(cuisine = it))
                }
                FacetSection("Protein", proteins, filters.protein) {
                    onFilters(filters.copy(protein = it))
                }
                FacetSection("Dietary", dietary, filters.dietary) {
                    onFilters(filters.copy(dietary = it))
                }
            }
        }
        Spacer(Modifier.weight(1f))
        ControlPill(
            icon = Icons.Filled.Add,
            text = "New",
            active = filters.onlyNew,
            onClick = { onFilters(filters.copy(onlyNew = !filters.onlyNew)) },
        )
        ControlPill(
            icon = Icons.Filled.FavoriteBorder,
            text = "Favorites",
            active = filters.onlyFavorites,
            onClick = { onFilters(filters.copy(onlyFavorites = !filters.onlyFavorites)) },
        )
        if (onNewRecipe != null && onNewMeal == null) {
            ControlPill(Icons.Filled.Add, "Add", false, onNewRecipe)
        } else if (onNewRecipe != null || onNewMeal != null) {
            Box {
                ControlPill(Icons.Filled.Add, "Add", false) { showNew = true }
                DropdownMenu(
                    expanded = showNew,
                    onDismissRequest = { showNew = false },
                    containerColor = WF.colors.card,
                ) {
                    onNewRecipe?.let {
                        DropdownMenuItem(
                            text = { Text("📖 New recipe", color = WF.colors.ink) },
                            onClick = { showNew = false; it() },
                        )
                    }
                    onNewMeal?.let {
                        DropdownMenuItem(
                            text = { Text("🍽️ New meal", color = WF.colors.ink) },
                            onClick = { showNew = false; it() },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MenuSectionLabel(text: String) {
    SectionLabel(text, Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
}

@Composable
private fun CheckableMenuItem(label: String, checked: Boolean, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label, color = WF.colors.ink) },
        leadingIcon = {
            if (checked) Icon(Icons.Filled.Check, null, tint = WF.colors.primary, modifier = Modifier.size(16.dp))
        },
        onClick = onClick,
    )
}

@Composable
private fun FacetSection(
    title: String,
    values: List<String>,
    selected: Set<String>,
    onChange: (Set<String>) -> Unit,
) {
    if (values.isEmpty()) return
    MenuSectionLabel(title)
    for (v in values) {
        CheckableMenuItem(v.replaceFirstChar { it.uppercase() }, v in selected) {
            onChange(if (v in selected) selected - v else selected + v)
        }
    }
}

/**
 * A filter/sort pill.
 *
 * Hand-rolled rather than `wfChip`: `wfChip` is a *selection* chip (tinted fill + coloured
 * border when picked). These carry a leading icon and an "is any filter on" active state,
 * and they sit on `canvas` rather than inside a picker — different job, different shape.
 */
@Composable
private fun ControlPill(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    text: String,
    active: Boolean,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.pill)
    val fg = if (active) WF.colors.primary else WF.colors.ink2
    Row(
        Modifier
            .background(if (active) WF.colors.primary.copy(alpha = 0.10f) else WF.colors.card, shape)
            .border(1.dp, if (active) WF.colors.primary.copy(alpha = 0.4f) else WF.colors.hair, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = fg, modifier = Modifier.size(13.dp))
        Text(text, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = fg)
    }
}

/** Inline chips for whatever's active, with a one-tap Clear. */
@Composable
private fun ActiveFilterBar(filters: LibraryFilters, onFilters: (LibraryFilters) -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (filters.type != LibraryType.All) {
            TagChip(filters.type.chip, style = TagStyle.New) {
                onFilters(filters.copy(type = LibraryType.All))
            }
        }
        if (filters.onlyFavorites) {
            TagChip("❤️ Favorites", style = TagStyle.New) { onFilters(filters.copy(onlyFavorites = false)) }
        }
        if (filters.onlyNew) {
            TagChip("🆕 New", style = TagStyle.New) { onFilters(filters.copy(onlyNew = false)) }
        }
        for (v in filters.cuisine.sorted()) {
            TagChip("🌍 ${v.replaceFirstChar { it.uppercase() }}", style = TagStyle.New) {
                onFilters(filters.copy(cuisine = filters.cuisine - v))
            }
        }
        for (v in filters.protein.sorted()) {
            TagChip("🥩 ${v.replaceFirstChar { it.uppercase() }}", style = TagStyle.New) {
                onFilters(filters.copy(protein = filters.protein - v))
            }
        }
        for (v in filters.dietary.sorted()) {
            TagChip(v.replaceFirstChar { it.uppercase() }, style = TagStyle.New) {
                onFilters(filters.copy(dietary = filters.dietary - v))
            }
        }
        Text(
            text = "Clear",
            modifier = Modifier
                .clickable { onFilters(LibraryFilters(query = filters.query, sort = filters.sort)) }
                .padding(horizontal = 12.dp, vertical = 7.dp),
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink2,
        )
    }
}

/**
 * A horizontal shortcut strip back to recently-opened recipes.
 *
 * Rendered only when there IS history — an empty strip under a heading is worse than
 * nothing — and deliberately smaller than a card, so it reads as a way back rather than a
 * second library.
 */
@Composable
private fun RecentRail(
    recent: List<RecipeSummary>,
    scopeValue: RecentRecipeScope,
    onScope: (RecentRecipeScope) -> Unit,
    onOpen: (RecipeSummary) -> Unit,
    toRow: (RecipeSummary) -> LibraryRow,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Recently viewed", Modifier.weight(1f))
            for (s in RecentRecipeScope.entries) {
                val label = if (s == RecentRecipeScope.Me) "Me" else "Everyone"
                Text(
                    text = label,
                    modifier = Modifier
                        .clickable { onScope(s) }
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                    style = TextStyle(
                        fontSize = 12.sp,
                        fontWeight = if (s == scopeValue) FontWeight.Bold else FontWeight.Normal,
                    ),
                    color = if (s == scopeValue) WF.colors.ink else WF.colors.ink3,
                )
            }
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            items(recent, key = { it.id }) { r ->
                val row = toRow(r)
                Column(
                    Modifier.width(104.dp).clickable { onOpen(r) },
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    RecipeHero(
                        imageUrl = row.resolvedImageUrl,
                        cacheKey = row.imageCacheKey,
                        emoji = r.emoji,
                        category = r.category,
                        modifier = Modifier.clip(RoundedCornerShape(WF.radius.lg)),
                        height = 68.dp,
                        emojiSize = 26,
                    )
                    Text(
                        text = r.title,
                        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * One library tile — a recipe or a saved plate.
 *
 * A fixed-height title block keeps every card the same height regardless of how much meta
 * a recipe carries; without it the grid gaps chase the content.
 */
@Composable
fun LibraryCard(row: LibraryRow, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val recipe = (row.entry as? LibraryEntry.Recipe)?.recipe
    val meal = (row.entry as? LibraryEntry.Meal)?.meal
    Column(
        modifier
            .fillMaxWidth()
            .wfField(radius = WF.radius.md)
            .clickable(onClick = onClick),
    ) {
        RecipeHero(
            imageUrl = row.resolvedImageUrl,
            cacheKey = row.imageCacheKey,
            emoji = recipe?.emoji ?: meal?.emojis?.take(3)?.joinToString("")?.ifEmpty { "🍽️" },
            category = recipe?.category ?: "dinner",
            emojiSize = if (meal != null) 34 else 42,
        ) {
            // Never cooked → a "🆕" corner badge, mirroring the kiosk library.
            if (recipe != null && recipe.cookedCount == 0) {
                Text("🆕", Modifier.align(Alignment.TopStart).padding(7.dp), style = TextStyle(fontSize = 15.sp))
            }
            if (recipe?.isFavorite == true) {
                Text("❤️", Modifier.align(Alignment.TopEnd).padding(7.dp), style = TextStyle(fontSize = 15.sp))
            }
            if (meal != null) {
                // Plates and recipes share one grid, so each plate says what it is.
                Text(
                    text = "🍽️ Meal",
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .padding(7.dp)
                        .background(WF.colors.ink, RoundedCornerShape(WF.radius.pill))
                        .padding(horizontal = 7.dp, vertical = 3.dp),
                    style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.Black),
                    // On a solid `ink` fill the text is `onInk`, never literal white.
                    color = WF.colors.onInk,
                )
            }
        }
        Column(
            Modifier.padding(horizontal = 11.dp).padding(top = 9.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Text(
                text = row.title,
                modifier = Modifier.fillMaxWidth().heightIn(min = 40.dp, max = 40.dp),
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((icon, text) in row.meta) MetaBit(icon, text)
            }
            // Keeps every card the same height as one carrying a collection line.
            Text(
                text = recipe?.collection?.let { "📁 $it" } ?: " ",
                style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium),
                color = WF.colors.ink3,
                maxLines = 1,
            )
        }
    }
}

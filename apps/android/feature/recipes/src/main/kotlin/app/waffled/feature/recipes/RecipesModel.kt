package app.waffled.feature.recipes

import androidx.compose.runtime.Immutable
import app.waffled.core.model.RecipeRef
import app.waffled.core.network.MediaUrl
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * One tile in the library: the wire entry plus everything the grid would otherwise have to
 * compute per frame.
 *
 * Resolving the media URL and the meta line **at load time** is the point. A lazy grid
 * recomposes on every scroll and every search keystroke, and doing either in the tile is
 * the documented performance trap this app has hit on iOS (multi-second lag per keystroke).
 * Here the tile only reads fields.
 */
@Immutable
data class LibraryRow(
    val entry: LibraryEntry,
    /** Absolute URL for the stored blob, or null for the category-gradient fallback. */
    val resolvedImageUrl: String?,
    /**
     * Coil's cache key — the storage PATH, never the (possibly signed) URL. A signed URL
     * carries an expiry, so keying on it means the key changes every load and the cache
     * never hits.
     */
    val imageCacheKey: String?,
    /** The "🌍 mexican · 🥩 beef · 🕐 30m" fragments, formatted once. */
    val meta: List<Pair<String, String>>,
) {
    val id: String get() = entry.id
    val title: String get() = entry.title
    val isMeal: Boolean get() = entry is LibraryEntry.Meal
}

/**
 * The Recipes library — every recipe in the household **and every saved plate**, since a
 * saved meal is a first-class citizen of the library.
 *
 * The port of `RecipesModel` in `apps/ios/.../Features/Meals/RecipesLibraryView.swift`.
 * The server returns the whole library with no server-side search, so all filtering and
 * sorting happens client-side in [LibraryFilter].
 *
 * Plain `suspend` methods rather than `viewModelScope.launch`, so the state machine is
 * drivable from a JVM test with no main-dispatcher rule.
 */
class RecipesModel(
    val api: RecipesApi,
    private val baseUrl: String,
    private val refreshBus: RefreshBus? = null,
) {

    @Immutable
    data class State(
        val recipes: List<RecipeSummary> = emptyList(),
        /** Saved plates, listed alongside the recipes. */
        val meals: List<MealDTO> = emptyList(),
        /**
         * The searchable text for every entry, keyed by id and rebuilt **once per load**.
         * Recomputing it per keystroke is the search-field jank trap this app has hit.
         */
        val haystacks: Map<String, String> = emptyMap(),
        val recent: List<RecipeSummary> = emptyList(),
        val loading: Boolean = true,
        val error: Boolean = false,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    val recipes: List<RecipeSummary> get() = _state.value.recipes
    val meals: List<MealDTO> get() = _state.value.meals

    suspend fun load() {
        _state.value = _state.value.copy(loading = true)
        // Plates come from a different endpoint, and a server predating Meal Builder
        // simply has none — which must not blank the recipes alongside them.
        val (r, m) = coroutineScope {
            val fetchedRecipes = async { runCatching { api.library() }.getOrNull() }
            val fetchedMeals = async { runCatching { api.savedMeals() }.getOrNull() }
            fetchedRecipes.await() to fetchedMeals.await()
        }
        val nextRecipes = r ?: _state.value.recipes
        val nextMeals = m.orEmpty()
        _state.value = _state.value.copy(
            recipes = nextRecipes,
            meals = nextMeals,
            haystacks = LibraryFilter.haystacks(nextRecipes, nextMeals),
            loading = false,
            error = r == null,
        )
    }

    /** The recently-viewed rail — the caller's own history, or the household's. */
    suspend fun loadRecent(scope: RecentRecipeScope) {
        val list = runCatching { api.recent(scope) }.getOrNull() ?: return
        _state.value = _state.value.copy(recent = list)
    }

    /**
     * Replace one recipe in place after a favourite / cooked change on the detail screen,
     * so the library reflects it without a full reload.
     */
    fun apply(updated: RecipeSummary) {
        val i = recipes.indexOfFirst { it.id == updated.id }
        if (i < 0) return
        val next = recipes.toMutableList().also { it[i] = updated }
        _state.value = _state.value.copy(
            recipes = next,
            haystacks = _state.value.haystacks + (updated.id to LibraryFilter.haystack(updated)),
        )
    }

    /** Drop a deleted recipe without a full reload. */
    fun remove(id: String) {
        _state.value = _state.value.copy(
            recipes = recipes.filterNot { it.id == id },
            haystacks = _state.value.haystacks - id,
        )
    }

    fun invalidate() {
        refreshBus?.bump(RefreshDomain.Meals)
    }

    /** The facet values the filter menu offers, taken from what the library actually has. */
    fun cuisines(): List<String> = recipes.mapNotNull { it.cuisine }.distinct().sorted()
    fun proteins(): List<String> = recipes.mapNotNull { it.protein }.distinct().sorted()
    fun dietaryValues(): List<String> = recipes.flatMap { it.dietary.orEmpty() }.distinct().sorted()

    /**
     * The rows to draw, filtered and sorted, with every per-row derivation already done.
     *
     * [pickableMeals] is what the caller can actually use: in pick mode without a plate
     * handler a plate card would be a control that does nothing when tapped, so those are
     * excluded rather than rendered dead.
     */
    fun rows(filters: LibraryFilters, pickableMeals: List<MealDTO>): List<LibraryRow> =
        LibraryFilter.entries(recipes, pickableMeals, filters, _state.value.haystacks).map(::toRow)

    fun toRow(entry: LibraryEntry): LibraryRow {
        val imagePath = (entry as? LibraryEntry.Recipe)?.recipe?.imageUrl
        return LibraryRow(
            entry = entry,
            resolvedImageUrl = MediaUrl.resolve(imagePath, baseUrl),
            imageCacheKey = MediaUrl.cacheKey(imagePath),
            meta = when (entry) {
                is LibraryEntry.Recipe -> buildList {
                    entry.recipe.cuisine?.let { add("🌍" to it) }
                    entry.recipe.protein?.let { add("🥩" to it) }
                    entry.recipe.totalTimeMinutes?.let { add("🕐" to "${it}m") }
                    if (entry.recipe.cookedCount > 0) add("👨‍🍳" to "${entry.recipe.cookedCount}×")
                }

                is LibraryEntry.Meal -> buildList {
                    val n = entry.meal.recipeCount
                    add("🥘" to "$n ${if (n == 1) "dish" else "dishes"}")
                    entry.meal.totalMinutes?.takeIf { it > 0 }?.let { add("🕐" to "${it}m") }
                    add("🍽️" to "${entry.meal.servings}")
                }
            },
        )
    }
}

/**
 * A recipe as the planner refers to it — the shared shape in `core:model`, so the Meals
 * feature can accept a pick without ever depending on this module.
 */
fun RecipeSummary.toRef(): RecipeRef =
    RecipeRef(id = id, title = title, emoji = emoji, imagePath = imageUrl)

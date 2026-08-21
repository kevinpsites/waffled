package app.waffled.feature.recipes

import androidx.compose.runtime.Immutable
import app.waffled.core.network.MediaUrl
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** One metadata chip on the detail header. */
@Immutable
data class RecipeChip(val text: String, val style: TagStyle)

/**
 * The recipe detail's state and writes — the model half of iOS `RecipeDetailView`.
 *
 * Everything the screen derives lives here so the rules are testable without a view body:
 * the chip ordering, the servings ratio, which note or substitution is in force, and the
 * read-modify-write of the overrides blob (see [RecipeOverrideEdits]).
 */
class RecipeDetailModel(
    private val api: RecipesApi,
    summary: RecipeSummary,
    private val baseUrl: String,
    private val refreshBus: RefreshBus? = null,
    /** Keeps the library grid in step after a favourite / cooked / delete. */
    private val library: RecipesModel? = null,
) {

    @Immutable
    data class State(
        val recipe: RecipeSummary,
        val ingredients: List<RecipeIngredientDTO> = emptyList(),
        val steps: List<RecipeStepDTO> = emptyList(),
        /**
         * Real pantry-matched on-hand from the server — null when the pantry module is off
         * (make no claim at all) or before the detail has loaded.
         */
        val onHand: OnHandCount? = null,
        /**
         * null means the server never sent counts at all (it predates them) — distinct
         * from "sent zero", so the banner can fall back rather than claim nothing is
         * needed.
         */
        val toBuy: Int? = null,
        /** With the pantry ON this is the *unmatched* subset, which we cannot derive. */
        val toBuyNames: List<String> = emptyList(),
        val loading: Boolean = true,
        val error: Boolean = false,
        /** The transient line above the "Mark cooked" button. */
        val message: String? = null,
        /** null = the recipe's own; otherwise the scaler's current value. */
        val servings: Int? = null,
        /** Local check-off while shopping or cooking. Deliberately not persisted. */
        val checked: Set<String> = emptySet(),
        val busy: Boolean = false,
    )

    private val _state = MutableStateFlow(State(recipe = summary))
    val state: StateFlow<State> = _state.asStateFlow()

    private val _pantryReconcile = MutableStateFlow<List<RecipeMatch>>(emptyList())

    /**
     * On-hand pantry items a just-marked-cooked recipe likely used.
     *
     * The confirm sheet belongs to the pantry feature, so this is surfaced for the host to
     * present rather than drawn here.
     */
    val pantryReconcile: StateFlow<List<RecipeMatch>> = _pantryReconcile.asStateFlow()

    val recipe: RecipeSummary get() = _state.value.recipe
    val id: String get() = recipe.id

    val baseServings: Int get() = maxOf(1, recipe.servings ?: 4)
    val currentServings: Int get() = _state.value.servings ?: baseServings

    /** What the servings scaler multiplies every amount by. */
    val ratio: Double get() = currentServings.toDouble() / baseServings

    val heroUrl: String? get() = MediaUrl.resolve(recipe.imageUrl, baseUrl)
    val heroCacheKey: String? get() = MediaUrl.cacheKey(recipe.imageUrl)

    // ---- derived, pure ---------------------------------------------------------

    /**
     * The displayable chips, most meaningful first, so the three shown before "+N more"
     * are the useful ones. Free-text hashtags are split out to [hashtags] and rendered as
     * a quiet line instead — tags should not shout over the recipe.
     *
     * Favourite is deliberately absent: it is the heart in the toolbar, and a chip saying
     * the same thing is noise.
     */
    val chips: List<RecipeChip>
        get() = buildList {
            val r = recipe
            if (r.cookedCount == 0) add(RecipeChip("🆕 New", TagStyle.New))
            r.effort?.let { add(RecipeChip("⏱️ $it", TagStyle.Plain)) }
            for (v in r.vegetables.orEmpty()) add(RecipeChip("🥬 $v", TagStyle.Veg))
            r.collection?.let { add(RecipeChip("📁 $it", TagStyle.Collection)) }
            r.cuisine?.let { add(RecipeChip("🌍 $it", TagStyle.Plain)) }
            r.mealType?.let { add(RecipeChip(it.replace("-", " "), TagStyle.Plain)) }
            r.protein?.let { add(RecipeChip("🥩 $it", TagStyle.Plain)) }
            r.base?.let { add(RecipeChip("🍚 $it", TagStyle.Plain)) }
            r.cookMethod?.let { add(RecipeChip("🍳 $it", TagStyle.Plain)) }
            for (d in r.dietary.orEmpty()) add(RecipeChip(d, TagStyle.Dietary))
        }

    val hashtags: List<String> get() = recipe.tags.orEmpty()

    /** The note in force for a step: the user's override first, then the source's own. */
    fun noteFor(stepNumber: Int): String? {
        recipe.overrides?.stepNotes?.get(stepNumber.toString())?.takeIf { it.isNotEmpty() }
            ?.let { return it }
        return _state.value.steps.firstOrNull { it.stepNumber == stepNumber }?.note
    }

    /**
     * The current substitution for an ingredient, read from the authoritative overrides
     * blob so it reflects an edit immediately — and a *cleared* sub correctly shows
     * nothing.
     */
    fun subFor(ingredient: RecipeIngredientDTO): String? =
        recipe.overrides?.subs?.get(RecipeOverrideEdits.subKey(ingredient.name))?.takeIf { it.isNotEmpty() }

    /** "1½ cup", already scaled by the servings ratio. */
    fun amountText(ingredient: RecipeIngredientDTO): String =
        RecipeAmount.line(ingredient.amount?.times(ratio), ingredient.unit)

    /** "flour, sifted" — the name with its prep note, when there is one. */
    fun nameText(ingredient: RecipeIngredientDTO): String =
        ingredient.prepNote?.takeIf { it.isNotEmpty() }?.let { "${ingredient.name}, $it" } ?: ingredient.name

    /** The "N of M on hand — need X, Y" line. See [OnHandBanner] for why it must be the server's count. */
    fun banner(): OnHandBanner.Copy = with(_state.value) {
        OnHandBanner.copy(
            onHand = onHand,
            toBuy = toBuy,
            toBuyNames = toBuyNames,
            nonStapleNames = ingredients.filterNot { it.isStaple }.map { it.name },
        )
    }

    // ---- loading ---------------------------------------------------------------

    suspend fun load() {
        _state.update { it.copy(loading = true) }
        val d = runCatching { api.detail(id) }.getOrNull()
        _state.update {
            if (d == null) {
                it.copy(loading = false, error = true)
            } else {
                it.copy(
                    recipe = d.recipe,
                    ingredients = d.ingredients,
                    steps = d.steps,
                    onHand = d.onHand,
                    toBuy = d.toBuy,
                    toBuyNames = d.toBuyNames.orEmpty(),
                    loading = false,
                    error = false,
                )
            }
        }
    }

    /**
     * Feed the library's "Recently viewed" rail.
     *
     * Genuinely fire-and-forget: [RecipesApi.recordView] swallows everything, so an
     * unreachable server can never surface as an error on the recipe being read.
     */
    suspend fun recordView() = api.recordView(id)

    // ---- writes ----------------------------------------------------------------

    /** Optimistic: paint the flip immediately, undo it if the PATCH is refused. */
    suspend fun toggleFavorite() {
        val next = !recipe.isFavorite
        _state.update { it.copy(recipe = it.recipe.copy(isFavorite = next)) }
        val updated = runCatching { api.setFavorite(id, next) }.getOrNull()
        if (updated == null) {
            _state.update { it.copy(recipe = it.recipe.copy(isFavorite = !next)) }
        } else {
            adopt(updated)
        }
    }

    suspend fun markCooked() {
        val updated = runCatching { api.markCooked(id) }.getOrNull() ?: return
        adopt(updated)
        _state.update { it.copy(message = "Marked as cooked — nice work.") }
        // If the pantry has on-hand items this recipe likely used, offer to update it.
        val matches = runCatching { api.pantryForRecipe(id) }.getOrNull().orEmpty()
        if (matches.isNotEmpty()) _pantryReconcile.value = matches
    }

    fun clearPantryReconcile() {
        _pantryReconcile.value = emptyList()
    }

    suspend fun saveNotes(text: String) {
        runCatching { api.updateRecipe(id, userNotes = text) }.getOrNull()?.let(::adopt)
    }

    suspend fun saveStepNote(step: Int, note: String) {
        patch(RecipeOverrideEdits.withStepNote(recipe.overrides, step, note))
    }

    suspend fun saveSub(ingredientName: String, value: String) {
        patch(RecipeOverrideEdits.withSub(recipe.overrides, ingredientName, value))
    }

    suspend fun saveTags(addedTags: List<String>, dietary: List<String>) {
        patch(RecipeOverrideEdits.withTags(recipe.overrides, addedTags, dietary))
    }

    private suspend fun patch(overrides: kotlinx.serialization.json.JsonObject) {
        runCatching { api.updateRecipe(id, overrides = overrides) }.getOrNull()?.let(::adopt)
    }

    /**
     * Add the picked subset of ingredients.
     *
     * The server merges quantities into rows already on the list and links items back to
     * this recipe, so they group under it in the grocery board. The control keeps reading
     * "Add to grocery" afterwards: the picker is repeatable by design (a few things now,
     * the rest later), so a permanent "Added ✓" would describe the button as finished when
     * it isn't. The banner reports each add instead.
     */
    suspend fun addToGrocery(ingredientIds: List<String>) {
        if (_state.value.busy || ingredientIds.isEmpty()) return
        _state.update { it.copy(busy = true) }
        val added = runCatching { api.groceryFromRecipe(id, ingredientIds = ingredientIds) }
        _state.update {
            it.copy(
                busy = false,
                message = added.fold(
                    onSuccess = { n ->
                        if (n > 0) "Added $n to your grocery list."
                        else "Everything’s already on the list or on hand."
                    },
                    onFailure = { "Couldn’t reach the grocery list — try again." },
                ),
            )
        }
        if (added.isSuccess) refreshBus?.bump(RefreshDomain.Lists)
    }

    /**
     * Put this recipe on a day + slot. False ⇒ keep the sheet open and say nothing
     * misleading; the server is the only thing that knows the write landed.
     *
     * `(date, mealType)` REPLACES server-side rather than duplicating, so re-scheduling
     * the same night is idempotent.
     */
    suspend fun schedule(date: String, mealType: String): Boolean {
        val ok = runCatching { api.planRecipe(date, mealType, recipeId = id) }.isSuccess
        if (ok) refreshBus?.bump(RefreshDomain.Meals)
        return ok
    }

    /** The Markdown the share sheet sends. Null ⇒ the server couldn't compile it. */
    suspend fun shareMarkdown(): RecipeMarkdown? {
        val md = runCatching { api.markdown(id) }.getOrNull()
        if (md == null) {
            _state.update { it.copy(message = "Couldn’t prepare the recipe to share — try again.") }
        }
        return md
    }

    /** Returns true when the recipe is gone and the screen should pop. */
    suspend fun delete(): Boolean {
        val ok = runCatching { api.deleteRecipe(id) }.isSuccess
        if (ok) {
            library?.remove(id)
            refreshBus?.bump(RefreshDomain.Meals)
        } else {
            _state.update { it.copy(message = "Couldn’t delete the recipe. Try again.") }
        }
        return ok
    }

    // ---- local UI state --------------------------------------------------------

    fun setServings(value: Int) = _state.update { it.copy(servings = maxOf(1, value)) }

    fun toggleChecked(ingredientId: String) = _state.update {
        it.copy(
            checked = if (ingredientId in it.checked) it.checked - ingredientId
            else it.checked + ingredientId,
        )
    }

    fun clearMessage() = _state.update { it.copy(message = null) }

    /** Adopt a freshly-patched summary into local state + the library list. */
    private fun adopt(updated: RecipeSummary) {
        _state.update { it.copy(recipe = updated) }
        library?.apply(updated)
        refreshBus?.bump(RefreshDomain.Meals)
    }

    /** Re-seed from an editor save without a round-trip. */
    fun adoptEdited(updated: RecipeSummary) = adopt(updated)
}

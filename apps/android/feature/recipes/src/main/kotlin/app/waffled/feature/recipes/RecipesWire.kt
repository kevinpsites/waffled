package app.waffled.feature.recipes

import kotlinx.serialization.Serializable

/**
 * The wire shapes of the Recipes + Meal-Builder slice — the Kotlin port of the
 * `RecipeSummary` / `RecipeDetailDTO` / `MealDTO` types in
 * `apps/ios/.../Sync/WaffledAPI.swift`.
 *
 * Kept beside [RecipesApi] rather than inside it so the pure logic (library filtering,
 * plate roles, cook sessions, the grocery pick) can be tested without touching HTTP.
 *
 * Everything nullable server-side is nullable here, and everything the server always
 * sends carries a default. That is not belt-and-braces: a payload captured from a
 * running stack has the **pantry module ON**, so `onHand` is always populated in the
 * sample — the pantry-off shape (`onHand: null`) never appears in a capture and is
 * exactly what a required field would blow up on, in precisely the households that
 * switched the pantry off. `RecipeDecodingTest` pins both shapes.
 */

/**
 * How many of a recipe's ingredients are already in the pantry.
 *
 * Only ever present when the **pantry module is on**. With it off the server omits the
 * whole object rather than sending `{have: 0, total: n}` — which would read as "you have
 * none of these", a different and equally untrue claim. `null` means "we can't say", and
 * clients must render nothing at all. See [OnHandClaim].
 */
@Serializable
data class OnHandCount(val have: Int = 0, val total: Int = 0)

/**
 * The user-owned override blob layered over the markdown source.
 *
 * `PATCH /api/recipes/:id` **replaces this whole object**, so edits are read-modify-
 * write: start from the recipe's current [RecipeSummary.overrides], change one key, and
 * send it all back. (The web kiosk does the same.)
 */
@Serializable
data class RecipeOverrides(
    val meta: Map<String, String>? = null,
    val dietary: List<String>? = null,
    val addedTags: List<String>? = null,
    val removedTags: List<String>? = null,
    val subs: Map<String, String>? = null,
    val stepNotes: Map<String, String>? = null,
)

/**
 * One recipe as it appears in the library list.
 *
 * Most fields are nullable in the source (markdown frontmatter), so almost everything is
 * optional. [tags] is the merged view (source ∪ [addedTags] − removed); [addedTags] is
 * the user's own additions only.
 */
@Serializable
data class RecipeSummary(
    val id: String,
    val title: String = "",
    val emoji: String? = null,
    val category: String? = null,
    val prepTimeMinutes: Int? = null,
    val cookTimeMinutes: Int? = null,
    val servings: Int? = null,
    val imageUrl: String? = null,
    val sourceName: String? = null,
    val isFavorite: Boolean = false,
    val cookedCount: Int = 0,
    val lastCookedAt: String? = null,
    val mealType: String? = null,
    val protein: String? = null,
    val base: String? = null,
    val cuisine: String? = null,
    val effort: String? = null,
    val cookMethod: String? = null,
    val flavorProfile: String? = null,
    val dietary: List<String>? = null,
    val vegetables: List<String>? = null,
    val collection: String? = null,
    /** Merged: source ∪ added − removed. */
    val tags: List<String>? = null,
    /** User-added only — what the tags editor writes back. */
    val addedTags: List<String>? = null,
    /** Markdown source notes (read-only). */
    val notes: String? = null,
    /** The user's own notes (a top-level column, not part of [overrides]). */
    val userNotes: String? = null,
    val overrides: RecipeOverrides? = null,
) {
    /** Total active time = prep + cook (the library card's "🕐"), or null if neither is set. */
    val totalTimeMinutes: Int?
        get() = ((prepTimeMinutes ?: 0) + (cookTimeMinutes ?: 0)).takeIf { it > 0 }

    companion object {
        /**
         * A minimal placeholder for an instant recipe-detail header when only partial
         * info is on hand (the planner, a Today card). The detail screen reloads the
         * full recipe on appear.
         */
        fun placeholder(
            id: String,
            title: String,
            emoji: String? = null,
            category: String? = null,
            cookTimeMinutes: Int? = null,
            servings: Int? = null,
        ) = RecipeSummary(
            id = id, title = title, emoji = emoji, category = category,
            cookTimeMinutes = cookTimeMinutes, servings = servings,
        )
    }
}

/**
 * One ingredient row on the detail screen.
 *
 * [amount] is numeric; [display] is the raw original line; [aisle]/[isStaple] drive the
 * "on hand" banner; [sub] is the current override substitution if the user picked one.
 */
@Serializable
data class RecipeIngredientDTO(
    val id: String,
    val name: String = "",
    val amount: Double? = null,
    val unit: String? = null,
    val prepNote: String? = null,
    val display: String? = null,
    val section: String? = null,
    val aisle: String? = null,
    val isStaple: Boolean = false,
    val sortOrder: Int? = null,
    val sub: String? = null,
    /**
     * Does the household's pantry actually have this? Sent by `GET /api/recipes/:id`
     * only — the plate / cook-mode / meal-builder ingredient payloads don't carry it, so
     * it is **optional**.
     *
     * This is a PANTRY observation and stays strictly separate from [isStaple], which is
     * only an assumption that the household keeps a thing around. The grocery picker
     * pre-unchecks `inPantry`; staples stay checked. See [RecipeGroceryPick].
     *
     * null = the server didn't say (older build); false = matched nothing, or the pantry
     * module is off. Neither is a claim that you don't have it.
     */
    val inPantry: Boolean? = null,
) {
    /** The line to render: the substitution if one was picked, else the original. */
    val displayName: String get() = sub?.takeIf { it.isNotBlank() } ?: name
}

/** One method step. [ingredients] are the raw lines used at this step. */
@Serializable
data class RecipeStepDTO(
    val stepNumber: Int,
    val instruction: String = "",
    val ingredients: List<String> = emptyList(),
    /** Total seconds for this step's optional timer; null = no timer. */
    val timerSeconds: Int? = null,
    /** The user's per-step override note, if any. */
    val note: String? = null,
)

/** Full recipe detail: the summary fields plus structured ingredients + steps. */
@Serializable
data class RecipeDetailDTO(
    val recipe: RecipeSummary,
    val ingredients: List<RecipeIngredientDTO> = emptyList(),
    val steps: List<RecipeStepDTO> = emptyList(),
    /**
     * **Real pantry-matched** on-hand — null when the pantry module is off, in which case
     * the client must make no on-hand claim at all.
     *
     * Do NOT compute this client-side from `ingredients.isStaple`: a staple is a thing
     * you're assumed to keep around, not a thing you currently have, so that count says
     * "4 of 9 on hand" to a household with a completely empty pantry.
     */
    val onHand: OnHandCount? = null,
    /** How many ingredients will land on the grocery list. Not pantry-derived. */
    val toBuy: Int? = null,
    /** The names behind [toBuy] — with the pantry on, the *unmatched* subset. */
    val toBuyNames: List<String>? = null,
)

/** The recipe compiled into the blessed Markdown format, plus a suggested filename. */
@Serializable
data class RecipeMarkdown(val markdown: String = "", val filename: String = "recipe.md")

/** Which AI recipe-import paths this household can use right now. */
@Serializable
data class RecipeIngestConfig(val text: Boolean = false, val vision: Boolean = false)

/** AI Details auto-fill: inferred cuisine / protein / tags / … for the editor. */
@Serializable
data class RecipeMetadataSuggestion(
    val cuisine: String? = null,
    val mealType: String? = null,
    val protein: String? = null,
    val base: String? = null,
    val effort: String? = null,
    val cookMethod: String? = null,
    val flavorProfile: String? = null,
    val dietary: List<String>? = null,
    val vegetables: List<String>? = null,
    val tags: List<String>? = null,
)

/**
 * A pasted / dictated / photographed recipe parsed into editable fields.
 *
 * Does **not** create anything: the editor hydrates from this, the user reviews, then
 * saves. The response's extra `via` / `photoKeys` keys are ignored.
 */
@Serializable
data class ParsedRecipe(
    val recipe: Meta,
    val ingredients: List<Ing> = emptyList(),
    val steps: List<Step> = emptyList(),
) {
    @Serializable
    data class Meta(
        val title: String = "",
        val emoji: String? = null,
        val servings: Int? = null,
        val tags: List<String>? = null,
        val notes: String? = null,
        val sourceName: String? = null,
        val mealType: String? = null,
        val protein: String? = null,
        val base: String? = null,
        val cuisine: String? = null,
        val effort: String? = null,
        val cookMethod: String? = null,
        val flavorProfile: String? = null,
        val dietary: List<String>? = null,
        val vegetables: List<String>? = null,
    )

    @Serializable
    data class Ing(
        val name: String = "",
        val amount: Double? = null,
        val unit: String? = null,
        val prepNote: String? = null,
        val section: String? = null,
    )

    @Serializable
    data class Step(val instruction: String = "", val ingredients: List<String>? = null)
}

/**
 * An on-hand pantry item a just-cooked recipe likely used, with a server-suggested
 * action. [suggested] is one of `used_up` | `decrement` | `skip` (`skip` is never sent
 * back to `/consume` — the sheet filters it out).
 */
@Serializable
data class RecipeMatch(
    val id: String,
    val name: String = "",
    val amount: String = "",
    val unit: String = "",
    val isStaple: Boolean = false,
    val suggested: String = "skip",
)

// ---------------------------------------------------------------------------
// Meal Builder — plates (a named, multi-recipe meal)
// ---------------------------------------------------------------------------

/**
 * Who is cooking one dish. A four-dish plate has up to four cooks, which is why this
 * hangs off the dish and not off the plate.
 */
@Serializable
data class MealCookDTO(
    val personId: String? = null,
    val name: String? = null,
    val avatarEmoji: String? = null,
    val colorHex: String? = null,
)

/**
 * One dish on a plate.
 *
 * [role] is free text (`main` | `side` | `dessert` today) — soft scaffolding to help
 * people compose, not a rigid taxonomy, so a new role is a data change rather than a
 * migration. Note it is NOT `mealType`, which already means breakfast/lunch/dinner.
 */
@Serializable
data class MealDishDTO(
    val recipeId: String,
    val title: String? = null,
    val emoji: String? = null,
    val category: String? = null,
    val role: String = "side",
    val sortOrder: Int = 0,
    val prepTimeMinutes: Int? = null,
    val cookTimeMinutes: Int? = null,
    val servings: Int? = null,
    val imageUrl: String? = null,
    val cook: MealCookDTO? = null,
    val onHand: OnHandCount? = null,
    val toBuy: Int = 0,
    /**
     * The ingredients behind [toBuy], so the count can be expanded into the actual
     * shopping. Always exactly [toBuy] long, pantry on or off — a bare number names
     * nothing, and with the pantry ON the count is the *unmatched* subset, which no
     * client could derive from the ingredient list itself.
     */
    val toBuyNames: List<String> = emptyList(),
) {
    val id: String get() = recipeId
    val displayTitle: String get() = title ?: "Untitled recipe"

    /** Hands-on + cooking, when either is known. */
    val totalMinutes: Int?
        get() = if (prepTimeMinutes == null && cookTimeMinutes == null) null
        else (prepTimeMinutes ?: 0) + (cookTimeMinutes ?: 0)
}

/**
 * A whole plate. The builder screen, the meal detail and the library card all read this
 * same shape (the library list just carries fewer dish fields).
 */
@Serializable
data class MealDTO(
    val id: String,
    val name: String = "",
    /** Stored and displayed only — v1 deliberately does not rescale quantities. */
    val servings: Int = 4,
    /**
     * The "Keep in library" toggle. Applied the moment it is flipped, not deferred until
     * the plate is scheduled: an unsaved plate is a one-off that never appears in the
     * library, a saved one is a reusable template.
     */
    val isSaved: Boolean = false,
    val createdBy: String? = null,
    val createdAt: String = "",
    val recipeCount: Int = 0,
    val emojis: List<String> = emptyList(),
    val totalMinutes: Int? = null,
    /** Plate-level counts dedupe shared ingredients — two dishes wanting mayo is ONE buy. */
    val onHand: OnHandCount? = null,
    val toBuy: Int = 0,
    val toBuyNames: List<String> = emptyList(),
    val recipes: List<MealDishDTO> = emptyList(),
) {
    /** The plate's dishes filed under one role, in plate order. */
    fun dishes(role: String): List<MealDishDTO> = recipes.filter { it.role == role }

    companion object {
        /**
         * A minimal plate built from what a *summary* surface already knows — a planned
         * slot, a grocery row — so tapping it can push the detail immediately instead of
         * waiting on a fetch. The detail reloads the real plate by id on appear.
         *
         * The fields a summary can't know are left empty rather than guessed: `onHand` is
         * null (no claim, same as pantry-off) and `toBuy` is 0, so nothing renders a
         * number that would then change under the reader a moment later.
         */
        fun placeholder(
            id: String,
            name: String,
            servings: Int = 4,
            dishes: List<MealDishDTO> = emptyList(),
        ) = MealDTO(
            id = id,
            name = name,
            servings = servings,
            recipeCount = dishes.size,
            emojis = dishes.mapNotNull { it.emoji },
            recipes = dishes.mapIndexed { i, d -> d.copy(sortOrder = i) },
        )
    }
}

/** What `POST /api/meals/:id/schedule` answers with. */
@Serializable
data class ScheduledMealDTO(val entry: Entry, val meal: MealDTO) {
    @Serializable
    data class Entry(
        val id: String,
        val date: String = "",
        val mealType: String = "",
        val mealId: String? = null,
    )
}

/**
 * Whether a dish-patch should touch the cook at all.
 *
 * The server distinguishes an **absent** `cookPersonId` (leave it alone) from an explicit
 * **null** (clear it) — so "unchanged" and "clear" cannot both be modelled by `null`
 * without silently making one of them impossible. `WaffledJson` sets
 * `explicitNulls = false`, which is exactly why the patch body is a hand-built
 * `JsonObject` with a real `JsonNull` rather than a data class.
 */
sealed interface CookAssignment {
    /** Don't send the key — leave whatever the server has. */
    data object Unchanged : CookAssignment

    /** Send an explicit null — "Nobody". */
    data object Clear : CookAssignment

    /** Assign this person. */
    data class Person(val personId: String) : CookAssignment
}

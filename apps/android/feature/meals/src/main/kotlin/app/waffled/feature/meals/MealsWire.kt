package app.waffled.feature.meals

import kotlinx.serialization.Serializable

/**
 * The meal-planner wire shapes, ported from `WaffledAPI.swift`.
 *
 * Only the slice the PLANNER needs lives here. The recipe library's own detail, editor
 * and import shapes belong to the recipes feature; where the planner has to name a
 * recipe it uses `app.waffled.core.model.RecipeRef` or the summary below.
 */

/** Who is cooking a planned slot. */
@Serializable
data class WeekCookDTO(
    val personId: String? = null,
    val name: String? = null,
    val avatarEmoji: String? = null,
    val colorHex: String? = null,
)

/** The recipe behind a recipe-backed slot, as the week endpoint inlines it. */
@Serializable
data class WeekRecipeInfo(
    val title: String? = null,
    val emoji: String? = null,
    val category: String? = null,
    val prepTimeMinutes: Int? = null,
    val cookTimeMinutes: Int? = null,
    val servings: Int? = null,
    val imageUrl: String? = null,
)

/** One dish on a plate, as the week endpoint inlines it. */
@Serializable
data class WeekMealDish(
    val recipeId: String,
    val title: String? = null,
    val emoji: String? = null,
    val role: String = "",
    val sortOrder: Int = 0,
)

/**
 * The plate behind a meal-backed slot, carrying its dishes so the week grid can render
 * "BBQ Sunday · 4 dishes" instead of an empty slot.
 *
 * [name] is nullable because the server builds this off a left join that excludes
 * soft-deleted plates: an entry pointing at one serialises `name: null`. Required, that
 * single row would throw and take the WHOLE week fetch with it — blanking the week grid,
 * the month grid and the tonight card at once.
 */
@Serializable
data class WeekMealSlot(
    val id: String,
    val name: String? = null,
    val servings: Int? = null,
    val recipes: List<WeekMealDish> = emptyList(),
)

/**
 * One dinner/lunch/etc. slot in the planned week.
 *
 * A slot points at EITHER a single recipe ([recipeId]) or a Meal Builder plate
 * ([mealId]). **Never decide what a slot means by testing [recipeId] alone** — it is
 * null for a meal-backed slot, which on the web silently broke four surfaces at once.
 * Use [isMealBacked].
 */
@Serializable
data class WeekEntryDTO(
    val id: String,
    val date: String,
    val mealType: String,
    val title: String? = null,
    val recipeId: String? = null,
    val mealId: String? = null,
    val meal: WeekMealSlot? = null,
    val recipe: WeekRecipeInfo? = null,
    val cook: WeekCookDTO? = null,
) {
    /** The recipe title, the plate's name, the free-text title, or a placeholder. */
    val displayTitle: String
        get() = recipe?.title ?: meal?.name ?: title ?: "Planned meal"

    /**
     * This slot holds a plate rather than a single recipe.
     *
     * Gate on THIS, not on `recipeId != null`: a plate-backed slot has no `recipeId`, so
     * a `recipeId` test reads it as "nothing planned here" and the tap goes dead.
     */
    val isMealBacked: Boolean get() = mealId != null

    /** How many dishes the plate has (0 for an ordinary single-recipe slot). */
    val dishCount: Int get() = meal?.recipes?.size ?: 0

    /**
     * Whether tapping this slot has anything to open — a recipe OR a plate. The
     * free-text "eating out" entries have neither and stay inert.
     */
    val isOpenable: Boolean get() = recipeId != null || isMealBacked

    /** The emoji to draw for this slot, falling back to the generic plate. */
    val displayEmoji: String get() = recipe?.emoji ?: meal?.recipes?.firstOrNull()?.emoji ?: "🍽️"

    /**
     * A copy of this entry relocated to another slot — recipe, **plate**, free-text
     * title and cook all travel with it (mirrors what the server keeps on an upsert).
     *
     * The plate has to be carried explicitly: a slot backed by a plate has no
     * [recipeId], so rebuilding the entry from the recipe fields alone drops the dishes
     * and leaves the plate's name behind as dead text — a four-dish dinner silently
     * becomes a bare title the moment it is moved.
     */
    fun movedTo(date: String, slot: String): WeekEntryDTO = copy(date = date, mealType = slot)
}

/**
 * One AI-suggested meal for a night (mirrors the server `PlanCard`).
 *
 * [recipeId] is set when it matched a library recipe; otherwise it's a brand-new dish.
 * [mealId] is set when the user swapped in a saved Meal Builder plate — never both.
 */
@Serializable
data class PlanCardDTO(
    val date: String,
    val mealType: String,
    val title: String,
    val recipeId: String? = null,
    val emoji: String? = null,
    val minutes: Int? = null,
    val servings: Int? = null,
    val note: String? = null,
    val mealId: String? = null,
) {
    val key: String get() = "$date|$mealType|$title"
}

/**
 * The result of an AI "plan my week" run.
 *
 * [error] is set (with empty [suggestions]) when the provider failed at runtime; a
 * missing-provider 501 throws instead.
 */
@Serializable
data class PlanWeekResult(
    val start: String = "",
    val mealType: String = "dinner",
    val suggestions: List<PlanCardDTO> = emptyList(),
    val via: String? = null,
    val error: String? = null,
)

/**
 * The result of an AI "plan my month" run: drafted nights ([suggestions]) plus the
 * month's already-planned dinners ([existing], read-only context).
 */
@Serializable
data class PlanMonthResult(
    val start: String = "",
    val mealType: String = "dinner",
    val suggestions: List<PlanCardDTO> = emptyList(),
    val existing: List<PlanCardDTO> = emptyList(),
    val via: String? = null,
    val error: String? = null,
)

/** How many of a dish's ingredients the pantry already has. */
@Serializable
data class OnHandCount(val have: Int = 0, val total: Int = 0)

/**
 * One dish on a plate.
 *
 * [role] is free text ('main' | 'side' | 'dessert' today) — soft scaffolding to help
 * people compose, not a rigid taxonomy. Note it is NOT `mealType`, which already means
 * breakfast/lunch/dinner elsewhere.
 */
@Serializable
data class MealDishDTO(
    val recipeId: String,
    val title: String? = null,
    val emoji: String? = null,
    val category: String? = null,
    val role: String = "",
    val sortOrder: Int = 0,
    val prepTimeMinutes: Int? = null,
    val cookTimeMinutes: Int? = null,
    val servings: Int? = null,
    val imageUrl: String? = null,
    val cook: WeekCookDTO? = null,
    val onHand: OnHandCount? = null,
    val toBuy: Int = 0,
    val toBuyNames: List<String> = emptyList(),
) {
    val displayTitle: String get() = title ?: "Untitled recipe"

    /** Hands-on + cooking, when either is known. */
    val totalMinutes: Int?
        get() = if (prepTimeMinutes == null && cookTimeMinutes == null) {
            null
        } else {
            (prepTimeMinutes ?: 0) + (cookTimeMinutes ?: 0)
        }
}

/**
 * A whole plate — a named, multi-recipe meal.
 *
 * [onHand] and [toBuy] are plate-level and deduped across dishes: two dishes both
 * wanting mayonnaise is ONE thing to buy.
 */
@Serializable
data class MealDTO(
    val id: String,
    val name: String = "",
    val servings: Int = 4,
    val isSaved: Boolean = false,
    val createdBy: String? = null,
    val createdAt: String = "",
    val recipeCount: Int = 0,
    val emojis: List<String> = emptyList(),
    val totalMinutes: Int? = null,
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
         * slot — so tapping it can push the detail immediately instead of waiting on a
         * fetch. The detail reloads the real plate by id on appear.
         *
         * The fields a summary can't know are left empty rather than guessed: [onHand]
         * is null (no claim, same as pantry-off) and [toBuy] is 0, so nothing renders a
         * number that would then change under the reader a moment later.
         */
        fun placeholder(
            id: String,
            name: String,
            servings: Int = 4,
            dishes: List<WeekMealDish> = emptyList(),
        ) = MealDTO(
            id = id,
            name = name,
            servings = servings,
            recipeCount = dishes.size,
            emojis = dishes.mapNotNull { it.emoji },
            recipes = dishes.mapIndexed { i, d ->
                MealDishDTO(
                    recipeId = d.recipeId, title = d.title, emoji = d.emoji,
                    role = d.role, sortOrder = i,
                )
            },
        )
    }
}

/**
 * The plate behind a slot, as a pushable placeholder. Null for an ordinary recipe or a
 * free-text night.
 */
val WeekEntryDTO.platePlaceholder: MealDTO?
    get() = meal?.let {
        MealDTO.placeholder(
            id = it.id,
            name = it.name ?: title ?: "Meal",
            servings = it.servings ?: 4,
            dishes = it.recipes,
        )
    }

/**
 * A recipe as the library lists it.
 *
 * Only the fields the planner and the merged library need — the recipes feature owns the
 * full detail/editor shapes. [tags] is the merged set (source ∪ added − removed).
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
    val tags: List<String>? = null,
) {
    /** Hands-on + cooking, when either is known. */
    val totalTimeMinutes: Int?
        get() = if (prepTimeMinutes == null && cookTimeMinutes == null) {
            null
        } else {
            (prepTimeMinutes ?: 0) + (cookTimeMinutes ?: 0)
        }
}

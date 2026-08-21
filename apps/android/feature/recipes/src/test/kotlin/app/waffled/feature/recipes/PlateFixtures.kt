package app.waffled.feature.recipes

/**
 * Shared plate fixtures — the Kotlin twins of the helpers at the top of
 * `apps/ios/Tests/MealBuilderTests.swift`.
 */

fun plateDish(
    recipeId: String,
    title: String? = null,
    role: String = "side",
    sortOrder: Int = 0,
    prep: Int? = null,
    cookMinutes: Int? = null,
    cookName: String? = null,
    onHand: OnHandCount? = null,
    toBuy: Int = 0,
    toBuyNames: List<String> = emptyList(),
) = MealDishDTO(
    recipeId = recipeId,
    title = title,
    role = role,
    sortOrder = sortOrder,
    prepTimeMinutes = prep,
    cookTimeMinutes = cookMinutes,
    cook = cookName?.let { MealCookDTO(personId = "person-$it", name = it) },
    onHand = onHand,
    toBuy = toBuy,
    toBuyNames = toBuyNames,
)

fun plateFixture(
    id: String = "plate-1",
    name: String = "BBQ Sunday",
    servings: Int = 4,
    isSaved: Boolean = false,
    totalMinutes: Int? = null,
    onHand: OnHandCount? = null,
    toBuy: Int = 0,
    toBuyNames: List<String> = emptyList(),
    dishes: List<MealDishDTO> = emptyList(),
) = MealDTO(
    id = id,
    name = name,
    servings = servings,
    isSaved = isSaved,
    createdAt = "2026-08-11T18:35:41.000Z",
    recipeCount = dishes.size,
    totalMinutes = totalMinutes,
    onHand = onHand,
    toBuy = toBuy,
    toBuyNames = toBuyNames,
    recipes = dishes,
)

fun libRecipe(
    id: String,
    title: String,
    cuisine: String? = null,
    protein: String? = null,
    dietary: List<String>? = null,
    favorite: Boolean = false,
    cookedCount: Int = 0,
    minutes: Int? = null,
    lastCookedAt: String? = null,
) = RecipeSummary(
    id = id,
    title = title,
    cookTimeMinutes = minutes,
    isFavorite = favorite,
    cookedCount = cookedCount,
    lastCookedAt = lastCookedAt,
    protein = protein,
    cuisine = cuisine,
    dietary = dietary,
)

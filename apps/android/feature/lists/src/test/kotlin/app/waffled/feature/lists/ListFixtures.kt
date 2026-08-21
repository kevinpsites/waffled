package app.waffled.feature.lists

import app.waffled.core.network.WaffledJson

/**
 * Shared fixtures for the Lists suites.
 *
 * Rows are built by decoding minimal JSON rather than by calling the constructor, exactly
 * as the iOS suites do: it proves the DTO tolerates the shapes the server actually sends
 * (absent keys included) at the same time as it exercises the logic under test.
 */
internal fun row(json: String): ListItemDTO = WaffledJson.decodeFromString(json)

internal fun item(id: String, name: String, recipeIds: List<String> = emptyList()): ListItemDTO {
    val ids = recipeIds.joinToString(",") { "\"$it\"" }
    return row("""{"id":"$id","name":"$name","checked":false,"sourceRecipeIds":[$ids]}""")
}

internal fun sectioned(id: String, name: String, section: String?): ListItemDTO {
    val sec = section?.let { "\"$it\"" } ?: "null"
    return row("""{"id":"$id","name":"$name","checked":false,"section":$sec}""")
}

internal fun stored(id: String, name: String, store: String? = null): ListItemDTO {
    val s = store?.let { "\"$it\"" } ?: "null"
    return row("""{"id":"$id","name":"$name","checked":false,"store":$s}""")
}

internal fun meal(rid: String, title: String, date: String = "2026-07-13"): GroceryBoardDTO.Meal =
    WaffledJson.decodeFromString(
        """{"recipeId":"$rid","title":"$title","emoji":null,"color":"#2F7FED","date":"$date","mealType":"dinner"}""",
    )

/**
 * A Meal Builder plate on the board. Its items are tagged with its DISHES' recipe ids —
 * never with the plate's own id — and a plate-backed slot has no `recipeId`.
 */
internal fun platedMeal(
    mealId: String,
    name: String,
    dishes: List<String>,
    date: String = "2026-07-13",
): GroceryBoardDTO.Meal {
    val rs = dishes.mapIndexed { i, r ->
        """{"recipeId":"$r","title":"Dish $r","emoji":null,"role":"${if (i == 0) "main" else "side"}"}"""
    }.joinToString(",")
    return WaffledJson.decodeFromString(
        """{"recipeId":null,"mealId":"$mealId","title":"$name","emoji":null,"color":"#2F7FED",
            "date":"$date","mealType":"dinner","recipes":[$rs]}""",
    )
}

internal fun offPlan(rid: String, title: String): GroceryBoardDTO.UnscheduledRecipe =
    WaffledJson.decodeFromString(
        """{"recipeId":"$rid","title":"$title","emoji":"🥑","color":"#8B5CF6"}""",
    )

internal fun offPlanMeal(mealId: String, name: String, dishes: List<String>): GroceryBoardDTO.UnscheduledMeal {
    val rs = dishes.joinToString(",") { """{"recipeId":"$it","title":"Dish $it","emoji":null,"role":"main"}""" }
    return WaffledJson.decodeFromString(
        """{"mealId":"$mealId","name":"$name","color":"#8B5CF6","recipes":[$rs]}""",
    )
}

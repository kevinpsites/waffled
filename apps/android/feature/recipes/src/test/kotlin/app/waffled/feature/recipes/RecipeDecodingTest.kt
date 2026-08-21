package app.waffled.feature.recipes

import app.waffled.core.network.WaffledJson
import kotlinx.serialization.Serializable
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The plate + recipe-detail wire shapes, pinned against verbatim reply bodies — the
 * Kotlin port of `apps/ios/Tests/MealDecodingTests.swift` (the plate and recipe-detail
 * suites; the `WeekEntryDTO` and `GroceryBoardDTO` suites in that file belong to the
 * planner and lists features, not here).
 *
 * Why this exists: the plate shape is far richer than anything else in the app —
 * `title`, `emoji`, `category`, `imageUrl`, `prepTimeMinutes`, `cookTimeMinutes`,
 * `servings`, `cook` and `onHand` are ALL nullable server-side. The trap is that a
 * payload captured from a running stack has the **pantry module ON**, so `onHand` is
 * always populated in the sample; the pantry-off shape (`onHand: null`) never appears in
 * a capture and is exactly what a required field would blow up on.
 */
class RecipeDecodingTest {

    @Serializable private data class MealResponse(val meal: MealDTO)
    @Serializable private data class MealsResponse(val meals: List<MealDTO>)

    /** Verbatim `GET /api/meals/:id` with the pantry module **on**. */
    private val pantryOn = """
    {"meal":{"id":"11111111-1111-4111-8111-111111111111","name":"BBQ Sunday","servings":6,
    "isSaved":true,"createdBy":"22222222-2222-4222-8222-222222222222",
    "createdAt":"2026-08-11T18:35:41.000Z","recipeCount":2,"emojis":["🍗","🥗"],
    "totalMinutes":75,"onHand":{"have":5,"total":9},"toBuy":4,
    "toBuyNames":["paprika","cider vinegar","mayonnaise","brown sugar"],
    "recipes":[
      {"recipeId":"33333333-3333-4333-8333-333333333333","title":"BBQ Chicken","emoji":"🍗",
       "category":"main","role":"main","sortOrder":0,"prepTimeMinutes":15,"cookTimeMinutes":45,
       "servings":6,"imageUrl":"/media/bbq.jpg",
       "cook":{"personId":"44444444-4444-4444-8444-444444444444","name":"Kevin",
               "avatarEmoji":"🧑","colorHex":"#e5674f"},
       "onHand":{"have":3,"total":5},"toBuy":2,"toBuyNames":["paprika","brown sugar"]},
      {"recipeId":"55555555-5555-4555-8555-555555555555","title":"Potato Salad","emoji":"🥗",
       "category":"side","role":"side","sortOrder":1,"prepTimeMinutes":15,"cookTimeMinutes":null,
       "servings":8,"imageUrl":null,"cook":null,
       "onHand":{"have":2,"total":4},"toBuy":2,"toBuyNames":["cider vinegar","mayonnaise"]}]}}
    """.trimIndent()

    /** The same endpoint with the **pantry module off**: `onHand` null everywhere. */
    private val pantryOff = """
    {"meal":{"id":"11111111-1111-4111-8111-111111111111","name":"Weeknight pasta","servings":4,
    "isSaved":false,"createdBy":null,"createdAt":"2026-08-11T18:35:41.000Z","recipeCount":1,
    "emojis":[],"totalMinutes":null,"onHand":null,"toBuy":6,
    "toBuyNames":["penne","basil","garlic","cream","parmesan","chilli"],
    "recipes":[
      {"recipeId":"66666666-6666-4666-8666-666666666666","title":null,"emoji":null,
       "category":null,"role":"main","sortOrder":0,"prepTimeMinutes":null,"cookTimeMinutes":null,
       "servings":null,"imageUrl":null,"cook":null,"onHand":null,"toBuy":6,
       "toBuyNames":["penne","basil","garlic","cream","parmesan","chilli"]}]}}
    """.trimIndent()

    @Test
    fun decodesAPlateWithThePantryOn() {
        val meal = WaffledJson.decodeFromString<MealResponse>(pantryOn).meal
        assertEquals("BBQ Sunday", meal.name)
        assertEquals(6, meal.servings)
        assertTrue(meal.isSaved)
        assertEquals(2, meal.recipeCount)
        assertEquals(75, meal.totalMinutes)
        assertEquals(5, meal.onHand?.have)
        assertEquals(9, meal.onHand?.total)
        // The names behind the count — a bare number names nothing.
        assertEquals(4, meal.toBuy)
        assertEquals(4, meal.toBuyNames.size)
        assertEquals(2, meal.recipes.size)

        val main = meal.recipes.first()
        assertEquals("main", main.role)
        assertEquals(0, main.sortOrder)
        assertEquals("Kevin", main.cook?.name)
        assertEquals("#e5674f", main.cook?.colorHex)
        assertEquals(3, main.onHand?.have)

        // Per-dish cooks are the point: an unassigned dish decodes as "nobody yet"
        // rather than failing the whole plate.
        val side = meal.recipes.last()
        assertNull(side.cook)
        assertNull(side.cookTimeMinutes)
        assertNull(side.imageUrl)
    }

    @Test
    fun decodesAPlateWithThePantryOff() {
        val meal = WaffledJson.decodeFromString<MealResponse>(pantryOff).meal
        // Null, NOT `{have: 0, total: n}` — "we can't say" rather than the untrue claim
        // "you have none of these". Clients render nothing.
        assertNull(meal.onHand)
        assertNull(meal.createdBy)
        assertNull(meal.totalMinutes)
        assertTrue(meal.emojis.isEmpty())
        // "N to buy" is not pantry-derived and keeps working either way.
        assertEquals(6, meal.toBuy)
        assertEquals(6, meal.toBuyNames.size)

        val dish = meal.recipes.first()
        assertNull(dish.title)
        assertNull(dish.emoji)
        assertNull(dish.category)
        assertNull(dish.servings)
        assertNull(dish.onHand)
        assertEquals("Untitled recipe", dish.displayTitle)
    }

    /** The library list is the same plate shape under a different key. */
    @Test
    fun decodesTheSavedMealLibrary() {
        val body = """
        {"meals":[{"id":"11111111-1111-4111-8111-111111111111","name":"BBQ Sunday","servings":6,
        "isSaved":true,"createdBy":null,"createdAt":"2026-08-11T18:35:41.000Z","recipeCount":0,
        "emojis":[],"totalMinutes":null,"onHand":null,"toBuy":0,"toBuyNames":[],"recipes":[]}]}
        """.trimIndent()
        val meals = WaffledJson.decodeFromString<MealsResponse>(body).meals
        assertEquals(1, meals.size)
        assertTrue(meals[0].recipes.isEmpty())
    }

    // ---- recipe detail: the on-hand banner --------------------------------------

    @Test
    fun carriesRealOnHandWhenThePantryIsOn() {
        val body = """
        {"recipe":{"id":"r1","title":"BBQ Chicken","emoji":null,"category":null,"servings":4,
          "cookedCount":0,"isFavorite":false,"tags":[],"cuisines":[],"proteins":[],"dietary":[]},
         "ingredients":[],"steps":[],
         "onHand":{"have":4,"total":9},"toBuy":5,
         "toBuyNames":["paprika","cider vinegar","brown sugar","mayonnaise","chilli"]}
        """.trimIndent()
        val d = WaffledJson.decodeFromString<RecipeDetailDTO>(body)
        assertEquals(4, d.onHand?.have)
        assertEquals(9, d.onHand?.total)
        assertEquals(5, d.toBuy)
        assertEquals(5, d.toBuyNames?.size)
    }

    @Test
    fun makesNoOnHandClaimWhenThePantryIsOff() {
        val body = """
        {"recipe":{"id":"r1","title":"BBQ Chicken","emoji":null,"category":null,"servings":4,
          "cookedCount":0,"isFavorite":false,"tags":[],"cuisines":[],"proteins":[],"dietary":[]},
         "ingredients":[],"steps":[],"onHand":null,"toBuy":9,"toBuyNames":[]}
        """.trimIndent()
        val d = WaffledJson.decodeFromString<RecipeDetailDTO>(body)
        assertNull(d.onHand)
        // "N to buy" isn't pantry-derived and keeps working.
        assertEquals(9, d.toBuy)
    }

    /** A server predating the field omits it entirely — the screen must still load. */
    @Test
    fun stillDecodesARecipeFromAnOlderServer() {
        val body = """
        {"recipe":{"id":"r1","title":"BBQ Chicken","emoji":null,"category":null,"servings":4,
          "cookedCount":0,"isFavorite":false,"tags":[],"cuisines":[],"proteins":[],"dietary":[]},
         "ingredients":[],"steps":[]}
        """.trimIndent()
        val d = WaffledJson.decodeFromString<RecipeDetailDTO>(body)
        assertNull(d.onHand)
        assertNull(d.toBuy)
    }

    // ---- ingredients: the inPantry observation ----------------------------------

    /** `GET /api/recipes/:id` sends `inPantry` on every ingredient. */
    @Test
    fun decodesInPantry() {
        val json = """
        {"id":"a1","name":"Eggs","amount":2,"unit":null,"prepNote":null,"display":"2 eggs",
         "section":null,"aisle":"Dairy & Chilled","isStaple":false,"sortOrder":1,"sub":null,"inPantry":true}
        """.trimIndent()
        val i = WaffledJson.decodeFromString<RecipeIngredientDTO>(json)
        assertEquals(true, i.inPantry)
    }

    /**
     * A server predating the field, and every other ingredient payload in the app
     * (plates, cook mode, the meal builder) that never carried it. Must decode — a throw
     * here reads to the user as "couldn't reach server".
     */
    @Test
    fun decodesAnIngredientWithoutInPantry() {
        val json = """
        {"id":"a1","name":"Eggs","amount":2,"unit":null,"prepNote":null,"display":"2 eggs",
         "section":null,"aisle":null,"isStaple":false,"sortOrder":1,"sub":null}
        """.trimIndent()
        val i = WaffledJson.decodeFromString<RecipeIngredientDTO>(json)
        assertNull(i.inPantry)
    }

    /** A step with no timer, and one with. */
    @Test
    fun decodesSteps() {
        val json = """
        [{"stepNumber":1,"instruction":"Brine the chicken","ingredients":["salt"],"timerSeconds":null,"note":null},
         {"stepNumber":2,"instruction":"Grill","ingredients":[],"timerSeconds":900,"note":"low heat"}]
        """.trimIndent()
        val steps = WaffledJson.decodeFromString<List<RecipeStepDTO>>(json)
        assertNull(steps[0].timerSeconds)
        assertEquals(900, steps[1].timerSeconds)
        assertEquals("low heat", steps[1].note)
        assertEquals(listOf("salt"), steps[0].ingredients)
    }

    /**
     * The override blob `PATCH /api/recipes/:id` replaces wholesale. Every key is
     * optional, so a recipe that has never been edited decodes from `{}`.
     */
    @Test
    fun decodesAnEmptyOverrideBlob() {
        val o = WaffledJson.decodeFromString<RecipeOverrides>("{}")
        assertNull(o.addedTags)
        assertNull(o.stepNotes)
    }

    @Test
    fun decodesAPopulatedOverrideBlob() {
        val o = WaffledJson.decodeFromString<RecipeOverrides>(
            """{"addedTags":["weeknight"],"removedTags":["spicy"],"subs":{"a1":"oat milk"},
                "stepNotes":{"2":"watch it"},"dietary":["vegetarian"],"meta":{"cuisine":"thai"}}""",
        )
        assertEquals(listOf("weeknight"), o.addedTags)
        assertEquals("oat milk", o.subs?.get("a1"))
        assertEquals("watch it", o.stepNotes?.get("2"))
        assertEquals("thai", o.meta?.get("cuisine"))
    }

    /** The parse/ingest draft the editor hydrates from. */
    @Test
    fun decodesAParsedDraft() {
        val body = """
        {"recipe":{"title":"Tacos","emoji":"🌮","servings":4,"tags":["quick"],"notes":null,
          "sourceName":null,"mealType":"dinner","protein":"beef","base":null,"cuisine":"mexican",
          "effort":null,"cookMethod":null,"flavorProfile":null,"dietary":[],"vegetables":["onion"]},
         "ingredients":[{"name":"beef","amount":1.0,"unit":"lb","prepNote":null,"section":null}],
         "steps":[{"instruction":"Brown the beef","ingredients":["beef"]}],
         "via":"llm"}
        """.trimIndent()
        val p = WaffledJson.decodeFromString<ParsedRecipe>(body)
        assertEquals("Tacos", p.recipe.title)
        assertEquals(1.0, p.ingredients[0].amount)
        assertEquals("Brown the beef", p.steps[0].instruction)
    }

    /** A step in a draft with no ingredient list at all. */
    @Test
    fun decodesADraftStepWithoutIngredients() {
        val p = WaffledJson.decodeFromString<ParsedRecipe>(
            """{"recipe":{"title":"Toast"},"ingredients":[],"steps":[{"instruction":"Toast it"}]}""",
        )
        assertNotNull(p.steps[0])
        assertNull(p.steps[0].ingredients)
        assertEquals("Toast", p.recipe.title)
    }
}

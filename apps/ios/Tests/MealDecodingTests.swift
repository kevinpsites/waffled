import Foundation
import Testing
@testable import Waffled

// The Meal Builder DTOs decode a plate: a named, multi-recipe meal ("BBQ Sunday" =
// BBQ Chicken (main) + Potato Salad (side) + Peach Cobbler (dessert)).
//
// Why this file exists at all: strict Swift `Decodable` has already turned one
// server/client shape mismatch into a bogus "couldn't reach server" (the kiosk claim
// payload omitted a field the list carried). The plate shape is far richer than that
// one — `title`, `emoji`, `category`, `imageUrl`, `prepTimeMinutes`, `cookTimeMinutes`,
// `servings`, `cook` and `onHand` are ALL nullable server-side — so every optional is
// pinned here against verbatim reply bodies rather than an eyeballed curl.
//
// The trap these cases exist to close: a payload captured from a running stack has the
// **pantry module ON**, so `onHand` is always populated in the sample. The pantry-off
// shape (`onHand: null` — decision 14 deliberately omits it rather than sending a
// misleading `{have: 0}`) never appears in a capture, and is exactly the shape a
// non-optional field would crash on in the households that have pantry switched off.
struct MealDecodingTests {
    /// Verbatim `GET /api/meals/:id` body with the pantry module **on** — every
    /// on-hand count populated, a cook assigned to one dish.
    private static let pantryOn = Data("""
    {"meal":{"id":"11111111-1111-4111-8111-111111111111","name":"BBQ Sunday","servings":6,
    "isSaved":true,"createdBy":"22222222-2222-4222-8222-222222222222",
    "createdAt":"2026-08-11T18:35:41.000Z","recipeCount":2,"emojis":["\u{1F357}","\u{1F957}"],
    "totalMinutes":75,"onHand":{"have":5,"total":9},"toBuy":4,
    "toBuyNames":["paprika","cider vinegar","mayonnaise","brown sugar"],
    "recipes":[
      {"recipeId":"33333333-3333-4333-8333-333333333333","title":"BBQ Chicken","emoji":"\u{1F357}",
       "category":"main","role":"main","sortOrder":0,"prepTimeMinutes":15,"cookTimeMinutes":45,
       "servings":6,"imageUrl":"/media/bbq.jpg",
       "cook":{"personId":"44444444-4444-4444-8444-444444444444","name":"Kevin",
               "avatarEmoji":"\u{1F9D1}","colorHex":"#e5674f"},
       "onHand":{"have":3,"total":5},"toBuy":2,"toBuyNames":["paprika","brown sugar"]},
      {"recipeId":"55555555-5555-4555-8555-555555555555","title":"Potato Salad","emoji":"\u{1F957}",
       "category":"side","role":"side","sortOrder":1,"prepTimeMinutes":15,"cookTimeMinutes":null,
       "servings":8,"imageUrl":null,"cook":null,
       "onHand":{"have":2,"total":4},"toBuy":2,"toBuyNames":["cider vinegar","mayonnaise"]}]}}
    """.utf8)

    /// The same endpoint in a household with the **pantry module off**: `onHand` is
    /// null everywhere, but "N to buy" keeps working (it is not pantry-derived).
    private static let pantryOff = Data("""
    {"meal":{"id":"11111111-1111-4111-8111-111111111111","name":"Weeknight pasta","servings":4,
    "isSaved":false,"createdBy":null,"createdAt":"2026-08-11T18:35:41.000Z","recipeCount":1,
    "emojis":[],"totalMinutes":null,"onHand":null,"toBuy":6,
    "toBuyNames":["penne","basil","garlic","cream","parmesan","chilli"],
    "recipes":[
      {"recipeId":"66666666-6666-4666-8666-666666666666","title":null,"emoji":null,
       "category":null,"role":"main","sortOrder":0,"prepTimeMinutes":null,"cookTimeMinutes":null,
       "servings":null,"imageUrl":null,"cook":null,"onHand":null,"toBuy":6,
       "toBuyNames":["penne","basil","garlic","cream","parmesan","chilli"]}]}}
    """.utf8)

    private struct MealResponse: Decodable { let meal: WaffledAPI.MealDTO }

    @Test func decodesAPlateWithThePantryOn() throws {
        let meal = try WaffledAPI.decoder.decode(MealResponse.self, from: Self.pantryOn).meal
        #expect(meal.name == "BBQ Sunday")
        #expect(meal.servings == 6)
        #expect(meal.isSaved)
        #expect(meal.recipeCount == 2)
        #expect(meal.totalMinutes == 75)
        #expect(meal.onHand?.have == 5)
        #expect(meal.onHand?.total == 9)
        // The names behind the count — a bare number names nothing, so the plate
        // carries the actual shopping alongside it.
        #expect(meal.toBuy == 4)
        #expect(meal.toBuyNames.count == 4)
        #expect(meal.recipes.count == 2)

        let main = try #require(meal.recipes.first)
        #expect(main.role == "main")
        #expect(main.sortOrder == 0)
        #expect(main.cook?.name == "Kevin")
        #expect(main.cook?.colorHex == "#e5674f")
        #expect(main.onHand?.have == 3)

        // Per-dish cooks are the point: a four-dish plate has up to four cooks, so an
        // unassigned dish must decode as "nobody yet", not fail the whole plate.
        let side = try #require(meal.recipes.last)
        #expect(side.cook == nil)
        #expect(side.cookTimeMinutes == nil)
        #expect(side.imageUrl == nil)
    }

    @Test func decodesAPlateWithThePantryOff() throws {
        let meal = try WaffledAPI.decoder.decode(MealResponse.self, from: Self.pantryOff).meal
        // Null, NOT `{have: 0, total: n}` — "we can't say" rather than the untrue
        // claim "you have none of these". Clients render nothing.
        #expect(meal.onHand == nil)
        #expect(meal.createdBy == nil)
        #expect(meal.totalMinutes == nil)
        #expect(meal.emojis.isEmpty)
        // "N to buy" is not pantry-derived and keeps working either way.
        #expect(meal.toBuy == 6)
        #expect(meal.toBuyNames.count == 6)

        // Every nullable dish scalar at once — the shape a recipe with no metadata
        // produces, which no capture from a seeded stack would ever contain.
        let dish = try #require(meal.recipes.first)
        #expect(dish.title == nil)
        #expect(dish.emoji == nil)
        #expect(dish.category == nil)
        #expect(dish.servings == nil)
        #expect(dish.onHand == nil)
        #expect(dish.displayTitle == "Untitled recipe")
    }

    /// The library list (`GET /api/meals`) is the same plate shape, so one decode
    /// covers both — but it arrives under a different key.
    @Test func decodesTheSavedMealLibrary() throws {
        let body = Data("""
        {"meals":[{"id":"11111111-1111-4111-8111-111111111111","name":"BBQ Sunday","servings":6,
        "isSaved":true,"createdBy":null,"createdAt":"2026-08-11T18:35:41.000Z","recipeCount":0,
        "emojis":[],"totalMinutes":null,"onHand":null,"toBuy":0,"toBuyNames":[],"recipes":[]}]}
        """.utf8)
        struct Resp: Decodable { let meals: [WaffledAPI.MealDTO] }
        let meals = try WaffledAPI.decoder.decode(Resp.self, from: body).meals
        #expect(meals.count == 1)
        #expect(meals[0].recipes.isEmpty)
    }
}

// A planned slot points at EITHER a single recipe or a plate. When it points at a
// plate, `recipeId` is null — which on the web silently broke four separate surfaces
// that each decided what a slot meant by reading `recipeId`. The week grid drew a
// nameless row and the Tonight card claimed "No recipe attached yet" about a meal with
// three dishes.
struct WeekEntryMealDecodingTests {
    /// A meal-backed slot: `recipeId` null, `meal` carrying the plate and its dishes.
    private static let mealBacked = Data("""
    {"id":"77777777-7777-4777-8777-777777777777","date":"2026-08-16","mealType":"dinner",
    "title":"BBQ Sunday","recipeId":null,"mealId":"11111111-1111-4111-8111-111111111111",
    "meal":{"id":"11111111-1111-4111-8111-111111111111","name":"BBQ Sunday","servings":6,
      "recipes":[
        {"recipeId":"33333333-3333-4333-8333-333333333333","title":"BBQ Chicken",
         "emoji":"\u{1F357}","role":"main","sortOrder":0},
        {"recipeId":"55555555-5555-4555-8555-555555555555","title":"Potato Salad",
         "emoji":"\u{1F957}","role":"side","sortOrder":1}]},
    "recipe":null,"cook":null}
    """.utf8)

    /// An ordinary single-recipe slot from a server that predates Meal Builder —
    /// `mealId` and `meal` are absent entirely, not null. Both must still decode.
    private static let legacyRecipeBacked = Data("""
    {"id":"88888888-8888-4888-8888-888888888888","date":"2026-08-16","mealType":"dinner",
    "title":null,"recipeId":"33333333-3333-4333-8333-333333333333",
    "recipe":{"title":"BBQ Chicken","emoji":"\u{1F357}","category":"main","prepTimeMinutes":15,
      "cookTimeMinutes":45,"servings":6,"imageUrl":null},
    "cook":null}
    """.utf8)

    @Test func decodesAMealBackedSlot() throws {
        let e = try WaffledAPI.decoder.decode(WaffledAPI.WeekEntryDTO.self, from: Self.mealBacked)
        #expect(e.recipeId == nil)
        #expect(e.mealId == "11111111-1111-4111-8111-111111111111")
        #expect(e.meal?.name == "BBQ Sunday")
        #expect(e.meal?.recipes.count == 2)
        #expect(e.meal?.recipes.first?.role == "main")
        // The slot has a name even with no recipe behind it — the plate's.
        #expect(e.displayTitle == "BBQ Sunday")
        // What a tap means must key off this, never off `recipeId` being non-nil.
        #expect(e.isMealBacked)
        #expect(e.dishCount == 2)
    }

    /// A plan entry pointing at a soft-deleted plate. The server's `left join … and
    /// deleted_at is null` serialises `name: null`, and if that field were required the
    /// single bad row would throw and take the WHOLE week fetch with it — blanking the
    /// week grid, the month grid and the Tonight card at once.
    @Test func survivesASlotWhosePlateWasDeleted() throws {
        let body = Data("""
        {"id":"77777777-7777-4777-8777-777777777777","date":"2026-08-16","mealType":"dinner",
        "title":"BBQ Sunday","recipeId":null,"mealId":"11111111-1111-4111-8111-111111111111",
        "meal":{"id":"11111111-1111-4111-8111-111111111111","name":null,"servings":null,
          "recipes":[]},
        "recipe":null,"cook":null}
        """.utf8)
        let e = try WaffledAPI.decoder.decode(WaffledAPI.WeekEntryDTO.self, from: body)
        #expect(e.isMealBacked)
        // falls back to the slot's own title rather than rendering blank
        #expect(e.displayTitle == "BBQ Sunday")
        #expect(e.platePlaceholder?.name == "BBQ Sunday")
    }

    @Test func stillDecodesASlotFromAServerWithoutMeals() throws {
        let e = try WaffledAPI.decoder.decode(WaffledAPI.WeekEntryDTO.self, from: Self.legacyRecipeBacked)
        #expect(e.mealId == nil)
        #expect(e.meal == nil)
        #expect(e.isMealBacked == false)
        #expect(e.dishCount == 0)
        #expect(e.displayTitle == "BBQ Chicken")
        #expect(e.isOpenable)
    }

    /// A free-text night ("eating out") links nothing at all — it must stay inert, and
    /// must not be mistaken for a plate now that `recipeId == nil` no longer means
    /// "nothing here".
    @Test func afreeTextNightIsStillNotOpenable() throws {
        let body = Data("""
        {"id":"99999999-9999-4999-8999-999999999999","date":"2026-08-16","mealType":"dinner",
        "title":"Eating out","recipeId":null,"mealId":null,"meal":null,"recipe":null,"cook":null}
        """.utf8)
        let e = try WaffledAPI.decoder.decode(WaffledAPI.WeekEntryDTO.self, from: body)
        #expect(e.isMealBacked == false)
        #expect(e.isOpenable == false)
        #expect(e.displayTitle == "Eating out")
    }
}

// The recipe-detail "N of M on hand" banner. The count must come from the server's
// real pantry matching, never from `isStaple` — a staple is something you're assumed
// to keep around, not something you currently have, so counting staples tells a
// household with a completely empty pantry that it has 4 of 9 ingredients.
struct RecipeDetailOnHandDecodingTests {
    @Test func carriesRealOnHandWhenThePantryIsOn() throws {
        let body = Data("""
        {"recipe":{"id":"r1","title":"BBQ Chicken","emoji":null,"category":null,"servings":4,
          "cookedCount":0,"isFavorite":false,"tags":[],"cuisines":[],"proteins":[],"dietary":[]},
         "ingredients":[],"steps":[],
         "onHand":{"have":4,"total":9},"toBuy":5,
         "toBuyNames":["paprika","cider vinegar","brown sugar","mayonnaise","chilli"]}
        """.utf8)
        let d = try WaffledAPI.decoder.decode(WaffledAPI.RecipeDetailDTO.self, from: body)
        #expect(d.onHand?.have == 4)
        #expect(d.onHand?.total == 9)
        #expect(d.toBuy == 5)
        #expect(d.toBuyNames?.count == 5)
    }

    @Test func makesNoOnHandClaimWhenThePantryIsOff() throws {
        let body = Data("""
        {"recipe":{"id":"r1","title":"BBQ Chicken","emoji":null,"category":null,"servings":4,
          "cookedCount":0,"isFavorite":false,"tags":[],"cuisines":[],"proteins":[],"dietary":[]},
         "ingredients":[],"steps":[],"onHand":null,"toBuy":9,"toBuyNames":[]}
        """.utf8)
        let d = try WaffledAPI.decoder.decode(WaffledAPI.RecipeDetailDTO.self, from: body)
        #expect(d.onHand == nil)
        // "N to buy" isn't pantry-derived and keeps working.
        #expect(d.toBuy == 9)
    }

    /// A server predating the field omits it entirely — the screen must still load.
    @Test func stillDecodesARecipeFromAnOlderServer() throws {
        let body = Data("""
        {"recipe":{"id":"r1","title":"BBQ Chicken","emoji":null,"category":null,"servings":4,
          "cookedCount":0,"isFavorite":false,"tags":[],"cuisines":[],"proteins":[],"dietary":[]},
         "ingredients":[],"steps":[]}
        """.utf8)
        let d = try WaffledAPI.decoder.decode(WaffledAPI.RecipeDetailDTO.self, from: body)
        #expect(d.onHand == nil)
        #expect(d.toBuy == nil)
    }
}

// The grocery board groups a plate's shopping under the plate. Its rows are shaped
// differently from the week endpoint's — notably the dishes carry NO `sortOrder` (the
// board sends them already in plate order), so the two cannot share a dish type.
struct GroceryBoardMealDecodingTests {
    /// A board carrying one plate-backed slot, one ordinary recipe slot, and one plate
    /// that is on the list without being scheduled.
    private static let board = Data("""
    {"list":{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","name":"Grocery","emoji":null,
      "listType":"grocery","isAutoBuilt":true,"sortMode":null},
    "weekStart":"2026-08-10",
    "meals":[
      {"date":"2026-08-16","mealType":"dinner","recipeId":null,
       "mealId":"11111111-1111-4111-8111-111111111111","title":"BBQ Sunday","emoji":null,
       "color":"#e5674f","recipes":[
         {"recipeId":"33333333-3333-4333-8333-333333333333","title":"BBQ Chicken","emoji":"\u{1F357}","role":"main"},
         {"recipeId":"55555555-5555-4555-8555-555555555555","title":"Potato Salad","emoji":"\u{1F957}","role":"side"}]},
      {"date":"2026-08-17","mealType":"dinner","recipeId":"77777777-7777-4777-8777-777777777777",
       "mealId":null,"title":"Tacos","emoji":"\u{1F32E}","color":"#4f8ee5","recipes":[]}],
    "unscheduled":[],
    "unscheduledMeals":[
      {"mealId":"22222222-2222-4222-8222-222222222222","name":"Taco Tuesday","color":"#7ac74f",
       "recipes":[{"recipeId":"88888888-8888-4888-8888-888888888888","title":"Carnitas",
                   "emoji":"\u{1F32E}","role":"main"}]}],
    "items":[],"staples":[]}
    """.utf8)

    @Test func groupsAPlateByItsDishesNotItsOwnId() throws {
        let b = try WaffledAPI.decoder.decode(WaffledAPI.GroceryBoardDTO.self, from: Self.board)
        let plate = try #require(b.meals.first)
        #expect(plate.recipeId == nil)
        #expect(plate.mealId == "11111111-1111-4111-8111-111111111111")
        #expect(plate.recipes?.count == 2)
        // The whole point: a plate's list items are tagged with its DISHES' recipe ids,
        // so grouping must match on those. Keying off `recipeId` drops the plate.
        #expect(plate.contributingRecipeIds == ["33333333-3333-4333-8333-333333333333",
                                                "55555555-5555-4555-8555-555555555555"])
        // Two plates can't share a date+slot, but the id must still not collapse to
        // "|date|dinner" for every plate-backed row.
        #expect(plate.id.hasPrefix("11111111"))

        let single = try #require(b.meals.last)
        #expect(single.contributingRecipeIds == ["77777777-7777-4777-8777-777777777777"])

        let off = try #require(b.unscheduledMeals?.first)
        #expect(off.name == "Taco Tuesday")
        #expect(off.contributingRecipeIds == ["88888888-8888-4888-8888-888888888888"])
    }

    /// A board from a server predating Meal Builder omits `mealId`, `recipes` and
    /// `unscheduledMeals` entirely.
    @Test func stillDecodesABoardFromAServerWithoutMeals() throws {
        let body = Data("""
        {"list":{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","name":"Grocery","emoji":null,
          "listType":"grocery","isAutoBuilt":true,"sortMode":null},
        "weekStart":"2026-08-10",
        "meals":[{"date":"2026-08-17","mealType":"dinner","recipeId":"77777777-7777-4777-8777-777777777777",
          "title":"Tacos","emoji":"\u{1F32E}","color":"#4f8ee5"}],
        "items":[],"staples":[]}
        """.utf8)
        let b = try WaffledAPI.decoder.decode(WaffledAPI.GroceryBoardDTO.self, from: body)
        #expect(b.unscheduledMeals == nil)
        let m = try #require(b.meals.first)
        #expect(m.mealId == nil)
        #expect(m.recipes == nil)
        #expect(m.contributingRecipeIds == ["77777777-7777-4777-8777-777777777777"])
    }
}

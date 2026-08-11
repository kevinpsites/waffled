import Foundation
import Testing
@testable import Waffled

// "By meal" grouping with unscheduled recipes: items from a recipe added straight
// from its page (not planned this week) get their own section between the planned
// meals and the trailing "Staples & extras" group. DTOs are built by decoding
// minimal JSON, matching the other DTO-fixture tests.

private func item(_ id: String, _ name: String, recipeIds: [String] = []) -> WaffledAPI.ListItemDTO {
    let ids = recipeIds.map { "\"\($0)\"" }.joined(separator: ",")
    let json = "{\"id\":\"\(id)\",\"name\":\"\(name)\",\"checked\":false,\"sourceRecipeIds\":[\(ids)]}"
    return try! JSONDecoder().decode(WaffledAPI.ListItemDTO.self, from: Data(json.utf8))
}

private func meal(_ rid: String, _ title: String, date: String = "2026-07-13") -> WaffledAPI.GroceryBoardDTO.Meal {
    let json = "{\"recipeId\":\"\(rid)\",\"title\":\"\(title)\",\"emoji\":null,\"color\":\"#2F7FED\",\"date\":\"\(date)\",\"mealType\":\"dinner\"}"
    return try! JSONDecoder().decode(WaffledAPI.GroceryBoardDTO.Meal.self, from: Data(json.utf8))
}

private func offPlan(_ rid: String, _ title: String) -> WaffledAPI.GroceryBoardDTO.UnscheduledRecipe {
    let json = "{\"recipeId\":\"\(rid)\",\"title\":\"\(title)\",\"emoji\":\"🥑\",\"color\":\"#8B5CF6\"}"
    return try! JSONDecoder().decode(WaffledAPI.GroceryBoardDTO.UnscheduledRecipe.self, from: Data(json.utf8))
}

@Suite struct MealGroupingUnscheduledTests {
    @Test func unscheduledRecipeGetsItsOwnSection() {
        let items = [
            item("i1", "Tomatoes", recipeIds: ["r1"]),
            item("i2", "Avocados", recipeIds: ["r2"]),
            item("i3", "Cookies"),
        ]
        let groups = MealGrouping.sections(
            items: items,
            meals: [meal("r1", "Pasta")],
            unscheduled: [offPlan("r2", "Guacamole")]
        )
        #expect(groups.count == 3)
        #expect(groups[0].meal?.recipeId == "r1")
        #expect(groups[0].items.map(\.name) == ["Tomatoes"])
        #expect(groups[1].unscheduled?.recipeId == "r2")
        #expect(groups[1].unscheduled?.title == "Guacamole")
        #expect(groups[1].items.map(\.name) == ["Avocados"])
        #expect(groups[2].meal == nil && groups[2].unscheduled == nil)
        #expect(groups[2].items.map(\.name) == ["Cookies"])
    }

    @Test func plannedMealClaimsSharedItemsFirst() {
        // an item two recipes need shows once, under the planned meal
        let items = [item("i1", "Limes", recipeIds: ["r1", "r2"])]
        let groups = MealGrouping.sections(
            items: items,
            meals: [meal("r1", "Tacos")],
            unscheduled: [offPlan("r2", "Margaritas")]
        )
        #expect(groups.count == 1)
        #expect(groups[0].meal?.recipeId == "r1")
    }

    @Test func noUnscheduledBehavesAsBefore() {
        let items = [item("i1", "Tomatoes", recipeIds: ["r1"]), item("i2", "Cookies")]
        let groups = MealGrouping.sections(items: items, meals: [meal("r1", "Pasta")], unscheduled: [])
        #expect(groups.count == 2)
        #expect(groups[1].meal == nil)
    }

    @Test func emptyUnscheduledGroupIsDropped() {
        // no active items reference the off-plan recipe → no empty section
        let groups = MealGrouping.sections(
            items: [item("i1", "Cookies")],
            meals: [],
            unscheduled: [offPlan("r9", "Ghost Recipe")]
        )
        #expect(groups.count == 1)
        #expect(groups[0].meal == nil && groups[0].unscheduled == nil)
    }
}

// A Meal Builder plate on the grocery list. The plate's items are tagged with its
// DISHES' recipe ids — never with the plate's own id — and a plate-backed slot has no
// `recipeId` of its own. So grouping that keys off `recipeId` drops the whole plate
// from the "By meal" view, and an added plate looks like it was never added.
private func platedMeal(_ mealId: String, _ name: String, dishes: [String],
                        date: String = "2026-07-13") -> WaffledAPI.GroceryBoardDTO.Meal {
    let rs = dishes.enumerated().map { i, r in
        "{\"recipeId\":\"\(r)\",\"title\":\"Dish \(r)\",\"emoji\":null,\"role\":\"\(i == 0 ? "main" : "side")\"}"
    }.joined(separator: ",")
    let json = """
    {"recipeId":null,"mealId":"\(mealId)","title":"\(name)","emoji":null,"color":"#2F7FED",
     "date":"\(date)","mealType":"dinner","recipes":[\(rs)]}
    """
    return try! JSONDecoder().decode(WaffledAPI.GroceryBoardDTO.Meal.self, from: Data(json.utf8))
}

private func offPlanMeal(_ mealId: String, _ name: String, dishes: [String]) -> WaffledAPI.GroceryBoardDTO.UnscheduledMeal {
    let rs = dishes.map { "{\"recipeId\":\"\($0)\",\"title\":\"Dish \($0)\",\"emoji\":null,\"role\":\"main\"}" }
        .joined(separator: ",")
    let json = "{\"mealId\":\"\(mealId)\",\"name\":\"\(name)\",\"color\":\"#8B5CF6\",\"recipes\":[\(rs)]}"
    return try! JSONDecoder().decode(WaffledAPI.GroceryBoardDTO.UnscheduledMeal.self, from: Data(json.utf8))
}

@Suite struct MealGroupingPlateTests {
    @Test func aPlateGroupsItsDishesItemsUnderOneHeading() {
        let items = [
            item("i1", "Chicken thighs", recipeIds: ["d1"]),
            item("i2", "Mayonnaise", recipeIds: ["d2"]),
            item("i3", "Cookies"),
        ]
        let groups = MealGrouping.sections(
            items: items,
            meals: [platedMeal("m1", "BBQ Sunday", dishes: ["d1", "d2"])]
        )
        #expect(groups.count == 2)
        #expect(groups[0].meal?.mealId == "m1")
        // One heading for the whole plate — both dishes' shopping under it.
        #expect(groups[0].items.map(\.name) == ["Chicken thighs", "Mayonnaise"])
        #expect(groups[1].meal == nil)
    }

    @Test func anUnscheduledPlateGetsItsOwnSection() {
        let items = [item("i1", "Carnitas", recipeIds: ["d9"]), item("i2", "Cookies")]
        let groups = MealGrouping.sections(
            items: items,
            meals: [],
            unscheduledMeals: [offPlanMeal("m2", "Taco Tuesday", dishes: ["d9"])]
        )
        #expect(groups.count == 2)
        #expect(groups[0].unscheduledMeal?.name == "Taco Tuesday")
        #expect(groups[0].items.map(\.name) == ["Carnitas"])
    }

    /// Every item a plate wants was already claimed by an earlier meal. Dropping the
    /// section makes an added plate look un-added, so it keeps its heading rather than
    /// duplicating rows — one item, one checkbox.
    @Test func aFullyOverlappedPlateKeepsItsHeading() {
        let items = [item("i1", "Limes", recipeIds: ["r1", "d1"])]
        let groups = MealGrouping.sections(
            items: items,
            meals: [meal("r1", "Tacos"), platedMeal("m1", "BBQ Sunday", dishes: ["d1"], date: "2026-07-14")]
        )
        #expect(groups.count == 2)
        #expect(groups[0].meal?.recipeId == "r1")
        #expect(groups[0].items.count == 1)
        let plate = groups[1]
        #expect(plate.meal?.mealId == "m1")
        #expect(plate.items.isEmpty)      // its shopping is above, not duplicated here
    }

    /// A plain recipe section with nothing in it is still dropped — only a plate
    /// earns an empty heading, because only a plate can be explicitly "added".
    @Test func anEmptyRecipeSectionIsStillDropped() {
        let groups = MealGrouping.sections(items: [item("i1", "Cookies")], meals: [meal("r9", "Ghost")])
        #expect(groups.count == 1)
        #expect(groups[0].meal == nil)
    }
}

// The per-item provenance dots. One dot per *source* — a plate is ONE source however
// many of its dishes want the item, which is why this can't just dedupe by recipe id.
@Suite struct MealDotsTests {
    @Test func aPlateGetsOneDotHoweverManyOfItsDishesWantTheItem() {
        // Mayonnaise wanted by two dishes of the same plate: one plate, one dot.
        let it = item("i1", "Mayonnaise", recipeIds: ["d1", "d2"])
        let colors = MealDots.colors(for: it,
                                     meals: [platedMeal("m1", "BBQ Sunday", dishes: ["d1", "d2"])],
                                     unscheduledMeals: [], unscheduled: [])
        #expect(colors == ["#2F7FED"])
    }

    @Test func aRecipePlannedTwiceIsStillOneDot() {
        let it = item("i1", "Limes", recipeIds: ["r1"])
        let colors = MealDots.colors(for: it,
                                     meals: [meal("r1", "Tacos", date: "2026-07-13"),
                                             meal("r1", "Tacos again", date: "2026-07-15")],
                                     unscheduledMeals: [], unscheduled: [])
        #expect(colors.count == 1)
    }

    @Test func aPlateAndAnUnrelatedRecipeAreTwoDots() {
        let it = item("i1", "Limes", recipeIds: ["d1", "r1"])
        let colors = MealDots.colors(for: it,
                                     meals: [platedMeal("m1", "BBQ Sunday", dishes: ["d1"]),
                                             meal("r1", "Tacos", date: "2026-07-15")],
                                     unscheduledMeals: [], unscheduled: [])
        #expect(colors.count == 2)
    }

    @Test func anOffPlanPlateGetsItsDotToo() {
        let it = item("i1", "Carnitas", recipeIds: ["d9"])
        let colors = MealDots.colors(for: it, meals: [],
                                     unscheduledMeals: [offPlanMeal("m2", "Taco Tuesday", dishes: ["d9"])],
                                     unscheduled: [])
        #expect(colors == ["#8B5CF6"])
    }

    @Test func anItemNobodyClaimsHasNoDots() {
        let colors = MealDots.colors(for: item("i1", "Cookies"), meals: [meal("r1", "Tacos")],
                                     unscheduledMeals: [], unscheduled: [])
        #expect(colors.isEmpty)
    }
}

// Section grouping: the "Items" fallback header must NOT be a real category. A drag into
// it writes `sectionValue` (nil), not the display "Items" — otherwise the moved item
// splits off a second "ITEMS" group (the bug the drag-and-drop first shipped).
private func sectioned(_ id: String, _ name: String, section: String?) -> WaffledAPI.ListItemDTO {
    let sec = section.map { "\"\($0)\"" } ?? "null"
    let json = "{\"id\":\"\(id)\",\"name\":\"\(name)\",\"checked\":false,\"section\":\(sec)}"
    return try! JSONDecoder().decode(WaffledAPI.ListItemDTO.self, from: Data(json.utf8))
}

@Suite struct ListSectionGroupingTests {
    @Test func ungroupedFallbackShowsItemsHeaderButNilCategory() {
        let groups = ListGrouping.sections([
            sectioned("a", "Rain jacket", section: "Clothes"),
            sectioned("b", "Trash bags", section: nil),
            sectioned("c", "Beach towel", section: nil),
        ])
        let ungrouped = groups.last!
        #expect(ungrouped.title == "Items")       // display header
        #expect(ungrouped.sectionValue == nil)     // real category — the fix
        #expect(ungrouped.items.count == 2)
    }

    @Test func realSectionKeepsItsValueAndDoesNotCollideWithUngrouped() {
        // A user-named "Items" section AND uncategorized items: distinct groups, distinct ids.
        let groups = ListGrouping.sections([
            sectioned("a", "Boxed", section: "Items"),
            sectioned("b", "Loose", section: nil),
        ])
        let ids = Set(groups.map(\.id))
        #expect(ids.count == groups.count)         // no id collision
        let real = groups.first { $0.sectionValue == "Items" }
        #expect(real?.title == "Items")
        let fallback = groups.first { $0.sectionValue == nil }
        #expect(fallback?.title == "Items" && fallback?.id == "__ungrouped__")
    }

    @Test func allUngroupedIsASingleHeaderlessGroup() {
        let groups = ListGrouping.sections([
            sectioned("a", "One", section: nil),
            sectioned("b", "Two", section: nil),
        ])
        #expect(groups.count == 1)
        #expect(groups[0].title == nil && groups[0].sectionValue == nil)
    }
}

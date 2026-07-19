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

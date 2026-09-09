import Foundation
import Testing
@testable import Waffled

// A saved plate is a first-class citizen of the recipe library: same grid, a type badge, and the
// search box matches it. The subtlety to encode rather than assume: plates carry NO cuisine,
// protein or dietary metadata, so the filter that *selects* them has to be a **type** filter —
// a facet would filter itself out.

private func libRecipe(_ id: String, _ title: String, cuisine: String? = nil,
                       protein: String? = nil, dietary: [String]? = nil,
                       favorite: Bool = false, cookedCount: Int = 0,
                       minutes: Int? = nil) -> WaffledAPI.RecipeSummary {
    WaffledAPI.RecipeSummary(
        id: id, title: title, emoji: nil, category: nil,
        prepTimeMinutes: nil, cookTimeMinutes: minutes, servings: nil, imageUrl: nil,
        sourceName: nil, isFavorite: favorite, cookedCount: cookedCount, lastCookedAt: nil,
        mealType: nil, protein: protein, base: nil, cuisine: cuisine, effort: nil,
        cookMethod: nil, flavorProfile: nil, dietary: dietary, vegetables: nil,
        collection: nil, tags: nil, addedTags: nil, notes: nil, userNotes: nil, overrides: nil)
}

@Suite struct MealLibraryTests {
    private var recipes: [WaffledAPI.RecipeSummary] {
        [libRecipe("r1", "Tacos", cuisine: "mexican", protein: "beef", minutes: 30),
         libRecipe("r2", "Miso Soup", cuisine: "japanese", dietary: ["vegetarian"], minutes: 15)]
    }

    private var meals: [WaffledAPI.MealDTO] {
        [plateFixture("m1", name: "BBQ Sunday", totalMinutes: 75,
                      dishes: [plateDish("r9", "BBQ Chicken", role: "main"),
                               plateDish("r8", "Coleslaw", role: "side")]),
         plateFixture("m2", name: "Taco Night", totalMinutes: 25,
                      dishes: [plateDish("r1", "Tacos", role: "main")])]
    }

    private func entries(_ f: LibraryFilters) -> [LibraryEntry] {
        LibraryFilter.entries(recipes: recipes, meals: meals, filters: f,
                              haystacks: LibraryFilter.haystacks(recipes: recipes, meals: meals))
    }

    @Test func mergesPlatesIntoTheRecipeLibrary() {
        let ids = entries(LibraryFilters()).map(\.id)
        #expect(Set(ids) == ["r1", "r2", "m1", "m2"])
    }

    @Test func aPlateIsMarkedAsAMeal() {
        let list = entries(LibraryFilters())
        #expect(list.first { $0.id == "m1" }?.isMeal == true)
        #expect(list.first { $0.id == "r1" }?.isMeal == false)
    }

    /// Searching a DISH's title finds the plate that contains it, whose own name has no such word.
    @Test func searchMatchesAPlateByOneOfItsDishes() {
        var f = LibraryFilters()
        f.query = "chicken"
        #expect(entries(f).map(\.id) == ["m1"])
    }

    @Test func searchStillMatchesAPlateByItsOwnName() {
        var f = LibraryFilters()
        f.query = "bbq sunday"
        #expect(entries(f).map(\.id) == ["m1"])
    }

    @Test func theMealsTypeFilterSelectsOnlyPlates() {
        var f = LibraryFilters()
        f.type = .meals
        #expect(Set(entries(f).map(\.id)) == ["m1", "m2"])
    }

    @Test func theRecipesTypeFilterExcludesPlates() {
        var f = LibraryFilters()
        f.type = .recipes
        #expect(Set(entries(f).map(\.id)) == ["r1", "r2"])
    }

    /// A structured facet legitimately drops every plate — which is why the selector had to be
    /// a type filter and not a facet.
    @Test func aStructuredFacetExcludesEveryPlate() {
        var f = LibraryFilters()
        f.cuisine = ["mexican"]
        #expect(entries(f).map(\.id) == ["r1"])

        var g = LibraryFilters()
        g.onlyFavorites = true
        #expect(g.anyStructured)
        #expect(entries(g).isEmpty)
    }

    @Test func sortsTheMergedListAlphabetically() {
        var f = LibraryFilters()
        f.sort = .az
        #expect(entries(f).map(\.title) == ["BBQ Sunday", "Miso Soup", "Taco Night", "Tacos"])
    }

    @Test func sortsPlatesByTheirTotalTime() {
        var f = LibraryFilters()
        f.sort = .quickest
        #expect(entries(f).map(\.id) == ["r2", "m2", "r1", "m1"])
    }

    @Test func cookHistorySortsPlatesLast() {
        let cooked = [libRecipe("r1", "Tacos", cookedCount: 9)]
        var f = LibraryFilters()
        f.sort = .mostCooked
        let list = LibraryFilter.entries(recipes: cooked, meals: meals, filters: f,
                                         haystacks: LibraryFilter.haystacks(recipes: cooked, meals: meals))
        #expect(list.first?.id == "r1")
        #expect(list.dropFirst().allSatisfy { $0.isMeal })
    }
}

// MARK: - what the library's ＋ offers

/// The rule is the same one that governs whether PLATE CARDS are shown: offer a plate only to a
/// caller that can take one back. A picker whose host has nowhere to put a plate must not offer
/// to build one.
@Suite struct LibraryNewOfferTests {

    @Test func browsingOffersBoth() {
        #expect(LibraryNewOffer.of(canPickMeal: true) == .recipeAndMeal)
    }

    @Test func aPickerThatCanTakeAPlateOffersToBuildOne() {
        #expect(LibraryNewOffer.of(canPickMeal: true).offersMeal)
    }

    @Test func aPickerThatCannotTakeAPlateOffersOnlyARecipe() {
        let offer = LibraryNewOffer.of(canPickMeal: false)
        #expect(offer == .recipeOnly)
        #expect(!offer.offersMeal)
        #expect(offer.offersRecipe)
    }
}

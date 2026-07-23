import Foundation

/// A run of list items under one section header (an aisle for grocery, a category
/// like "Clothes"/"Gear" for other lists). `title` is nil for ungrouped items.
struct ListSectionGroup: Identifiable {
    let title: String?
    let items: [WaffledAPI.ListItemDTO]
    /// The category value to persist for items in this group (nil = no category / clear).
    /// This differs from `title` ONLY for the ungrouped fallback: its header reads "Items"
    /// for display, but its real category is nil — so a drag-and-drop into it must write
    /// nil, not a literal "Items" section (which would split off a duplicate "ITEMS" group
    /// with a colliding id). Defaults to `title` for real sections.
    let sectionValue: String?
    /// Identity keys off the real category (not the display title), so a user-named
    /// "Items" section and the ungrouped "Items" fallback don't collide.
    var id: String { sectionValue ?? "__ungrouped__" }
    /// Real section: the category to write equals the display title.
    init(title: String?, items: [WaffledAPI.ListItemDTO]) {
        self.init(title: title, items: items, sectionValue: title)
    }
    /// Explicit write-back value (the ungrouped fallback passes nil with a "Items" title).
    init(title: String?, items: [WaffledAPI.ListItemDTO], sectionValue: String?) {
        self.title = title
        self.items = items
        self.sectionValue = sectionValue
    }
}

enum MealGrouping {
    /// Group items under the first meal (by date) whose recipe needs them, then give
    /// each unscheduled recipe (on the list but not on this week's plan) its own
    /// group; anything left falls into a trailing "Staples & extras" group
    /// (meal == nil, unscheduled == nil). Each item appears once — planned meals
    /// claim shared items first.
    static func sections(
        items: [WaffledAPI.ListItemDTO],
        meals: [WaffledAPI.GroceryBoardDTO.Meal],
        unscheduled: [WaffledAPI.GroceryBoardDTO.UnscheduledRecipe] = []
    ) -> [MealGroup] {
        var groups: [MealGroup] = []
        var used = Set<String>()
        for m in meals.sorted(by: { $0.date < $1.date }) {
            guard let rid = m.recipeId else { continue }
            let its = items.filter { !used.contains($0.id) && ($0.sourceRecipeIds ?? []).contains(rid) }
            guard !its.isEmpty else { continue }
            its.forEach { used.insert($0.id) }
            groups.append(MealGroup(meal: m, items: its))
        }
        for u in unscheduled {
            let its = items.filter { !used.contains($0.id) && ($0.sourceRecipeIds ?? []).contains(u.recipeId) }
            guard !its.isEmpty else { continue }
            its.forEach { used.insert($0.id) }
            groups.append(MealGroup(meal: nil, items: its, unscheduled: u))
        }
        let extras = items.filter { !used.contains($0.id) }
        if !extras.isEmpty { groups.append(MealGroup(meal: nil, items: extras)) }
        return groups
    }
}

enum ListGrouping {
    /// Group items by their section in a *stable* order (independent of item order,
    /// so editing an item's section never reshuffles the headers). Sections in
    /// `preferredOrder` come first in that order (e.g. grocery aisles in shopping
    /// order); any remaining sections follow alphabetically. Ungrouped items fall
    /// into a trailing "Items" group — unless nothing has a section, in which case
    /// there's a single header-less group. Item order within a section is preserved.
    static func sections(_ items: [WaffledAPI.ListItemDTO], preferredOrder: [String] = []) -> [ListSectionGroup] {
        let ungroupedKey = "\u{1}Items"
        var buckets: [String: [WaffledAPI.ListItemDTO]] = [:]
        for item in items {
            let key = (item.section?.isEmpty == false) ? item.section! : ungroupedKey
            buckets[key, default: []].append(item)
        }

        let realKeys = buckets.keys.filter { $0 != ungroupedKey }
        guard !realKeys.isEmpty else {
            return items.isEmpty ? [] : [ListSectionGroup(title: nil, items: items)]
        }

        let lowerOrder = preferredOrder.map { $0.lowercased() }
        func rank(_ key: String) -> Int? { lowerOrder.firstIndex(of: key.lowercased()) }
        let preferred = realKeys.filter { rank($0) != nil }.sorted { rank($0)! < rank($1)! }
        let others = realKeys.filter { rank($0) == nil }
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }

        var ordered = preferred + others
        if buckets[ungroupedKey] != nil { ordered.append(ungroupedKey) }

        return ordered.map { key in
            let ungrouped = key == ungroupedKey
            // Ungrouped items show under an "Items" header but carry NO real category, so
            // sectionValue is nil — dragging one in clears the category instead of minting a
            // literal "Items" section (which duplicated the header + collided on id).
            return ListSectionGroup(title: ungrouped ? "Items" : key,
                                    items: buckets[key] ?? [],
                                    sectionValue: ungrouped ? nil : key)
        }
    }
}

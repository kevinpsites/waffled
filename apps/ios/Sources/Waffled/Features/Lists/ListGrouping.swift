import Foundation

/// A run of list items under one section header (an aisle for grocery, a category
/// like "Clothes"/"Gear" for other lists). `title` is nil for ungrouped items.
struct ListSectionGroup: Identifiable {
    let title: String?
    let items: [WaffledAPI.ListItemDTO]
    var id: String { title ?? "__none__" }
}

enum MealGrouping {
    /// Group items under the first meal (by date) whose recipe needs them; anything
    /// meal-less falls into a trailing "Staples & extras" group (meal == nil). Each
    /// item appears once.
    static func sections(items: [WaffledAPI.ListItemDTO], meals: [WaffledAPI.GroceryBoardDTO.Meal]) -> [MealGroup] {
        var groups: [MealGroup] = []
        var used = Set<String>()
        for m in meals.sorted(by: { $0.date < $1.date }) {
            guard let rid = m.recipeId else { continue }
            let its = items.filter { !used.contains($0.id) && ($0.sourceRecipeIds ?? []).contains(rid) }
            guard !its.isEmpty else { continue }
            its.forEach { used.insert($0.id) }
            groups.append(MealGroup(meal: m, items: its))
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
            ListSectionGroup(title: key == ungroupedKey ? "Items" : key, items: buckets[key] ?? [])
        }
    }
}

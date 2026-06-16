import Foundation

/// A run of list items under one section header (an aisle for grocery, a category
/// like "Clothes"/"Gear" for other lists). `title` is nil for ungrouped items.
struct ListSectionGroup: Identifiable {
    let title: String?
    let items: [NookAPI.ListItemDTO]
    var id: String { title ?? "__none__" }
}

enum ListGrouping {
    /// Group items by their section in a *stable* order (independent of item order,
    /// so editing an item's section never reshuffles the headers). Sections in
    /// `preferredOrder` come first in that order (e.g. grocery aisles in shopping
    /// order); any remaining sections follow alphabetically. Ungrouped items fall
    /// into a trailing "Items" group — unless nothing has a section, in which case
    /// there's a single header-less group. Item order within a section is preserved.
    static func sections(_ items: [NookAPI.ListItemDTO], preferredOrder: [String] = []) -> [ListSectionGroup] {
        let ungroupedKey = "\u{1}Items"
        var buckets: [String: [NookAPI.ListItemDTO]] = [:]
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

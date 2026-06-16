import Foundation

/// A run of list items under one section header (an aisle for grocery, a category
/// like "Clothes"/"Gear" for other lists). `title` is nil for ungrouped items.
struct ListSectionGroup: Identifiable {
    let title: String?
    let items: [NookAPI.ListItemDTO]
    var id: String { title ?? "__none__" }
}

enum ListGrouping {
    /// Group items by their section, preserving first-seen section order. Items with
    /// no section fall into a trailing "Items" group — unless nothing has a section,
    /// in which case there's a single header-less group.
    static func sections(_ items: [NookAPI.ListItemDTO]) -> [ListSectionGroup] {
        let hasAnySection = items.contains { ($0.section?.isEmpty == false) }
        guard hasAnySection else {
            return items.isEmpty ? [] : [ListSectionGroup(title: nil, items: items)]
        }

        var order: [String] = []
        var buckets: [String: [NookAPI.ListItemDTO]] = [:]
        let ungroupedKey = "\u{1}Items"   // sorts via explicit append below, not by name
        for item in items {
            let key = (item.section?.isEmpty == false) ? item.section! : ungroupedKey
            if buckets[key] == nil { order.append(key); buckets[key] = [] }
            buckets[key]!.append(item)
        }
        // Keep the ungrouped bucket last regardless of where it first appeared.
        order.removeAll { $0 == ungroupedKey }
        if buckets[ungroupedKey] != nil { order.append(ungroupedKey) }

        return order.map { key in
            ListSectionGroup(title: key == ungroupedKey ? "Items" : key, items: buckets[key] ?? [])
        }
    }
}

import Foundation

/// "Share list" — turns a list's UNCHECKED items into phone-friendly plain text,
/// grouped in the board's walking order:
///
///     PRODUCE
///     - Asparagus (2 bunch)
///
///     DAIRY & CHILLED
///     - Milk (1 gal)
///
/// A direct port of the web formatter (`apps/web/src/kiosk/components/share-list.ts`),
/// kept behaviour-identical so the same list shares the same text from either
/// platform — the tests mirror its suite case for case.
///
/// On iOS the text goes to the system share sheet rather than a QR code: the web
/// QR exists to get the list *onto* a phone, and here the app already is one.
enum ShareList {
    /// The canonical aisle walking order — mirrors the web's `AISLE_ORDER` and the
    /// grocery board's section order.
    static let aisleOrder = ["Produce", "Dairy & Chilled", "Meat & Seafood", "Pantry", "Bakery", "Frozen", "Other"]

    private static let other = "Other"

    /// The slice of a list row the formatter needs.
    struct Item: Equatable, Sendable {
        let name: String
        let quantity: String?
        let checked: Bool
        /// Aisle (grocery) or section (custom list); "" when the row isn't grouped.
        let group: String
        /// Where to buy it, when the household has assigned a store.
        var store: String? = nil
        /// Who it's for, when it's assigned to someone.
        var assignee: String? = nil
    }

    /// Adapt a real list row. Grocery rows are grouped by `aisle`, custom-list rows
    /// by `section` — one adapter so both kinds of list share the formatter.
    static func item(from dto: WaffledAPI.ListItemDTO) -> Item {
        Item(name: dto.name,
             quantity: dto.quantity,
             checked: dto.checked,
             group: dto.aisle ?? dto.section ?? "",
             store: dto.store,
             assignee: dto.assignee?.name)
    }

    /// Store and assignee are the two things a shopper needs that the name doesn't
    /// carry. Both are usually unset, so a row only gains a trailing note when the
    /// household actually filled one in.
    ///
    /// Bracketed, NOT dash-separated: item names already use an em dash for allergen
    /// warnings ("Shredded mozzarella — contains milk"), so a dash here would read as
    /// more of the name.
    private static func line(_ i: Item) -> String {
        let notes = [i.store, i.assignee]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let qty = (i.quantity?.isEmpty == false) ? " (\(i.quantity!))" : ""
        let note = notes.isEmpty ? "" : " [\(notes.joined(separator: " · "))]"
        return "- \(i.name)\(qty)\(note)"
    }

    /// Unchecked items → grouped plain text ("" when nothing is left to get).
    ///
    /// Known aisles lead in walking order, then any unrecognized groups, then the
    /// OTHER catch-all last (it's a fallback, so it should never push a real section
    /// down the page).
    ///
    /// A list with NO grouping at all comes out flat with no headers: a lone "OTHER"
    /// over every line is noise, and custom lists frequently have no sections.
    static func format(_ items: [Item]) -> String {
        var byGroup: [String: [Item]] = [:]
        var order: [String] = []          // first-seen order, for unknown groups
        var anyGrouped = false
        for i in items where !i.checked {
            if !i.group.isEmpty { anyGrouped = true }
            let group = i.group.isEmpty ? other : i.group
            if byGroup[group] == nil { order.append(group) }
            byGroup[group, default: []].append(i)
        }

        let all = order.flatMap { byGroup[$0] ?? [] }
        guard !all.isEmpty else { return "" }
        // Nothing carried a section — headers would add nothing to read.
        if !anyGrouped { return all.map(line).joined(separator: "\n") }

        let known = aisleOrder.filter { $0 != other && byGroup[$0] != nil }
        let unknown = order.filter { $0 != other && !aisleOrder.contains($0) }
        let ordered = known + unknown + (byGroup[other] != nil ? [other] : [])

        return ordered
            .map { "\($0.uppercased())\n\((byGroup[$0] ?? []).map(line).joined(separator: "\n"))" }
            .joined(separator: "\n\n")
    }

    /// Convenience: format straight from list rows.
    static func format(rows: [WaffledAPI.ListItemDTO]) -> String {
        format(rows.map(item(from:)))
    }
}

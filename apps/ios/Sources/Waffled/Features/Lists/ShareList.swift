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

    /// Adapt a real list row.
    ///
    /// `section` first, because that is what the board on screen groups by
    /// (`ListGrouping.sections`) and the shared text must not contradict it. The two
    /// disagree in practice: "Move to section" updates `section` optimistically and
    /// leaves `aisle` stale, and a row categorized "Other" comes back with
    /// `section: "Other"` beside an `aisle` the server guessed from the name.
    /// Grocery rows still group by aisle — `load()` backfills `section` from `aisle`
    /// when the row has no section of its own — so `aisle` is the fallback for rows
    /// that arrive before that backfill.
    static func item(from dto: WaffledAPI.ListItemDTO) -> Item {
        Item(name: dto.name,
             quantity: dto.quantity,
             checked: dto.checked,
             group: dto.section ?? dto.aisle ?? "",
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
    /// The item text itself, without any bullet — each output format prefixes its own.
    private static func itemText(_ i: Item) -> String {
        let notes = [i.store, i.assignee]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let qty = (i.quantity?.isEmpty == false) ? " (\(i.quantity!))" : ""
        let note = notes.isEmpty ? "" : " [\(notes.joined(separator: " · "))]"
        return "\(i.name)\(qty)\(note)"
    }

    private static func line(_ i: Item) -> String { "- \(itemText(i))" }

    /// Unchecked items → grouped plain text ("" when nothing is left to get).
    ///
    /// Known aisles lead in walking order, then any unrecognized groups, then the
    /// OTHER catch-all last (it's a fallback, so it should never push a real section
    /// down the page).
    ///
    /// A list with NO grouping at all comes out flat with no headers: a lone "OTHER"
    /// over every line is noise, and custom lists frequently have no sections.
    static func format(_ items: [Item]) -> String {
        render(items, line: line, header: { $0.uppercased() })
    }

    /// The same list as a Markdown checklist ("" when nothing is left to get) — for
    /// pasting into a notes app that renders `- [ ]` as a real, tickable box.
    ///
    /// Only UNCHECKED items are emitted, exactly as in the plain-text share: the
    /// export is the shopping list, and an item already in the cart is not part of
    /// it. Every box ships unticked and `- [x]` never appears.
    ///
    /// Headers keep their natural casing rather than the plain-text SHOUT — `##`
    /// already renders as a heading, so uppercasing only adds noise.
    static func formatMarkdown(_ items: [Item]) -> String {
        render(items, line: { "- [ ] \(itemText($0))" }, header: { "## \($0)" })
    }

    /// Shared skeleton for both output formats: same items, same grouping, same
    /// order — only the per-line and per-header syntax differ. One code path is what
    /// keeps the plain-text and Markdown shares from drifting apart.
    private static func render(_ items: [Item],
                               line renderLine: (Item) -> String,
                               header renderHeader: (String) -> String) -> String {
        var byGroup: [String: [Item]] = [:]
        var order: [String] = []          // first-seen order, for unknown groups
        var anyGrouped = false
        for i in items where !i.checked {
            if !i.group.isEmpty { anyGrouped = true }
            let group = i.group.isEmpty ? other : i.group
            if byGroup[group] == nil { order.append(group) }
            byGroup[group, default: []].append(i)
        }

        let known = aisleOrder.filter { $0 != other && byGroup[$0] != nil }
        let unknown = order.filter { $0 != other && !aisleOrder.contains($0) }
        let ordered = known + unknown + (byGroup[other] != nil ? [other] : [])

        let all = ordered.flatMap { byGroup[$0] ?? [] }
        guard !all.isEmpty else { return "" }
        // Nothing carried a section — headers would add nothing to read.
        if !anyGrouped { return all.map(renderLine).joined(separator: "\n") }

        return ordered
            .map { "\(renderHeader($0))\n\((byGroup[$0] ?? []).map(renderLine).joined(separator: "\n"))" }
            .joined(separator: "\n\n")
    }

    /// Convenience: format straight from list rows.
    static func format(rows: [WaffledAPI.ListItemDTO]) -> String {
        format(rows.map(item(from:)))
    }

    /// Convenience: Markdown straight from list rows.
    static func formatMarkdown(rows: [WaffledAPI.ListItemDTO]) -> String {
        formatMarkdown(rows.map(item(from:)))
    }
}

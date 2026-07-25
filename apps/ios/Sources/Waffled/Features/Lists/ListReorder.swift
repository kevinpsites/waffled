import Foundation

/// Pure logic behind the list's drag-to-move-between-sections. The list renders as one
/// flat run of rows — a header for each section, then that section's items — so SwiftUI's
/// native `.onMove` (which coexists with `.swipeActions`, unlike the `.dropDestination`
/// that a `List` silently refuses) can drag an item *across* a header. After the move we
/// read the item's new section from the header it landed under; the view then PATCHes just
/// that section. Kept separate so the rule is unit-tested without a running app.
enum ListReorder {
    /// A flattened display row: a section header (its title, nil for the untitled group),
    /// or an item tagged with the section it currently sits in.
    enum Row: Equatable {
        case header(String?)
        case item(id: String, section: String?)
    }

    /// The section an item should adopt after a SwiftUI `.onMove(from:to:)` on the flat
    /// rows: the header nearest at/above where it landed. Returns nil for a no-op — the
    /// item didn't change section, landed above the first header, or the move can't be
    /// resolved — so the caller skips the write. Section titles are compared exactly
    /// (an empty string normalizes to nil, matching `setSection`).
    static func targetSection(rows: [Row], from: IndexSet, to: Int) -> (id: String, section: String?)? {
        guard let src = from.min(), src < rows.count,
              case let .item(id, oldSection) = rows[src] else { return nil }

        // Replay SwiftUI's move semantics on a copy (no dependency on the SwiftUI
        // `move(fromOffsets:toOffset:)` helper, so this stays pure/testable).
        var arr = rows
        let moving = from.sorted().map { rows[$0] }
        for i in from.sorted(by: >) { arr.remove(at: i) }
        let removedBefore = from.filter { $0 < to }.count
        let insertAt = max(0, min(to - removedBefore, arr.count))
        arr.insert(contentsOf: moving, at: insertAt)

        guard let newIdx = arr.firstIndex(where: {
            if case .item(let i, _) = $0 { return i == id } else { return false }
        }) else { return nil }

        // Walk up to the nearest header — that section owns the landing spot.
        var section: String?
        var foundHeader = false
        var k = newIdx - 1
        while k >= 0 {
            if case .header(let title) = arr[k] { section = title; foundHeader = true; break }
            k -= 1
        }
        guard foundHeader else { return nil }   // dropped above the first header → ignore

        let normalizedOld = (oldSection?.isEmpty == true) ? nil : oldSection
        let normalizedNew = (section?.isEmpty == true) ? nil : section
        guard normalizedNew != normalizedOld else { return nil }
        return (id, normalizedNew)
    }
}

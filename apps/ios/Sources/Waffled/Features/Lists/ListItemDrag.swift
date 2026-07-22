import SwiftUI
import UniformTypeIdentifiers

/// A custom (non-text) drag payload for moving a list item into another section by
/// finger-drag. A plain `String` payload would let the add bar / inline-edit text
/// fields intercept the drop and paste the item id as text (the same bug the meal-slot
/// and ingredient-row drags hit) — a custom UTType, declared in project.yml and
/// conforming to `public.data` (NOT `public.text`), means only the list's row drop
/// targets accept it.
extension UTType {
    static let waffledListItem = UTType(exportedAs: "app.waffled.list-item")
}

struct ListItemDrag: Transferable, Codable {
    let id: String
    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .waffledListItem)
    }
}

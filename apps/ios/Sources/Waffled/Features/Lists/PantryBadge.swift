import SwiftUI

/// The grocery board's "you already have this" badge — the pantry speaking on a surface
/// that isn't the pantry. Mirrors the web's `PantryBadge` in `GroceryBoard.tsx`.
///
/// The rule lives here rather than in the view body because it's the part that can be
/// quietly wrong: matching is fuzzy ("Peas" ↔ "Frozen peas"), so *what* the badge says
/// is not interchangeable. See `label(rowName:hit:)`.
///
/// What the badge deliberately does NOT do: hide the row, check it off, or claim you
/// have enough. The server's match is presence-only and never compares quantities, so
/// "you have eggs" can be true while you have one egg and the recipe wants twelve.
/// Filtering on that would be a worse bug than the confusion this fixes — so the row
/// stays on the list, stays checkable, and this is a "check the shelf" nudge.
enum PantryBadge {
    /// What the badge reads.
    ///
    /// - Fuzzy match (the pantry item's name differs from the row's): the NAME leads.
    ///   A row reading "Chicken" matched by "Boneless chicken breast" is a difference
    ///   that can change your mind, and "3 pack" wouldn't tell you that.
    /// - Exact match: the row already says the name, so only the amount adds anything —
    ///   and on a narrow phone row, width spent on a repeat of the name is width lost.
    /// - Nothing to say at all: the bare claim, "in pantry".
    static func label(rowName: String, hit: WaffledAPI.ListItemDTO.PantryHit) -> String {
        let amount = [hit.amount, hit.unit]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        let differs = hit.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            != rowName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // A fuzzy match with no amount still names what it found — falling back to the
        // generic "in pantry" there would throw away the only informative half.
        let detail = differs ? [hit.name, amount].filter { !$0.isEmpty }.joined(separator: " · ") : amount
        return detail.isEmpty ? "in pantry" : detail
    }

    /// The spoken form, for VoiceOver — the badge's own text is a fragment.
    static func accessibilityLabel(rowName: String, hit: WaffledAPI.ListItemDTO.PantryHit) -> String {
        "In your pantry: \(label(rowName: rowName, hit: hit)). Still on the list — we can’t tell whether it’s enough."
    }
}

/// The rendered chip. `success`/`successT` is the tint pair the Pantry screen uses for
/// its own "you've got this" chips, so the same claim looks the same everywhere it's
/// made — and deliberately NOT a warning color, since the row is still on the list on
/// purpose. Both are dark-aware `WF` tokens; a literal here would go wrong in one theme.
struct PantryBadgeChip: View {
    let rowName: String
    let hit: WaffledAPI.ListItemDTO.PantryHit
    /// A checked-off row has already been dealt with — let its badge recede with it.
    var dimmed = false

    var body: some View {
        Text("🥫 \(PantryBadge.label(rowName: rowName, hit: hit))")
            .font(.system(size: 11.5, weight: .bold))
            .foregroundStyle(WF.success)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(WF.successT)
            .clipShape(Capsule())
            .opacity(dimmed ? 0.5 : 1)
            .accessibilityLabel(PantryBadge.accessibilityLabel(rowName: rowName, hit: hit))
    }
}

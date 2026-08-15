import Foundation

/// Per-person calendar columns — the bucketing behind the People view.
///
/// An event lands in its OWNER's column and in every participant's column, so a
/// shared event reads from each person's lane instead of hiding under one name.
/// "Owner" is `personId` (the assignee that drives the event's colour) — NOT
/// `ownerPersonId`, which exists for personal-calendar visibility and says nothing
/// about whose day this belongs to.
///
/// Bucketing is COLUMN-driven (ask each person "is this yours?") rather than
/// event-driven (collect columns from an event's participants): participant rows
/// may name someone outside the household, and this ignores those for free instead
/// of inventing a phantom column.
///
/// Mirrors the web's `peopleColumns` (apps/web/src/kiosk/components/cal-people.ts).
enum PeopleColumns {
    /// A household person a column is drawn for.
    struct Member: Identifiable, Equatable {
        let id: String
        let name: String
        let colorHex: String?
        let avatarEmoji: String?
    }

    struct Column: Identifiable, Equatable {
        let id: String
        let name: String
        let colorHex: String?
        let avatarEmoji: String?
        var events: [SyncedEvent]
    }

    /// The leading catch-all column, present only when something needs it.
    /// Underscore-prefixed so it can never collide with a person's uuid.
    static let unassignedId = "_everyone"

    private static func belongs(_ e: SyncedEvent, to personId: String) -> Bool {
        e.personId == personId || e.participantIds.contains(personId)
    }

    static func build(_ events: [SyncedEvent], people: [Member]) -> [Column] {
        var columns = people.map { m in
            Column(id: m.id, name: m.name, colorHex: m.colorHex, avatarEmoji: m.avatarEmoji,
                   events: events.filter { belongs($0, to: m.id) })
        }

        // Anything no column claimed — nobody on it, or its only people have left
        // the household. It must not silently disappear from the view.
        let claimed = Set(columns.flatMap { $0.events.map(\.id) })
        let orphans = events.filter { !claimed.contains($0.id) }
        guard !orphans.isEmpty else { return columns }

        columns.insert(
            Column(id: unassignedId, name: "Everyone", colorHex: nil, avatarEmoji: nil, events: orphans),
            at: 0)
        return columns
    }

    // No lane packing lives here. The People view renders through `CalTimeGrid`,
    // which packs each column's events itself in `placedEvents(_:)` — one
    // implementation, on the path that actually ships. A second copy in this file
    // would only ever be exercised by tests, so it could stay green while the real
    // one regressed.
}

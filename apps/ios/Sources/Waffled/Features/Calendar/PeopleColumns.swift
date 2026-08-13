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

    struct Placement: Equatable { let lane: Int; let lanes: Int }

    /// Lay ONE column's timed events into side-by-side lanes (interval partitioning:
    /// cluster transitively-overlapping events, then give each the first free lane).
    ///
    /// This must be run per column, never once across all of them: an event that
    /// appears in three people's columns would otherwise take its widest cluster's
    /// lane count everywhere and render as a sliver in the columns where it is the
    /// only thing on screen.
    static func lanes(for events: [SyncedEvent]) -> [String: Placement] {
        func startOf(_ e: SyncedEvent) -> Date { e.startsAt ?? .distantPast }
        func endOf(_ e: SyncedEvent) -> Date {
            let s = startOf(e)
            return s.addingTimeInterval(e.endsAt.map { max(1800, $0.timeIntervalSince(s)) } ?? 3600)
        }
        let sorted = events.filter { !$0.allDay && $0.startsAt != nil }.sorted { startOf($0) < startOf($1) }
        var out: [String: Placement] = [:]
        var i = 0
        while i < sorted.count {
            var clusterEnd = endOf(sorted[i])
            var j = i + 1
            while j < sorted.count, startOf(sorted[j]) < clusterEnd {
                clusterEnd = max(clusterEnd, endOf(sorted[j]))
                j += 1
            }
            let cluster = Array(sorted[i..<j])
            var laneEnds: [Date] = []
            var laneOf: [String: Int] = [:]
            for e in cluster {
                if let free = laneEnds.firstIndex(where: { $0 <= startOf(e) }) {
                    laneEnds[free] = endOf(e)
                    laneOf[e.id] = free
                } else {
                    laneOf[e.id] = laneEnds.count
                    laneEnds.append(endOf(e))
                }
            }
            let count = max(1, laneEnds.count)
            for e in cluster { out[e.id] = Placement(lane: laneOf[e.id] ?? 0, lanes: count) }
            i = j
        }
        return out
    }
}

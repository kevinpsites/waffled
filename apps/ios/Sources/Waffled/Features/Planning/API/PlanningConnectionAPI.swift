import Foundation

// Weekly Planning · step 5 (Connection) — TWO READS AND ONE POINTER.
//
// NOTHING NEW IS STORED FOR THIS STEP. A pairing is a QUERY over event_participants for an
// event whose people are exactly those two; claiming a slot writes an ORDINARY CALENDAR
// EVENT through the app's own `EventEditSheet`. There is deliberately no "create pairing"
// call — a second door onto the events table is how the two would drift. The one write is
// `/links`, a POINTER to an event that already exists, and it is a MID-STEP write: it
// merges onto the step's row and does NOT settle the step.

extension WaffledAPI {

    struct PlanningConnectionSlot: Decodable, Sendable, Equatable, Identifiable {
        let date: String
        /// ⚠️ NIL IS NOT "UNKNOWN" — it means the WHOLE DAY IS FREE, and the event sheet's
        /// own time picker decides the hour. A client treating this as missing data would
        /// drop the roomiest offer on the row.
        let startsAt: String?
        /// `after` | `open`. Left as a `String`: the catalog of kinds is the server's.
        let kind: String
        let afterTitle: String?
        /// "Wed after Scouts" / "Sun · free all day". Built server-side.
        let label: String

        var id: String { date }

        var isFreeAllDay: Bool { startsAt == nil }
    }

    struct PlanningConnectionEvent: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let title: String
        let startsAt: String
        let endsAt: String?
        let allDay: Bool
        let minutes: Int?
        let day: String
        let time: String?
        /// "Saturday 1:00 PM" — formatted in the household's zone, SERVER-SIDE.
        let when: String
    }

    struct PlanningConnectionPairing: Decodable, Sendable, Equatable, Identifiable {
        let personIds: [String]
        let who: String
        /// The last event BEFORE the planned week whose people were exactly these two.
        let lastTogetherOn: String?
        let lastTogetherTitle: String?
        /// Events this week whose people are EXACTLY these two — time that already exists.
        let alreadyThisWeek: [PlanningConnectionEvent]
        /// Events this week with both of them AND someone else.
        let togetherThisWeek: [PlanningConnectionEvent]
        /// Ranked gaps, roomiest first — ALL of them. How many chips fit is the step's call.
        let slots: [PlanningConnectionSlot]

        /// THE PAIRING'S KEY, and the exact spelling `PUT /links` is keyed by. Both platforms
        /// write the same map, so this must not be re-spelled.
        var key: String { personIds.joined(separator: "-") }
        var id: String { key }
    }

    struct PlanningConnectionBoard: Decodable, Sendable, Equatable {
        /// The week the server resolved (snapped and floored) — echoed, never computed here.
        let weekStart: String
        /// EVERY pair in the household, ranked. The cut is the client's (see
        /// `PlanningConnectionCopy.visible`).
        let pairings: [PlanningConnectionPairing]
    }

    struct PlanningConnectionSlots: Decodable, Sendable, Equatable {
        let weekStart: String
        /// Household order, not the order they were tapped — the server re-sorts.
        let personIds: [String]
        let who: String
        let slots: [PlanningConnectionSlot]
    }

    /// `weekStart` is the one the shell handed us — never computed on the device.
    func planningConnectionBoard(weekStart: String?) async throws -> PlanningConnectionBoard {
        var path = "/api/weekly-planning/connection"
        if let weekStart, !weekStart.isEmpty { path += "?weekStart=\(PlanningQuery.esc(weekStart))" }
        return try await getJSON(path, as: PlanningConnectionBoard.self)
    }

    /// The same gaps for people the app didn't suggest. 400s on fewer than two people, or
    /// on an id from another household.
    func planningConnectionSlots(
        weekStart: String, personIds: [String]
    ) async throws -> PlanningConnectionSlots {
        let people = personIds.joined(separator: ",")
        let path = "/api/weekly-planning/connection/slots"
            + "?weekStart=\(PlanningQuery.esc(weekStart))&people=\(PlanningQuery.esc(people))"
        return try await getJSON(path, as: PlanningConnectionSlots.self)
    }

    /// WHICH EVENT ANSWERS EACH PAIRING, keyed by the pairing's people.
    ///
    /// A MID-STEP write: the server merges this map onto the step's row and leaves
    /// `status` / `decided_at` alone. `setDecisionData` alone would not do — it only
    /// reaches the server when the step IS answered, and somebody who links a time then
    /// walks off has answered nothing.
    @discardableResult
    func savePlanningConnectionLinks(
        sessionId: String, links: [String: String]
    ) async throws -> Bool {
        struct Resp: Decodable { let ok: Bool }
        let body: [String: JSONValue] = [
            "sessionId": .string(sessionId),
            "links": .object(links.mapValues(JSONValue.string)),
        ]
        return try await sendReturning(
            "PUT", "/api/weekly-planning/connection/links", body: body, as: Resp.self).ok
    }
}

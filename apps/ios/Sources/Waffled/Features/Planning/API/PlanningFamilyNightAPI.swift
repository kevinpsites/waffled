import Foundation

// Weekly Planning · step 4 (Family night) — this step's wire types, its ONE read, and the
// bodies it posts to the familyNight module's POST /api/family-night/occurrence.
//
// ⚠ PRESENCE IS THE MESSAGE — the server reads whether a KEY WAS SENT, not its value
// (see `upsertOccurrence` in apps/api/src/modules/familyNight/familyNight.ts):
//   · a detail-only write must carry NO `personId` key. `personId: null` is a real
//     "nobody yet", so including it un-assigns whoever had the part.
//   · `theme: ""` CLEARS the theme; absent means "leave whatever is there". Same for detail.
//   · there is deliberately no un-pin.

extension WaffledAPI {

    // camelCase 1:1 with the server, and every date/time is a `String` — `weekStart` and
    // `date` are household-local labels that must never round-trip through a device `Date`.

    struct PlanningFamilyNightMember: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let name: String
        let avatarEmoji: String?
        let colorHex: String?
    }

    struct PlanningFamilyNightPart: Decodable, Identifiable, Hashable, Sendable {
        let partId: String
        let label: String
        let emoji: String
        /// False ⇒ the rotation never auto-fills this part. It still takes a pin.
        let rotates: Bool
        let detail: String?
        let personId: String?
        let personName: String?
        /// True ⇒ chosen for this week and written on the occurrence; false ⇒ the rotation's
        /// suggestion. Telling those apart is the screen's job.
        let pinned: Bool

        var id: String { partId }
    }

    struct PlanningFamilyNightBoard: Decodable, Sendable {
        let weekStart: String
        let date: String
        let dayOfWeek: Int
        let time: String
        /// Null until somebody touches the week: the board is a pure read.
        let occurrenceId: String?
        let theme: String?
        /// "planned" | "done" | "skipped".
        let status: String
        /// A STANDING recurring event behind this. Only then may the step promise that
        /// calling one week off leaves it alone.
        let onCalendar: Bool
        /// THIS week's own event, separate from `onCalendar`'s standing series.
        let eventId: String?
        let eventTitle: String?
        let eventWhen: String?
        let members: [PlanningFamilyNightMember]
        let parts: [PlanningFamilyNightPart]

        var isSkipped: Bool { status == "skipped" }
    }

    struct PlanningWeekEvent: Decodable, Identifiable, Sendable {
        let id: String
        let title: String
        /// "meal_plan" / "meal_prep" mirrors are filtered out: offering one would put a meal
        /// where an evening goes.
        let origin: String?
    }


    /// `weekStart` is the one the shell handed us — passed back, never computed here.
    func planningFamilyNightBoard(weekStart: String) async throws -> PlanningFamilyNightBoard {
        try await getJSON("/api/weekly-planning/familyNight?weekStart=\(weekStart)",
                          as: PlanningFamilyNightBoard.self)
    }

    /// `from`/`to` are whole days stepped off the boundary the SERVER gave us.
    func planningWeekEvents(from: String, to: String) async throws -> [PlanningWeekEvent] {
        struct Resp: Decodable { let events: [PlanningWeekEvent] }
        return try await getJSON("/api/events?from=\(from)&to=\(to)", as: Resp.self).events
    }


    /// Takes the body WHOLE rather than named parameters: only the caller knows which keys
    /// it means to send, and a signature with optionals would collapse absent and null.
    @discardableResult
    func saveFamilyNightOccurrence(body: [String: JSONValue]) async throws -> String {
        struct Resp: Decodable { let id: String }
        return try await sendReturning("POST", "/api/family-night/occurrence",
                                       body: body, as: Resp.self).id
    }
}

/// The six bodies this step posts — pure, so the presence rules above are covered by tests.
enum PlanningFamilyNightBody {

    /// Pinned for THIS WEEK only, which also materializes the occurrence — and the
    /// occurrence count is what the rotation counts, so pinning shifts next week's turn.
    /// `personId: nil` writes a real "nobody yet"; there is no un-pin.
    static func pin(date: String, partId: String, personId: String?) -> [String: JSONValue] {
        [
            "date": .string(date),
            "assignments": .array([
                .object([
                    "partId": .string(partId),
                    // ALWAYS present — that presence is the message; `.null` is "nobody yet".
                    "personId": personId.map(JSONValue.string) ?? .null,
                ]),
            ]),
        ]
    }

    /// ⚠ NO `personId` KEY. The server reads presence, so adding one — even `null`, even
    /// "for symmetry" — turns "I named the treat" into "…and nobody has it".
    /// `PlanningFamilyNightStepTests.detailWriteCarriesNoPersonKey` asserts the key set.
    static func setDetail(date: String, partId: String, detail: String) -> [String: JSONValue] {
        [
            "date": .string(date),
            "assignments": .array([
                .object([
                    "partId": .string(partId),
                    // '' clears; the key being ABSENT would mean "leave it alone".
                    "detail": .string(detail),
                ]),
            ]),
        ]
    }

    /// The night's theme. '' clears it; omitting the key means "leave whatever is there".
    static func setTheme(date: String, theme: String) -> [String: JSONValue] {
        ["date": .string(date), "theme": .string(theme)]
    }

    /// One body both ways — a skip has to be undoable.
    static func setStatus(date: String, status: String) -> [String: JSONValue] {
        ["date": .string(date), "status": .string(status)]
    }

    /// `nil` unlinks and leaves the event on the calendar: "this isn't family night after
    /// all" must never delete Friday.
    static func linkEvent(date: String, eventId: String?) -> [String: JSONValue] {
        ["date": .string(date), "eventId": eventId.map(JSONValue.string) ?? .null]
    }

    /// ONE call that creates the event and links it SERVER-SIDE, not a create-then-adopt
    /// round trip — a client-made event may not exist server-side yet (PowerSync uploads
    /// afterwards), so the link would 404 on a race. An existing link is returned untouched.
    static func addEvent(date: String) -> [String: JSONValue] {
        ["date": .string(date), "createEvent": .bool(true)]
    }
}

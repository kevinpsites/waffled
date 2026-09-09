import Foundation

// Weekly Planning · step 10 "Recap" — ONE read, no write. Ported from the web's recap.ts.
//
// EVERY LINE IS A POINTER, NEVER A COPY: every headline, sentence and tally arrives already
// RESOLVED and the client decides only layout. The exception is an event's colour, which
// arrives as INPUTS and tints through the app's own `EventPalette`.
extension WaffledAPI {

    struct PlanningRecapEvent: Decodable, Identifiable, Sendable, Equatable {
        let id: String
        let title: String
        /// Composed server-side in the household's timezone: text to show, not a date to parse.
        let when: String
        let personId: String?
        let personName: String?
        /// A real `persons.color_hex` — `Color(hexString:)`, never a `WF` token.
        let personColor: String?
        let participantIds: [String]

        /// `participantIds ?? []` IS THE POINT OF THIS INITIALIZER: a missing non-optional
        /// array THROWS and takes the whole recap decode with it. It must cost a tint.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            when = try c.decodeIfPresent(String.self, forKey: .when) ?? ""
            personId = try c.decodeIfPresent(String.self, forKey: .personId)
            personName = try c.decodeIfPresent(String.self, forKey: .personName)
            personColor = try c.decodeIfPresent(String.self, forKey: .personColor)
            participantIds = try c.decodeIfPresent([String].self, forKey: .participantIds) ?? []
        }

        private enum CodingKeys: String, CodingKey {
            case id, title, when, personId, personName, personColor, participantIds
        }
    }

    /// One day of the week, read back: its dinner, its events, and how many it holds back.
    struct PlanningRecapDay: Decodable, Identifiable, Sendable, Equatable {
        let date: String
        /// Null with the meals module off too — a week of events, not a row of blanks.
        let meal: String?
        let cook: String?
        let events: [PlanningRecapEvent]
        let more: Int

        var id: String { date }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            date = try c.decode(String.self, forKey: .date)
            meal = try c.decodeIfPresent(String.self, forKey: .meal)
            cook = try c.decodeIfPresent(String.self, forKey: .cook)
            events = try c.decodeIfPresent([PlanningRecapEvent].self, forKey: .events) ?? []
            more = try c.decodeIfPresent(Int.self, forKey: .more) ?? 0
        }

        private enum CodingKeys: String, CodingKey { case date, meal, cook, events, more }
    }

    /// Grouped by THE MODULE THE DECISION LIVES IN: the group names where you'd change it,
    /// which is what makes the row a pointer.
    struct PlanningRecapGroup: Decodable, Identifiable, Sendable, Equatable {
        let key: String
        let label: String
        let headline: String
        let detail: String
        let count: Int
        let stepKey: String?

        var id: String { key }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            key = try c.decode(String.self, forKey: .key)
            label = try c.decodeIfPresent(String.self, forKey: .label) ?? key
            headline = try c.decodeIfPresent(String.self, forKey: .headline) ?? ""
            detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
            count = try c.decodeIfPresent(Int.self, forKey: .count) ?? 0
            stepKey = try c.decodeIfPresent(String.self, forKey: .stepKey)
        }

        private enum CodingKeys: String, CodingKey {
            case key, label, headline, detail, count, stepKey
        }
    }

    struct PlanningRecapLastCall: Decodable, Identifiable, Sendable, Equatable {
        let id: String
        let note: String
        /// Composed by the same `listParked` step 1 uses, so a note reads identically.
        let detail: String?
    }

    /// What was left alone ON PURPOSE: a skipped step is a decision, and "nothing" an answer.
    struct PlanningRecapLeftAlone: Decodable, Identifiable, Sendable, Equatable {
        let key: String
        let label: String
        let detail: String
        /// "skipped" | "none" | "parked". A STRING, not an enum: the catalog is server-owned,
        /// and a newer server's fourth badge must render as itself rather than fail the decode.
        let badge: String
        let stepKey: String?

        var id: String { key }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            key = try c.decode(String.self, forKey: .key)
            label = try c.decodeIfPresent(String.self, forKey: .label) ?? key
            detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
            badge = try c.decodeIfPresent(String.self, forKey: .badge) ?? ""
            stepKey = try c.decodeIfPresent(String.self, forKey: .stepKey)
        }

        private enum CodingKeys: String, CodingKey { case key, label, detail, badge, stepKey }
    }

    /// DERIVED SERVER-SIDE on every read, so the header and the cards cannot disagree.
    struct PlanningRecapCounts: Decodable, Sendable, Equatable {
        let decisions: Int
        let deferred: Int
        let parked: Int

        init(decisions: Int = 0, deferred: Int = 0, parked: Int = 0) {
            self.decisions = decisions
            self.deferred = deferred
            self.parked = parked
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            decisions = try c.decodeIfPresent(Int.self, forKey: .decisions) ?? 0
            deferred = try c.decodeIfPresent(Int.self, forKey: .deferred) ?? 0
            parked = try c.decodeIfPresent(Int.self, forKey: .parked) ?? 0
        }

        private enum CodingKeys: String, CodingKey { case decisions, deferred, parked }
    }

    struct PlanningRecapView: Decodable, Sendable, Equatable {
        let weekStart: String
        let savedAt: String?
        let days: [PlanningRecapDay]
        let groups: [PlanningRecapGroup]
        let lastCall: [PlanningRecapLastCall]
        let lastCallMore: Int
        let leftAlone: [PlanningRecapLeftAlone]
        let counts: PlanningRecapCounts

        /// EVERY collection defaults: on the session's last screen, a missing array must cost
        /// that card and never the whole recap.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            weekStart = try c.decodeIfPresent(String.self, forKey: .weekStart) ?? ""
            savedAt = try c.decodeIfPresent(String.self, forKey: .savedAt)
            days = try c.decodeIfPresent([PlanningRecapDay].self, forKey: .days) ?? []
            groups = try c.decodeIfPresent([PlanningRecapGroup].self, forKey: .groups) ?? []
            lastCall = try c.decodeIfPresent([PlanningRecapLastCall].self, forKey: .lastCall) ?? []
            lastCallMore = try c.decodeIfPresent(Int.self, forKey: .lastCallMore) ?? 0
            leftAlone = try c.decodeIfPresent([PlanningRecapLeftAlone].self, forKey: .leftAlone) ?? []
            counts = try c.decodeIfPresent(PlanningRecapCounts.self, forKey: .counts)
                ?? PlanningRecapCounts()
        }

        private enum CodingKeys: String, CodingKey {
            case weekStart, savedAt, days, groups, lastCall, lastCallMore, leftAlone, counts
        }
    }

    /// The week read back. WHICH WEEK IS THE SESSION'S: with a `sessionId` its own
    /// `week_start` wins server-side, since a session may plan further out. `weekStart` is
    /// still passed when there is none, so even that read goes through the shell's week gate.
    func planningRecap(sessionId: String?, weekStart: String?) async throws -> PlanningRecapView {
        var q: [String] = []
        if let sessionId, !sessionId.isEmpty { q.append("sessionId=\(PlanningQuery.esc(sessionId))") }
        if let weekStart, !weekStart.isEmpty { q.append("weekStart=\(PlanningQuery.esc(weekStart))") }
        let path = "/api/weekly-planning/recap" + (q.isEmpty ? "" : "?" + q.joined(separator: "&"))
        return try await getJSON(path, as: PlanningRecapView.self)
    }
}

/// The crumb the step hands the session record when the week is saved.
///
/// INTEGERS ONLY — the pointer rule applied to storage: the receipt may freeze how MANY
/// decisions were made, never WHAT they were, since a title copied here goes stale. Keys
/// match `planningRecapDecision` in the web's recap.ts.
enum PlanningRecapCrumb {
    static func decision(_ view: WaffledAPI.PlanningRecapView?) -> [String: JSONValue]? {
        guard let view else { return nil }
        return [
            "counts": .object([
                "decisions": .int(view.counts.decisions),
                "deferred": .int(view.counts.deferred),
                "parked": .int(view.counts.parked),
            ]),
        ]
    }
}

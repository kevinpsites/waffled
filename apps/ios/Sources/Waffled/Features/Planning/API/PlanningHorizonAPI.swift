import Foundation

// Weekly Planning · step 3 "Horizon scan" — ONE read, deliberately not three. Ported from
// the web's horizon.ts.
//
// Almost nothing here is new: THE MONTH is the calendar the family already has (on iOS the
// PowerSync mirror), ADDING AN EVENT is `EventEditSheet`, and PARKING A NOTE is step 1's
// `parkPlanningNote`. What is left is the one read the park bar cannot derive: which tags it
// may offer, and what THIS SESSION has parked — `setDecisionData` is not storage.

extension WaffledAPI {

    /// One tag the park bar may offer. The tag names the step that will LOOK at the note.
    struct HorizonTag: Decodable, Sendable, Equatable {
        let stepKey: String
        let label: String
        let hint: String
        /// OPTIONAL — the one the bar opens on, and ABSENT ENTIRELY when its step is
        /// unavailable, so the bar then opens on "No tag".
        let primary: Bool?
    }

    struct HorizonNote: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let note: String
        let stepKey: String?
        let stepLabel: String?
        let createdAt: String

        init(id: String, note: String, stepKey: String?, stepLabel: String?, createdAt: String) {
            self.id = id
            self.note = note
            self.stepKey = stepKey
            self.stepLabel = stepLabel
            self.createdAt = createdAt
        }
    }

    struct HorizonView: Decodable, Sendable, Equatable {
        /// "No tag" is the ABSENCE of a tag, so it is never in this list.
        let tags: [HorizonTag]
        /// Every OPEN note parked during this session, from either bar.
        let parked: [HorizonNote]

        init(tags: [HorizonTag], parked: [HorizonNote]) {
            self.tags = tags
            self.parked = parked
        }

        /// Both lists default to empty: a payload missing one should cost that list only.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            tags = try c.decodeIfPresent([HorizonTag].self, forKey: .tags) ?? []
            parked = try c.decodeIfPresent([HorizonNote].self, forKey: .parked) ?? []
        }

        private enum CodingKeys: String, CodingKey { case tags, parked }
    }

    /// The bar's tags and this session's board. `sessionId` is optional server-side.
    func planningHorizon(sessionId: String?) async throws -> HorizonView {
        var path = "/api/weekly-planning/horizon"
        if let sessionId, !sessionId.isEmpty { path += "?sessionId=\(PlanningQuery.esc(sessionId))" }
        return try await getJSON(path, as: HorizonView.self)
    }
}

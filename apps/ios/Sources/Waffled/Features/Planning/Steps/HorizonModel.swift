import Foundation
import Observation

// Weekly Planning · step 3 "Horizon scan" — the state behind the park bar. Ported from
// `apps/web/src/kiosk/planning/steps/HorizonStep.tsx`. The month has no state here: it is
// the calendar the family already has, read through the PowerSync mirror. What this object
// owns is the ONE THING THE SESSION ADDS — a parked note and its tag.

/// Which step a note is for. THREE states, not two: `unset` is "nobody has chosen", which
/// resolves to the server's primary tag; `noTag` is the deliberate answer "No tag". A
/// `String?` would make the default unrepresentable — and it is a real thing, since a
/// household with no Tasks step gets no primary and the bar must open on "No tag".
enum PlanningTagChoice: Equatable, Sendable {
    case unset
    case noTag
    case step(String)
}

@MainActor
@Observable
final class PlanningHorizonModel {
    typealias FetchHorizon = (_ sessionId: String) async throws -> WaffledAPI.HorizonView
    /// Step 1's writer, on purpose: `planning_parked_items` and `parkItem()` were both
    /// written general, so this bar needs no second parked-item path.
    typealias ParkNote = (
        _ note: String, _ stepKey: String?, _ sessionId: String
    ) async throws -> WaffledAPI.PlanningParkedItem
    /// Correcting a note already on the board. `stepKey` is DOUBLY optional: absent leaves
    /// the tag alone, `.some(nil)` is the real answer "No tag".
    typealias UpdateNote = (
        _ id: String, _ note: String?, _ stepKey: String??, _ sessionId: String
    ) async throws -> WaffledAPI.PlanningParkedItem

    /// Only the steps still AHEAD of this one — the server filters; we render what it
    /// sends. A tag naming a step the session has walked past addresses the note to nobody
    /// until a LATER session.
    private(set) var tags: [WaffledAPI.HorizonTag] = []
    /// Every open note parked during this session, whichever bar wrote it.
    private(set) var parked: [WaffledAPI.HorizonNote] = []
    /// A failed fetch keeps what we had and still counts as loaded — the shared REST
    /// contract.
    private(set) var loaded = false
    private(set) var parking = false
    private(set) var errorMessage: String?
    /// Real calendar events added from this step. Only ever a COUNT: the recap reads
    /// through to the calendar, so copying a title onto the session record would give the
    /// two a disagreement.
    private(set) var added = 0
    private(set) var revision = 0

    /// Settable — it is the bar's own control, and it has no server side.
    var tagChoice: PlanningTagChoice = .unset {
        didSet { revision &+= 1 }
    }

    /// The step key this note will carry, with `unset` resolved through the server's
    /// primary. `nil` means no tag at all, which is what "No tag" sends.
    var chosenStepKey: String? {
        switch tagChoice {
        case .unset: return tags.first { $0.primary == true }?.stepKey
        case .noTag: return nil
        case let .step(key): return key
        }
    }

    /// The catalog's title for the chosen step, for the line under the chips.
    var chosenLabel: String? {
        guard let key = chosenStepKey else { return nil }
        return tags.first { $0.stepKey == key }?.label
    }

    /// The crumb: two counts, and only counts. The board is read back from
    /// `planning_parked_items`, which is the table that owns it.
    var decisionData: [String: JSONValue] {
        ["added": .int(added), "parked": .int(parked.count)]
    }

    private let fetchHorizon: FetchHorizon
    private let parkNote: ParkNote
    private let updateNote: UpdateNote

    init(
        fetchHorizon: @escaping FetchHorizon = { sessionId in
            try await WaffledAPI().planningHorizon(sessionId: sessionId)
        },
        parkNote: @escaping ParkNote = { note, stepKey, sessionId in
            try await WaffledAPI().parkPlanningNote(note: note, stepKey: stepKey, sessionId: sessionId)
        },
        updateNote: @escaping UpdateNote = { id, note, stepKey, sessionId in
            try await WaffledAPI().updatePlanningParkedNote(
                id: id, note: note, stepKey: stepKey, sessionId: sessionId)
        }
    ) {
        self.fetchHorizon = fetchHorizon
        self.parkNote = parkNote
        self.updateNote = updateNote
    }

    func load(sessionId: String) async {
        if let next = try? await fetchHorizon(sessionId) {
            tags = next.tags
            parked = next.parked
        }
        loaded = true
        revision &+= 1
    }

    /// Park a note, tagged for the step that will look at it — or for nobody. Returns
    /// false when the write was refused, leaving the board as it was. The server caps a
    /// note at 500 characters, so a refusal is reachable, and its sentence is the useful
    /// half — keep it.
    @discardableResult
    func park(_ note: String, sessionId: String) async -> Bool {
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !parking else { return false }
        parking = true
        errorMessage = nil
        let stepKey = chosenStepKey
        let label = chosenLabel
        defer {
            parking = false
            revision &+= 1
        }
        do {
            let item = try await parkNote(text, stepKey, sessionId)
            // The row the server actually wrote — id, note and `createdAt` all come back,
            // so the board shows what was stored rather than a local guess.
            parked.append(
                WaffledAPI.HorizonNote(
                    id: item.id, note: item.note, stepKey: item.stepKey,
                    stepLabel: item.stepKey == nil ? nil : label, createdAt: item.createdAt))
            tagChoice = .unset
            return true
        } catch {
            errorMessage = APIErrorText.message(for: error, fallback: LooseEndCopy.writeFailed)
            return false
        }
    }

    /// FIX A NOTE ALREADY ON THE BOARD — its words, its tag, or both. Send only what
    /// moved: both arguments are "nil means leave it alone", and `stepKey: .some(nil)` is
    /// the answer "No tag".
    ///
    /// The row that comes back is the row the SERVER wrote, and `stepLabel` is re-joined
    /// from the catalog here, never stored — the same rule the server's own read follows.
    /// Returns false when the write was refused, leaving the board as it was.
    @discardableResult
    func update(
        id: String, note: String?, stepKey: String??, sessionId: String
    ) async -> Bool {
        guard !parking else { return false }
        parking = true
        errorMessage = nil
        defer {
            parking = false
            revision &+= 1
        }
        do {
            let item = try await updateNote(id, note, stepKey, sessionId)
            if let i = parked.firstIndex(where: { $0.id == item.id }) {
                parked[i] = WaffledAPI.HorizonNote(
                    id: item.id, note: item.note, stepKey: item.stepKey,
                    stepLabel: item.stepKey.flatMap { key in tags.first { $0.stepKey == key }?.label },
                    createdAt: item.createdAt)
            }
            return true
        } catch {
            errorMessage = APIErrorText.message(for: error, fallback: LooseEndCopy.writeFailed)
            return false
        }
    }

    /// A real calendar event was created from this step's month.
    func recordEventAdded() {
        added += 1
        revision &+= 1
    }

    func clearError() {
        errorMessage = nil
        revision &+= 1
    }
}

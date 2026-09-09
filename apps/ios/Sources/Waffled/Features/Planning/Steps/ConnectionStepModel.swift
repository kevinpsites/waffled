import Foundation
import Observation

// Weekly Planning · step 5 "Connection", ported from `ConnectionStep.tsx`. Every string a
// row shows is composed by the SERVER or by a pure function in `PlanningConnectionCopy`;
// nothing here parses a household-local timestamp.

enum PlanningConnectionCopy {

    /// Rows the board draws — a LAYOUT cap: the server ranks every pairing (see `visible`).
    static let rows = 3

    static let slotsPerRow = 2

    /// The candidate list for "Link a time", needing no new read: `alreadyThisWeek ∪ together`.
    static func bothOnIt(
        _ p: WaffledAPI.PlanningConnectionPairing
    ) -> [WaffledAPI.PlanningConnectionEvent] {
        p.alreadyThisWeek + p.togetherThisWeek
    }

    /// Which pairings the step draws, IN THE SERVER'S OWN ORDER. The ranking reads only
    /// history BEFORE the planned week, so a bare `prefix(3)` hides a pairing you just gave
    /// time to: those claim their places first, and the rest of the cap goes to the
    /// best-ranked with none. FILTERED, NOT PARTITIONED — re-grouping loses the ranking.
    static func visible(
        _ pairings: [WaffledAPI.PlanningConnectionPairing]
    ) -> [WaffledAPI.PlanningConnectionPairing] {
        var keep = Set(pairings.filter { !$0.alreadyThisWeek.isEmpty }.map(\.key))
        var guesses = max(0, rows - keep.count)
        for p in pairings {
            if guesses <= 0 { break }
            if keep.contains(p.key) { continue }
            keep.insert(p.key)
            guesses -= 1
        }
        return pairings.filter { keep.contains($0.key) }
    }

    static func durationWords(_ minutes: Int) -> String {
        if minutes % 60 == 0 {
            let h = minutes / 60
            return "\(h) \(h == 1 ? "hour" : "hours")"
        }
        return "\(minutes) minutes"
    }

    /// "Aug 8", from a `YYYY-MM-DD`. UTC + POSIX, never a device-zone round-trip:
    /// `lastTogetherOn` is a label already resolved in the household's zone.
    static func monthDay(_ iso: String) -> String {
        guard let d = isoDay.date(from: iso) else { return iso }
        return monthDayOut.string(from: d)
    }

    /// The one line under a pairing's name: it leads with the time that ALREADY EXISTS, then
    /// falls back to how long it has been plus the near miss.
    ///
    /// A LINKED event answers the pairing whatever else the week says, so it is looked up
    /// across BOTH lists — otherwise the sentence and the chip can name different events.
    static func sentence(
        _ p: WaffledAPI.PlanningConnectionPairing, linkedId: String?
    ) -> String {
        if let linkedId, let linked = bothOnIt(p).first(where: { $0.id == linkedId }) {
            return "Nothing new — \(linked.day)’s \(linked.title) already is it, and you said so out loud."
        }
        if let credit = p.alreadyThisWeek.first {
            let len = credit.minutes.map { " for \(durationWords($0))" } ?? ""
            return "\(credit.day)’s \(credit.title) is the two of you\(len) — that may already be it."
        }
        let since = p.lastTogetherOn.map { " since \(monthDay($0))" } ?? ""
        let lead = "Nothing on the calendar with just the two of you\(since)."
        let near = p.togetherThisWeek
        if near.count == 1 {
            return "\(lead) \(near[0].day)’s \(near[0].title) is you both, but it’s not that."
        }
        if near.count > 1 {
            return "\(lead) You’re both at \(near.count) things this week, but none of them is that."
        }
        return lead
    }

    /// How many credited evenings the WHOLE BOARD carries — what the ladder watches.
    /// Board-wide on purpose: a trio event credits no row, so nothing is linked, which is right.
    static func credited(_ board: WaffledAPI.PlanningConnectionBoard?) -> Int {
        (board?.pairings ?? []).reduce(0) { $0 + $1.alreadyThisWeek.count }
    }

    // Formatters are `static let` per the project's performance rule.
    private static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let monthDayOut: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "MMM d"
        return f
    }()
}

/// One pairing, fully resolved BEFORE the view renders — rebuilt per board or link change,
/// keeping date math and string building out of the render path.
struct PlanningConnectionRow: Identifiable, Equatable, Sendable {
    /// `personIds.joined(separator: "-")` — the key `PUT /links` is keyed by.
    let key: String
    let personIds: [String]
    let who: String
    let sentence: String
    let candidates: [WaffledAPI.PlanningConnectionEvent]
    /// The event somebody ACTUALLY PICKED, if any. Not "the first credited one".
    let answer: WaffledAPI.PlanningConnectionEvent?
    /// What one chip can honestly stand for: the answer, else the ONE obvious candidate.
    let oneTap: WaffledAPI.PlanningConnectionEvent?
    /// Whether the one-tap chip reads as CHOSEN. Exactly one chip on a row ever does.
    let oneTapChosen: Bool
    let showPicker: Bool
    let slots: [WaffledAPI.PlanningConnectionSlot]

    var id: String { key }

    init(_ p: WaffledAPI.PlanningConnectionPairing, linkedId: String?) {
        let candidates = PlanningConnectionCopy.bothOnIt(p)
        let answer = linkedId.flatMap { id in candidates.first { $0.id == id } }
        // The answer and the one-tap offer are different things; conflating them puts two
        // chosen-looking chips on one row.
        let tap = answer ?? (candidates.count == 1 ? candidates[0] : nil)
        key = p.key
        personIds = p.personIds
        who = p.who
        sentence = PlanningConnectionCopy.sentence(p, linkedId: linkedId)
        self.candidates = candidates
        self.answer = answer
        oneTap = tap
        oneTapChosen = answer != nil
        showPicker = candidates.count > (tap == nil ? 0 : 1)
        slots = Array(p.slots.prefix(PlanningConnectionCopy.slotsPerRow))
    }
}

@MainActor
@Observable
final class PlanningConnectionModel {
    typealias FetchBoard = (_ weekStart: String) async throws -> WaffledAPI.PlanningConnectionBoard
    typealias FetchSlots = (
        _ weekStart: String, _ personIds: [String]
    ) async throws -> WaffledAPI.PlanningConnectionSlots
    typealias SaveLinks = (_ sessionId: String, _ links: [String: String]) async throws -> Void
    /// The ladder's pause, injected so the tests don't sit through seven real seconds.
    typealias Wait = (_ duration: Duration) async -> Void

    /// How long to keep asking the server after a save. The write is local-first but this
    /// board is a SERVER read, so one immediate re-read asks too early and the row reads as a
    /// lost save. Ask again on a widening ladder, stopping when the credited count goes UP
    /// (~7s). Deliberately not a second source of truth: the server composes every string.
    static let catchup: [Duration] = [
        .milliseconds(250), .milliseconds(500), .seconds(1), .seconds(2), .seconds(3),
    ]

    private(set) var board: WaffledAPI.PlanningConnectionBoard?
    private(set) var rows: [PlanningConnectionRow] = []
    /// A failed fetch keeps the previous board and STILL counts as loaded (`RestDomain`).
    private(set) var loaded = false
    /// The last read failed. Drives the banner; it does NOT blank a board we already have.
    private(set) var failed = false
    /// WHICH EVENT ANSWERS EACH PAIRING, keyed by the pairing's people → event id. Written
    /// back through the mid-step route: a link is the answer, so it must survive walking away.
    private(set) var links: [String: String] = [:]
    private(set) var added = 0
    /// Bumped on every observable change, so the view pushes the crumb from one `.onChange`.
    private(set) var revision = 0

    private let fetchBoard: FetchBoard
    private let fetchSlots: FetchSlots
    private let saveLinks: SaveLinks
    private let wait: Wait

    init(
        fetchBoard: @escaping FetchBoard = { weekStart in
            try await WaffledAPI().planningConnectionBoard(weekStart: weekStart)
        },
        fetchSlots: @escaping FetchSlots = { weekStart, personIds in
            try await WaffledAPI().planningConnectionSlots(weekStart: weekStart, personIds: personIds)
        },
        saveLinks: @escaping SaveLinks = { sessionId, links in
            try await WaffledAPI().savePlanningConnectionLinks(sessionId: sessionId, links: links)
        },
        wait: @escaping Wait = { duration in try? await Task.sleep(for: duration) }
    ) {
        self.fetchBoard = fetchBoard
        self.fetchSlots = fetchSlots
        self.saveLinks = saveLinks
        self.wait = wait
    }

    // MARK: - The crumb

    /// `decideStep` REPLACES the step's `data`, so `links` — persisted onto the same row by
    /// the mid-step route — must be written back. Keys match the web's exactly.
    var decisionData: [String: JSONValue] {
        [
            "added": .int(added),
            "alreadyCounted": .int(links.count),
            "links": .object(links.mapValues(JSONValue.string)),
        ]
    }

    /// Which week the links in hand were seeded for — see `seedLinks`.
    private var seededWeek: String?

    /// Seed `links` from the step's own persisted `data.links`, BEFORE the read lands.
    ///
    /// Guarded on `links.isEmpty` so this sitting's link survives a re-seed — and on the WEEK,
    /// because the keys are person-id joins identical across weeks: without that, week B
    /// renders week A's answers and the next `PUT /links` writes A's event ids onto B.
    func seedLinks(from value: JSONValue?, weekStart: String) {
        if seededWeek != weekStart {
            links = [:]
            seededWeek = weekStart
            rebuild()
        }
        guard links.isEmpty, let value, case let .object(map) = value else { return }
        var seeded: [String: String] = [:]
        for (key, entry) in map {
            if case let .string(eventId) = entry { seeded[key] = eventId }
        }
        guard !seeded.isEmpty else { return }
        links = seeded
        rebuild()
    }

    // MARK: - Reading the board

    func load(weekStart: String) async {
        do {
            board = try await fetchBoard(weekStart)
            failed = false
        } catch {
                // Keep the board we had: a row vanishing mid-read is worse than a stale one.
            failed = true
        }
        loaded = true
        rebuild()
    }

    /// Gaps for people the app didn't suggest. nil when the server refuses (fewer than two
    /// people, a stranger's id), which the caller renders as "no slots", not an error.
    func slots(weekStart: String, personIds: [String]) async -> WaffledAPI.PlanningConnectionSlots? {
        try? await fetchSlots(weekStart, personIds)
    }

    // MARK: - Linking a time

    /// Record (or clear) which event answers a pairing — a POINTER; no event is edited.
    /// Re-picking the linked event unlinks it. A failed write costs the link, not the sitting.
    func link(key: String, eventId: String?, sessionId: String) async {
        var next = links
        if eventId == nil || next[key] == eventId {
            next.removeValue(forKey: key)
        } else {
            next[key] = eventId
        }
        links = next
        rebuild()
        try? await saveLinks(sessionId, next)
    }

    // MARK: - After a save

    /// An event was really created here: re-read until the board agrees, then link what
    /// appeared. `participantIds` is what the composer was opened with, in household order, so
    /// a from-scratch pairing matches no row and links nothing, which is correct.
    func settleAfterSave(weekStart: String, sessionId: String, participantIds: [String]) async {
        added += 1
        revision &+= 1
        // Read both BEFORE the re-read, so the difference afterwards names the new event.
        let was = PlanningConnectionCopy.credited(board)
        let key = participantIds.joined(separator: "-")
        let row = board?.pairings.first { $0.key == key }
        let before = row.map { Set($0.alreadyThisWeek.map(\.id)) }
        await settle(
            weekStart: weekStart, sessionId: sessionId, was: was,
            autoLink: before.map { (key: key, before: $0) })
    }

    /// THE CATCH-UP LADDER: stop the moment the credited count goes UP — see `catchup`.
    func settle(
        weekStart: String,
        sessionId: String,
        was: Int,
        autoLink: (key: String, before: Set<String>)?
    ) async {
        for attempt in 0...Self.catchup.count {
            do {
                let next = try await fetchBoard(weekStart)
                board = next
                failed = false
                loaded = true
                rebuild()
                if PlanningConnectionCopy.credited(next) > was {
                    // An event you make for a pairing is that pairing's answer, and WHICH event
                    // is answered by DIFFERENCE rather than an id from the sheet: the write is
                    // local-first, so only an id that APPEARED since we looked is on the server.
                    if let autoLink,
                       let pair = next.pairings.first(where: { $0.key == autoLink.key }),
                       let fresh = pair.alreadyThisWeek.first(where: { !autoLink.before.contains($0.id) }) {
                        await link(key: autoLink.key, eventId: fresh.id, sessionId: sessionId)
                    }
                    return
                }
            } catch {
                // A failed read is not "not caught up yet" — the ladder would hammer a dead
                // endpoint six times. Keep the board, stop.
                failed = true
                loaded = true
                revision &+= 1
                return
            }
            // No pause after the last attempt: the ladder gives up rather than looping.
            guard attempt < Self.catchup.count else { return }
            await wait(Self.catchup[attempt])
        }
    }

    /// Dismiss the read-failure banner. The board under it is the last SUCCESSFUL read.
    func clearFailed() {
        failed = false
        revision &+= 1
    }

    // MARK: - Rows

    private func rebuild() {
        rows = PlanningConnectionCopy.visible(board?.pairings ?? [])
            .map { PlanningConnectionRow($0, linkedId: links[$0.key]) }
        revision &+= 1
    }
}

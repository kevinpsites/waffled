import Foundation
import Observation

// Weekly Planning · step 10 (Recap) — the step's state and its pure formatting. Ported from
// `apps/web/src/kiosk/planning/steps/RecapStep.tsx`.
//
// THE MODEL COMPUTES NOTHING ABOUT THE WEEK: every headline, sentence and tally arrives
// resolved from `GET /api/weekly-planning/recap`, and a client that re-added the counts would
// be a second reading of the week, free to drift from the server's and from the web's. What
// this file decides is the day labels and one `SyncedEvent` per event, so the strip can be
// tinted through the app's OWN `EventPalette`.

// MARK: - Formatting

enum PlanningRecapText {

    /// The dinner line: "Lentil soup · Lottie". Mirrors the web's `mealLine`, including that a
    /// cook with no meal produces nothing.
    static func mealLine(meal: String?, cook: String?) -> String? {
        guard let meal, !meal.isEmpty else { return nil }
        guard let cook, !cook.isEmpty else { return meal }
        return "\(meal) · \(cook)"
    }

    /// The card header's own number, which is the server's `counts.decisions` and never a sum
    /// this file computed.
    static func decisionsLabel(_ n: Int) -> String {
        n == 1 ? "1 decision" : "\(n) decisions"
    }

    /// THE TENSE. The recap reads on two surfaces — step 10, and the finished-week record,
    /// which may be opened on Thursday — so no sentence may promise what SAVING will do. Which
    /// surface it is comes from the week's own `savedAt`, never a flag a view passes down.

    static func changedTitle(saved: Bool) -> String {
        saved ? "What the session changed" : "What tonight changed"
    }

    static func nothingDecidedDetail(saved: Bool) -> String {
        saved
            ? "The week was saved as it stood — everything on the calendar, the plan and the board is exactly as it was."
            : "Saving still records the week you read back — and everything on the calendar, the plan and the board stays exactly as it is."
    }

    static func footNote(saved: Bool) -> String {
        let pointer = "Every line above is a pointer, not a copy — it is already live in Calendar, Meals, Lists, Chores and Goals."
        return saved
            ? "\(pointer) The record was written when the week was saved: what was decided, what was deferred, what rolled over. Today is the surface now, not this session."
            : "\(pointer) Saving writes the record: what was decided, what was deferred, what rolled over, with a timestamp. After that Today is the surface, not this session."
    }

    static func lastCallMoreLabel(_ n: Int) -> String {
        n == 1 ? "…and 1 more still on the board" : "…and \(n) more still on the board"
    }

    /// "Sun" and "6" for a `YYYY-MM-DD`. UTC + POSIX, matching `PlanningFormat`: a day in the
    /// planned week is a calendar LABEL, and parsing it in the device's zone renders the
    /// previous weekday for anybody west of Greenwich.
    static func dayName(_ ymd: String) -> String {
        guard let d = isoDay.date(from: ymd) else { return ymd }
        return shortDay.string(from: d)
    }

    static func dayNumber(_ ymd: String) -> String {
        guard let d = isoDay.date(from: ymd) else { return "" }
        return dayNum.string(from: d)
    }

    private static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let shortDay: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "EEE"
        return f
    }()
    private static let dayNum: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "d"
        return f
    }()
}

// MARK: - Rows

/// One event on the strip. `synced` is a `SyncedEvent` built from the payload's colour INPUTS —
/// owner, owner colour, participants — precomputed here so a row is one set lookup rather than
/// three allocations per frame. Reusing the app's own resolver is the point: the week read back
/// has to look like the calendar it describes.
struct PlanningRecapEventRow: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    /// "Saturday 8:00 PM" — server-composed, household-local. Text, not a date.
    let when: String
    let synced: SyncedEvent
}

struct PlanningRecapDayRow: Identifiable, Equatable, Sendable {
    let date: String
    let dayName: String
    let dayNumber: String
    let mealLine: String?
    let events: [PlanningRecapEventRow]
    let more: Int

    var id: String { date }
}

// MARK: - Model

@MainActor
@Observable
final class PlanningRecapModel {
    typealias FetchRecap = (
        _ sessionId: String?, _ weekStart: String?
    ) async throws -> WaffledAPI.PlanningRecapView
    /// Dropping a note is step 1's `POST /loose-ends/resolve` — the writer that owns
    /// `planning_parked_items`. This step grows no second way to answer a note.
    typealias DropNote = (_ id: String, _ sessionId: String) async throws -> Void

    private(set) var view: WaffledAPI.PlanningRecapView?
    private(set) var loaded = false
    private(set) var days: [PlanningRecapDayRow] = []
    private(set) var working: String?
    var errorMessage: String?
    /// Bumped on every applied read, so the view pushes the crumb on one `onChange`.
    private(set) var rev = 0

    /// Notes the family walked past ON PURPOSE. Local, and that is the design: "keep it parked"
    /// writes NOTHING, and the note turns up in next Sunday's step 1.
    private(set) var keptIds: Set<String> = []
    private(set) var droppedIds: Set<String> = []

    private let fetchRecap: FetchRecap
    private let dropNote: DropNote

    init(
        fetchRecap: @escaping FetchRecap = { sessionId, weekStart in
            try await WaffledAPI().planningRecap(sessionId: sessionId, weekStart: weekStart)
        },
        dropNote: @escaping DropNote = { id, sessionId in
            _ = try await WaffledAPI().resolvePlanningLooseEnd(
                kind: "parked", id: id, action: "drop", sessionId: sessionId)
        }
    ) {
        self.fetchRecap = fetchRecap
        self.dropNote = dropNote
    }

    // MARK: Derived

    var openLastCall: [WaffledAPI.PlanningRecapLastCall] {
        (view?.lastCall ?? []).filter { !keptIds.contains($0.id) && !droppedIds.contains($0.id) }
    }

    var groups: [WaffledAPI.PlanningRecapGroup] { view?.groups ?? [] }
    var leftAlone: [WaffledAPI.PlanningRecapLeftAlone] { view?.leftAlone ?? [] }
    var counts: WaffledAPI.PlanningRecapCounts { view?.counts ?? .init() }

    var nothingDecided: Bool { groups.isEmpty && leftAlone.isEmpty }

    /// The week is already saved — the record, not step 10. Off the payload, because the server
    /// ships `savedAt` for exactly this and a screen-level flag would be a second opinion.
    var saved: Bool { view?.savedAt != nil }

    /// The receipt's integers, and ONLY those. NIL UNTIL A READ HAS LANDED: the shell REPLACES
    /// the step's data when the affirmative is pressed, so handing one up after a failed fetch
    /// would write zeroes over a week that really did decide things.
    var crumb: [String: JSONValue]? { PlanningRecapCrumb.decision(view) }

    func dismissError() { errorMessage = nil }

    // MARK: Read

    /// Read the week back. A FAILED fetch keeps whatever was on screen and still sets `loaded`,
    /// so the last screen of the session says what happened rather than spinning.
    func load(sessionId: String?, weekStart: String?) async {
        do {
            apply(try await fetchRecap(sessionId, weekStart))
        } catch {
            if view == nil {
                errorMessage = "Couldn’t read the week back just now — the week itself is unaffected."
            }
        }
        loaded = true
    }

    // MARK: The one write — and it belongs to step 1

    /// "Keep it parked" writes NOTHING — the quiet answer, and the note being still open next
    /// Sunday is the feature.
    func keepParked(_ id: String) {
        guard working == nil else { return }
        keptIds.insert(id)
    }

    /// "Drop it" — through step 1's resolver. A failure leaves the note on the board rather
    /// than hiding a row whose write never landed.
    func drop(_ id: String, sessionId: String) async {
        guard working == nil else { return }
        working = id
        errorMessage = nil
        defer { working = nil }
        do {
            try await dropNote(id, sessionId)
            droppedIds.insert(id)
        } catch {
            errorMessage = "That didn’t take — the note is still on the board."
        }
    }

    private func apply(_ fresh: WaffledAPI.PlanningRecapView) {
        view = fresh
        days = fresh.days.map { day in
            PlanningRecapDayRow(
                date: day.date,
                dayName: PlanningRecapText.dayName(day.date),
                dayNumber: PlanningRecapText.dayNumber(day.date),
                mealLine: PlanningRecapText.mealLine(meal: day.meal, cook: day.cook),
                events: day.events.map { event in
                    PlanningRecapEventRow(
                        id: event.id, title: event.title, when: event.when,
                        // The colour INPUTS, in the shape `EventPalette` reads. Only the four
                        // fields that decide a colour are filled: an invented `startsAt` would
                        // put a wrong instant somewhere.
                        synced: SyncedEvent(
                            id: event.id, title: event.title, startsAtRaw: nil, startsAt: nil,
                            allDay: false, personId: event.personId, colorHex: event.personColor,
                            emoji: nil, participantIds: event.participantIds))
                },
                more: day.more)
        }
        rev += 1
    }
}

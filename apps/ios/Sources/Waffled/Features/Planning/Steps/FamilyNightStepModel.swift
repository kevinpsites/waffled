import Foundation
import Observation

// Weekly Planning · step 4 (Family night) — the step's model and its pure formatting.
// Ported from `apps/web/src/kiosk/planning/steps/FamilyNightStep.tsx`.
//
// EVERY WRITE IS FOLLOWED BY A RE-READ rather than a local patch: the server owns which
// parts are on rotation. A SKIPPED WEEK STILL TAKES ITS TURN — the rotation is a COUNT
// of occurrences and does not exclude skipped ones, so calling a week off moves
// everybody on a place. That is a product call, and the skip bar says it out loud. Do
// not "fix" it.

// MARK: - Formatting

/// Pure strings, computed ONCE PER LOAD in the model and looked up O(1) by the view —
/// the project's "keep date math out of the render path" rule. Formatters are `static
/// let` likewise.
enum PlanningFamilyNightFormat {

    /// "2026-09-09" → "Wednesday, Sep 9". UTC + POSIX on the parse: the gathering's date
    /// is a calendar LABEL, and a device in a negative offset parsing it locally gets
    /// the 8th back.
    static func longDate(_ ymd: String) -> String {
        guard let d = isoDay.date(from: ymd) else { return ymd }
        return longDay.string(from: d)
    }

    /// "17:00" → "5:00 PM". Shared with the Today card's clock so the two say the hour
    /// alike.
    static func clockTime(_ hhmm: String) -> String { FamilyNightFormat.timeLabel(hhmm) }

    /// The line under a part's label — is this the rotation's guess, or did somebody
    /// decide?
    static func suggestion(_ part: WaffledAPI.PlanningFamilyNightPart) -> String {
        guard let name = part.personName else { return "nobody yet" }
        return part.pinned
            ? "pinned for this week · \(name)"
            : "suggested · \(name), next in the rotation"
    }

    /// Placeholders for the three default parts, keyed by the DEFAULT slugs only — a
    /// household that renames or adds parts falls through to the generic question built
    /// from its own label.
    static func detailHint(_ part: WaffledAPI.PlanningFamilyNightPart) -> String {
        switch part.partId {
        case "activity": return #"optional — "charades, kids vs parents""#
        case "treat":    return #"optional — "the good ice cream""#
        case "checkin":  return #"optional — "how was school, actually""#
        default:         return "optional — what's the \(part.label.lowercased())?"
        }
    }

    /// Step a plain `YYYY-MM-DD` by whole days, in UTC. A date here is a label, never an
    /// instant.
    static func plusDays(_ ymd: String, _ days: Int) -> String {
        guard let d = isoDay.date(from: ymd) else { return ymd }
        return isoDay.string(from: d.addingTimeInterval(Double(days) * 24 * 60 * 60))
    }

    private static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let longDay: DateFormatter = {
        let f = DateFormatter()
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "EEEE, MMM d"
        return f
    }()
}

// MARK: - The crumb

/// What this sitting DECIDED, for the session record. NOT a copy of the module: the
/// recap reads through to familyNight itself for the detail.
///
/// The keys mirror `planningFamilyNightDecision` on the web VERBATIM — both platforms
/// write into the same `weekly_planning_steps.data`, so divergent keys break the recap
/// on one only.
enum PlanningFamilyNightDecision {
    static func crumb(_ board: WaffledAPI.PlanningFamilyNightBoard?) -> [String: JSONValue] {
        [
            "pinned": .array((board?.parts ?? []).filter(\.pinned).map { .string($0.partId) }),
            "skipped": .bool(board?.status == "skipped"),
        ]
    }
}

// MARK: - Model

@MainActor
@Observable
final class PlanningFamilyNightModel {
    /// Every network op is injected as a closure with a `WaffledAPI()`-backed default —
    /// the test seam this app uses everywhere.
    typealias FetchBoard = (_ weekStart: String) async throws -> WaffledAPI.PlanningFamilyNightBoard
    typealias SaveOccurrence = (_ body: [String: JSONValue]) async throws -> Void
    typealias FetchWeekEvents = (_ from: String, _ to: String) async throws -> [WaffledAPI.PlanningWeekEvent]

    /// One part, with its derived strings already built.
    struct PartRow: Identifiable, Sendable {
        let part: WaffledAPI.PlanningFamilyNightPart
        /// "suggested · Kelly, next in the rotation".
        let suggestion: String
        let detailHint: String
        /// Three rows each showing "What" need three distinct accessible names.
        let detailAccessibilityLabel: String
        var id: String { part.partId }
    }

    private(set) var board: WaffledAPI.PlanningFamilyNightBoard?
    /// Flips true after the first fetch ATTEMPT completes, failed or not — so the step
    /// can tell "still reading" from "read it, and here is what there is".
    private(set) var loaded = false
    /// A write is in flight. Separate from the shell's own `busy`.
    private(set) var busy = false
    /// Bumped on every applied board, so the view knows when to re-hand the shell its
    /// crumb.
    private(set) var rev = 0

    // Derived once per load — never recomputed in the render path.
    private(set) var rows: [PartRow] = []
    private(set) var recurrence = ""
    private(set) var when = ""

    /// The week's events for "Link an event". Fetched only when the picker is opened.
    private(set) var weekEvents: [WaffledAPI.PlanningWeekEvent] = []
    private(set) var weekEventsLoaded = false

    /// Settable so `DismissibleErrorBanner`'s ✕ can clear it.
    var errorMessage: String?

    private let fetchBoard: FetchBoard
    private let saveOccurrence: SaveOccurrence
    private let fetchWeekEvents: FetchWeekEvents

    init(
        fetchBoard: @escaping FetchBoard = { weekStart in
            try await WaffledAPI().planningFamilyNightBoard(weekStart: weekStart)
        },
        saveOccurrence: @escaping SaveOccurrence = { body in
            _ = try await WaffledAPI().saveFamilyNightOccurrence(body: body)
        },
        fetchWeekEvents: @escaping FetchWeekEvents = { from, to in
            try await WaffledAPI().planningWeekEvents(from: from, to: to)
        }
    ) {
        self.fetchBoard = fetchBoard
        self.saveOccurrence = saveOccurrence
        self.fetchWeekEvents = fetchWeekEvents
    }

    /// The crumb for the shell, rebuilt from whatever is currently on screen.
    var crumb: [String: JSONValue] { PlanningFamilyNightDecision.crumb(board) }

    /// The gathering's date — what every write is scoped to, and what makes a pin "for
    /// this week only" true rather than aspirational.
    var date: String? { board?.date }

    /// Read the week. A FAILED fetch keeps the board that was already there but still
    /// counts as loaded, so the step doesn't sit on "Reading…" forever.
    func load(weekStart: String) async {
        do {
            apply(try await fetchBoard(weekStart))
        } catch {
            if board == nil {
                errorMessage = "Couldn't read this week's family night — reload and try again."
            }
        }
        loaded = true
    }

    /// Post one of `PlanningFamilyNightBody`'s bodies, then re-read. A FAILED WRITE DOES
    /// NOT REFETCH AND DOES NOT MUTATE: nothing moved, so a fresh read would only invite
    /// the reader to wonder what changed. Returns true when the write landed.
    @discardableResult
    func write(_ body: [String: JSONValue], weekStart: String) async -> Bool {
        guard !busy else { return false }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            try await saveOccurrence(body)
        } catch {
            errorMessage = "That didn't take — try again."
            return false
        }
        // The write landed. A re-read that fails afterwards leaves the previous board up
        // — same contract as `load`.
        if let fresh = try? await fetchBoard(weekStart) { apply(fresh) }
        return true
    }

    /// The week's events, for the picker. Loaded lazily and kept. Meal-plan mirrors are
    /// dropped: offering one would put a dinner where an evening goes.
    func loadWeekEvents(weekStart: String) async {
        guard !weekEventsLoaded else { return }
        let last = PlanningFamilyNightFormat.plusDays(weekStart, 6)
        if let events = try? await fetchWeekEvents(weekStart, last) {
            weekEvents = events.filter { $0.origin != "meal_plan" && $0.origin != "meal_prep" }
        }
        weekEventsLoaded = true
    }

    private func apply(_ fresh: WaffledAPI.PlanningFamilyNightBoard) {
        board = fresh
        rows = fresh.parts.map { part in
            PartRow(
                part: part,
                suggestion: PlanningFamilyNightFormat.suggestion(part),
                detailHint: PlanningFamilyNightFormat.detailHint(part),
                detailAccessibilityLabel: "What is the \(part.label.lowercased())?")
        }
        recurrence = "every \(PlanningFormat.planningDayName(fresh.dayOfWeek))"
        when = "\(PlanningFamilyNightFormat.longDate(fresh.date)) · \(PlanningFamilyNightFormat.clockTime(fresh.time))"
        rev += 1
    }
}

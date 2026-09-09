import Foundation

// Weekly Planning — the shell's wire types.
//
// THE STEP CATALOG IS SERVER-OWNED: keys, titles, questions, labels and acts all arrive in
// the view and iOS hardcodes none of it (meals off ⇒ nine steps and "3 of 9").
//
// Names are camelCase and 1:1 with the server because `WaffledAPI.decoder` has no key
// strategy, and every date is a `String` for the same reason — `weekStart` is a
// household-local `YYYY-MM-DD` that must never go near a `Date` round-trip.
extension WaffledAPI {

    /// A parked note handed to the step it was tagged for. Capped server-side: a nudge.
    struct PlanningStepHandoff: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let note: String
        let byline: String?
    }

    // Equatable, NOT Hashable: `data` is [String: JSONValue], which is Equatable only, so
    // Hashable cannot be synthesized. `Identifiable` is what ForEach needs.
    struct PlanningStep: Decodable, Identifiable, Equatable, Sendable {
        let key: String
        /// 1-based position in the CATALOG, including steps this household doesn't run.
        ///
        /// ⚠️ NOT the "2 of 9" the counter shows: this skips unavailable steps while the total
        /// counts only runnable ones. Derive positions from `PlanningFormat.position`.
        let number: Int
        let title: String
        let ask: String
        let primary: String
        let act: String
        /// Absent on five of the ten steps — a step with no module behind it.
        let requiresModule: String?
        /// False when this step's module is off, or the household turned the step off.
        let available: Bool
        /// "pending" | "done" | "skipped".
        let status: String
        /// The step's crumb. Free-form by design, so a step reads its own keys out of it.
        let data: [String: JSONValue]
        let decidedAt: String?
        /// `?? []` at every read site: a missing field must cost the banner, not the screen.
        let parked: [PlanningStepHandoff]?

        var id: String { key }
        var isDone: Bool { status == "done" }
        var isSkipped: Bool { status == "skipped" }
        var isSettled: Bool { status != "pending" }
    }

    struct PlanningSession: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let weekStart: String
        /// "active" | "completed".
        let status: String
        let currentStep: String?
        let driverPersonId: String?
        let startedAt: String
        let completedAt: String?

        var isActive: Bool { status == "active" }
        var isCompleted: Bool { status == "completed" }
    }

    struct WeeklyPlanningConfig: Decodable, Hashable, Sendable {
        /// 0 = Sunday … 6 = Saturday, for the "session due" prompt. It does NOT decide which
        /// week is planned — the server does.
        let dayOfWeek: Int
        /// "HH:MM", household-local.
        let time: String
        /// Per-step opt-out keyed by catalog key. Absent ⇒ on; a module-off step is
        /// unavailable regardless.
        let steps: [String: Bool]
        let showOnToday: Bool
        /// Which lists step 1 is about — absent ⇒ relevant. Read through `asksAbout(_:)`, so
        /// "nobody has ruled on this list" isn't mistaken for "ruled out". OPTIONAL because an
        /// older server sends no key at all.
        let lists: [String: Bool]?

        init(
            dayOfWeek: Int, time: String, steps: [String: Bool], showOnToday: Bool,
            lists: [String: Bool]? = nil
        ) {
            self.dayOfWeek = dayOfWeek
            self.time = time
            self.steps = steps
            self.showOnToday = showOnToday
            self.lists = lists
        }

        /// Whether the loose-ends step should ask about this list. Absent ⇒ yes.
        func asksAbout(_ listId: String) -> Bool { lists?[listId] != false }
    }

    struct WeeklyPlanningView: Decodable, Sendable {
        let config: WeeklyPlanningConfig
        /// The week this view is about — snapped and floored by the server. ECHO IT; never
        /// compute a week on the device (`Cal.weekStart` is nil while PowerSync is down).
        let weekStart: String
        /// The week a fresh session would plan: today's week if today IS the week-start day.
        let defaultWeekStart: String
        /// The earliest week the stepper may reach — a finished week cannot be planned.
        let minWeekStart: String
        let session: PlanningSession?
        let steps: [PlanningStep]
    }
}

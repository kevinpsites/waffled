import SwiftUI

// THE CONTRACT BETWEEN THE SHELL AND A STEP. The shell owns the chrome; each step owns
// only what goes between. All ten keys point at all ten view types here, so building a
// step means editing that step's own files and nothing else.
//
// Web parity with `planning/registry.ts`.

struct PlanningStepProps {
    let step: WaffledAPI.PlanningStep
    let sessionId: String

    /// The week being planned (`YYYY-MM-DD`, a household week start).
    ///
    /// ALWAYS USE THIS rather than computing a week on the device: the server owns the
    /// boundary, and `SyncManager.householdWeekStart` is `nil` while PowerSync is
    /// disconnected (planning runs entirely over REST).
    let weekStart: String

    /// Attach the crumb this step wants kept on the session record; `nil` clears it.
    /// NEVER A COPY OF MODULE DATA — the recap reads through to the owning modules.
    ///
    /// ONLY PERSISTED WHEN THE STEP IS ANSWERED (the shell holds it until Skip or the
    /// affirmative sends it), so it is a hint, never the authority for anything the step
    /// must find again; a mid-step write calls the step's own route.
    let setDecisionData: ([String: JSONValue]?) -> Void

    let refresh: () -> Void

    let busy: Bool

    /// WHAT STEP 1 ROUTED. Handed down here because routing appends to `data.routes` on the
    /// **looseEnds** row, and a body is handed only its OWN step.
    ///
    /// NOT read by any step body: the SHELL hands it to `PlanningHandoffBanner`, which
    /// shows routed items in the same top box as parked notes (a routed parked note would
    /// otherwise arrive through two doors — `routeLooseEnd` sets `step_key` too).
    let routes: [WaffledAPI.LooseEndRoute]

    /// Show another step. It does NOT move the session's `currentStep` — that is the
    /// cross-device resume pointer, and a recap row must not tell another device the
    /// family went back.
    let goToStep: (String) -> Void

    /// Lend the shell's parked-note banner this step's own verb, or `nil` to withdraw it: a
    /// step that HAS a composer lends one verb, which opens that composer seeded with the
    /// note's words. A STEP WITHOUT A COMPOSER LENDS NOTHING — a button reading "Make a
    /// goal" that only ticks the note off promises an action it does not perform.
    let lendVerb: (PlanningHandoffVerb?) -> Void

    /// Tell the shell a write THIS STEP owns is in flight, so Skip and the affirmative go
    /// cold until it lands (`busy` above is the SHELL's own writes). Without it the
    /// affirmative answers the step mid-write and records a crumb for work that has not
    /// landed. Only a step with a LONG write needs it.
    let reportBusy: (Bool) -> Void
}

/// One verb, lent to the shell's banner by the step you are standing on.
struct PlanningHandoffVerb {
    let label: String
    /// Open this step's OWN composer seeded with the note's words, reporting whether
    /// something was really created. A CANCELLED COMPOSER MUST REPORT `false`, or the note
    /// is settled and the only record that the thing needs doing is gone.
    let run: (_ note: String, _ done: @escaping (Bool) -> Void) -> Void
}

/// A step whose body has not been built yet: still walk-past-able, and answering it is a
/// real answer.
struct PlanningStepPlaceholder: View {
    let step: WaffledAPI.PlanningStep

    var body: some View {
        WaffledEmptyState(
            emoji: "🚧",
            title: step.title,
            message: "This step isn't on iPhone yet — it's on the web session. You can still skip it or mark it done."
        )
    }
}

/// THE REGISTRY. `default` is not dead code: the catalog is server-owned, so a newer
/// server can name a step this build has never heard of, and it must render as a
/// walk-past-able placeholder.
@ViewBuilder
func planningStepBody(_ props: PlanningStepProps) -> some View {
    switch props.step.key {
    case "looseEnds":   LooseEndsStepView(props: props)
    case "calendar":    CalendarStepView(props: props)
    case "horizon":     HorizonStepView(props: props)
    case "familyNight": FamilyNightStepView(props: props)
    case "connection":  ConnectionStepView(props: props)
    case "goals":       GoalsStepView(props: props)
    case "meals":       MealsStepView(props: props)
    case "tasks":       TasksStepView(props: props)
    case "kids":        KidsStepView(props: props)
    case "recap":       RecapStepView(props: props)
    default:            PlanningStepPlaceholder(step: props.step)
    }
}

/// One more control in the footer, beside Skip and the affirmative. Only Meals uses it;
/// everything else gets an `EmptyView`.
@ViewBuilder
func planningStepFooterExtra(_ props: PlanningStepProps) -> some View {
    switch props.step.key {
    case "meals": MealsStepFooterExtra(props: props)
    default:      EmptyView()
    }
}

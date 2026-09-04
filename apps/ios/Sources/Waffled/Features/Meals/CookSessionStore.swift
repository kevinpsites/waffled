import SwiftUI

/// The active Cook Mode session, hoisted OUT of the transient `RecipeDetailView`/
/// `CookModeView` `@State` into a durable, app-level `@Observable` injected via
/// `.environment`. Cook Mode is presented from the app root (`RootView`) off this
/// store, so it survives whatever the inner navigation does when the app backgrounds
/// and returns (on the iPad the kiosk shell otherwise resets to Today, tearing the
/// old in-view cover down). It also owns the running `timers` + `alarm`, so a timer
/// keeps counting across backgrounding, and it's the target a tapped timer
/// notification deep-links into.
///
/// A session is **one or more dishes** (`CookSession`): a plate is cooked as several
/// recipes at once, each holding its own step position, with timers running across all
/// of them. A recipe cooked on its own is simply a one-dish, plate-less session — which
/// is why `start(id:title:steps:ingredients:)` still means exactly what it always did.
@MainActor
@Observable
final class CookSessionStore {
    /// A recipe's cook that needs a "Used from your pantry" confirm. Set by `finish()`
    /// when the server finds on-hand pantry matches; `RootView` presents the shared
    /// `CookConfirmSheet` off it (the back half of the pantry↔meal loop). Identifiable
    /// by recipeId so `.sheet(item:)` drives it.
    struct PantryReconcile: Identifiable, Equatable {
        let id: String            // recipeId
        let title: String
        let matches: [WaffledAPI.RecipeMatch]
    }

    /// What's being cooked — one recipe or a whole plate. Non-nil ⇒ Cook Mode is up.
    private(set) var session: CookSession?
    /// Non-nil ⇒ show the pantry-reconcile sheet after finishing a cook.
    var pendingPantryReconcile: PantryReconcile?
    /// Every running/paused/ringing timer in the session, ACROSS all its dishes — one
    /// flat list, each entry naming the dish it belongs to. Flat (rather than per dish)
    /// because the dock shows the whole plate at once and the ticker reads it every
    /// second; `dishTimers(_:)` slices it when a single dish is what's wanted.
    var timers: [CookTimer] = []
    /// The in-app chime + local-notification scheduler. One instance for the session.
    let alarm: TimerAlarm

    private let api = WaffledAPI()
    private var principalGeneration: UInt64 = 0

    init(notificationManager: NotificationManager? = nil) {
        alarm = TimerAlarm(notificationManager: notificationManager)
    }

    /// A live session ⇒ present Cook Mode. Bound to the root `.fullScreenCover`.
    var isActive: Bool { session != nil }
    /// The plate's name, or the lone recipe's title — Cook Mode's top bar.
    var title: String { session?.title ?? "" }
    var dishes: [CookDish] { session?.dishes ?? [] }
    var activeDishId: String? { session?.activeDishId }
    var activeDish: CookDish? { session?.activeDish }
    /// True while cooking a plate — the dish tabs show, and timers name their dish.
    var isPlate: Bool { session?.isPlate ?? false }
    var steps: [WaffledAPI.RecipeStepDTO] { session?.steps ?? [] }
    var ingredients: [WaffledAPI.RecipeIngredientDTO] { session?.ingredients ?? [] }

    /// The step Cook Mode is showing *for the dish on screen*. Lives in the session (and
    /// therefore per dish) so it survives a background→foreground teardown of the
    /// presenting view AND so switching dishes doesn't lose anyone's place.
    var index: Int {
        get { session?.index ?? 0 }
        set { session?.index = newValue }
    }

    /// Ingredients ticked off as they go in — per dish, like `index`, and for the same
    /// reason: switching dishes must not disturb the one you left.
    func isTicked(_ key: String) -> Bool { session?.isTicked(key) ?? false }
    func toggleTick(_ key: String) { session?.toggleTick(key) }
    var tickedCount: Int { session?.tickedCount ?? 0 }

    /// One dish's timers — the tab badges and any per-dish view.
    func dishTimers(_ dishId: String) -> [CookTimer] { CookSession.timers(timers, for: dishId) }

    // MARK: starting

    /// Begin cooking a recipe (the Cook Mode button / auto-cook). Unchanged signature —
    /// a lone recipe is just a one-dish, plate-less session.
    ///
    /// Re-tapping the recipe that's already cooking is a no-op so its running timers and
    /// step position are kept — and, since a plate's dishes are recipes too, tapping Cook
    /// on a recipe that's already ON the active plate brings that dish forward instead of
    /// tearing the plate (and the other dishes' timers) down.
    func start(id: String, title: String,
               steps: [WaffledAPI.RecipeStepDTO], ingredients: [WaffledAPI.RecipeIngredientDTO]) {
        if session?.contains(id) == true { switchToDish(id); return }
        let dish = CookDish(id: id, title: title, role: nil, steps: steps, ingredients: ingredients)
        guard let s = CookSession(plateId: nil, title: title, dishes: [dish]) else { return }
        start(s)
    }

    /// Begin a genuinely new session. The outgoing one's pending alerts are cancelled and
    /// its timers dropped — that food is off the counter. This and `end()` are the ONLY
    /// paths that clear timers: moving between a plate's dishes never does (it used to,
    /// which is exactly what made a multi-dish plate impossible to cook).
    func start(_ session: CookSession) {
        cancelTimers()
        self.session = session
    }

    /// Cook a whole plate: every dish, each with its own steps and its own place in them.
    /// The methods are fetched concurrently up front so the dish tabs are ready the moment
    /// Cook Mode opens. Re-starting the plate already cooking is a no-op (timers + per-dish
    /// progress kept); a dish whose recipe won't load is skipped by `CookSession.plate`.
    func startPlate(_ meal: WaffledAPI.MealDTO) async {
        let generation = principalGeneration
        await startPlate(meal, principalGeneration: generation)
    }

    private func startPlate(
        _ meal: WaffledAPI.MealDTO,
        principalGeneration expectedGeneration: UInt64
    ) async {
        if session?.plateId == meal.id { return }
        guard let s = CookSession.plate(meal, methods: await methods(for: meal)) else { return }
        guard principalGeneration == expectedGeneration else { return }
        start(s)
    }

    /// Same, given only the plate's id (a plate card, or a tapped timer notification).
    func startPlate(mealId: String) async {
        let generation = principalGeneration
        if session?.plateId == mealId { return }
        guard let meal = try? await api.meal(id: mealId) else { return }
        guard principalGeneration == generation else { return }
        await startPlate(meal, principalGeneration: generation)
    }

    /// Fetch every dish's steps + ingredients at once. `MealDishDTO` carries the plate's
    /// framing (role, order, cook) but not the method, so each dish needs its own detail
    /// call; in parallel, because a four-dish plate serially would be four round-trips of
    /// staring at a spinner.
    private func methods(for meal: WaffledAPI.MealDTO) async -> [String: CookMethod] {
        let api = self.api
        let ids = meal.recipes.map(\.recipeId)
        return await withTaskGroup(of: (String, CookMethod?).self) { group in
            for id in ids {
                group.addTask {
                    guard let d = try? await api.recipeDetail(id: id) else { return (id, nil) }
                    return (id, CookMethod(title: d.recipe.title, steps: d.steps,
                                           ingredients: d.ingredients))
                }
            }
            var out: [String: CookMethod] = [:]
            for await (id, m) in group { if let m { out[id] = m } }
            return out
        }
    }

    // MARK: moving around

    /// Bring another of the plate's dishes on screen. Its own step is restored, and every
    /// timer — including the one on the dish you just left — keeps running.
    func switchToDish(_ dishId: String) { session?.activate(dishId) }

    /// Go to the dish a timer belongs to, at that timer's step. One call on purpose: a tap
    /// on ANOTHER dish's timer in the dock must move that dish, never the current one.
    func jump(to timer: CookTimer) {
        session?.jump(toDish: timer.dishId, step: timer.stepIndex)
    }

    // MARK: getting back

    /// Where the last timer jump pulled you off, if you aren't already back there — the
    /// screen offers one tap to return. See `CookSession.pendingReturn`.
    var pendingReturn: CookSession.Mark? { session?.pendingReturn }
    /// The dish that offer points at, for the label.
    var pendingReturnTitle: String? { session?.pendingReturnTitle }
    /// Take the offer — restores the dish AND its step.
    func goBack() { session?.goBack() }
    /// The pill's × — forget the offer without moving.
    func dismissReturn() { session?.dismissReturn() }

    // MARK: timers

    /// Start a timer on the dish that's on screen. Timers are keyed by **(dish, step)** —
    /// step 3 of the main and step 3 of the side are different timers — and on a plate the
    /// name carries the dish, so the dock, the alarm and the lock screen all say which pan
    /// is beeping. nil ⇒ nothing is cooking.
    @discardableResult
    func startTimer(secs: Int, stepIndex: Int, stepNumber: Int) -> CookTimer? {
        guard let dish = session?.activeDish else { return nil }
        let t = CookTimer(notifId: "waffled.cook.\(UUID().uuidString)",
                          dishId: dish.id,
                          // Only a plate qualifies its timers; naming the one recipe you're
                          // cooking in every label would just be noise.
                          dishTitle: isPlate ? dish.title : nil,
                          stepIndex: stepIndex, stepNumber: stepNumber, total: secs,
                          fireAt: Date().addingTimeInterval(TimeInterval(secs)),
                          running: true, firing: false, pausedRemaining: secs)
        timers.append(t)
        schedule(t)
        return t
    }

    /// (Re)schedule a timer's out-of-app alert — on start, on resume, and on +1:00.
    /// Re-adding under the same notification id replaces, so those stay idempotent.
    func schedule(_ t: CookTimer) {
        alarm.scheduleNotification(id: t.notifId, fireAt: t.fireAt, name: t.displayName,
                                   link: CookTimerLink(dishId: t.dishId, stepIndex: t.stepIndex,
                                                       plateId: session?.plateId))
    }

    /// Drop a timer and its pending alert (dock ✕ / alarm Dismiss).
    func removeTimer(_ t: CookTimer) {
        alarm.cancelNotification(t.notifId)
        timers.removeAll { $0.id == t.id }
    }

    private func cancelTimers() {
        for t in timers { alarm.cancelNotification(t.notifId) }
        timers = []
    }

    // MARK: notifications, ending

    /// A fired cook-timer notification was tapped: (re)present Cook Mode for the dish that
    /// beeped and jump to its step. If that dish is already in the live session we just
    /// move to it (keeping every other timer); otherwise we re-fetch — the whole plate when
    /// the timer named one, else the single recipe — and present that.
    func openFromNotification(_ link: CookTimerLink) {
        if session?.contains(link.dishId) == true {
            session?.jump(toDish: link.dishId, step: link.stepIndex)
            return
        }
        let generation = principalGeneration
        Task {
            guard principalGeneration == generation else { return }
            if let plateId = link.plateId {
                if let meal = try? await api.meal(id: plateId) {
                    guard principalGeneration == generation else { return }
                    await startPlate(meal, principalGeneration: generation)
                    guard principalGeneration == generation else { return }
                    if session?.contains(link.dishId) == true {
                        session?.jump(toDish: link.dishId, step: link.stepIndex)
                        return
                    }
                }
            }
            guard principalGeneration == generation else { return }
            guard let d = try? await api.recipeDetail(id: link.dishId) else { return }
            guard principalGeneration == generation else { return }
            start(id: link.dishId, title: d.recipe.title, steps: d.steps, ingredients: d.ingredients)
            session?.jump(toDish: link.dishId, step: link.stepIndex)
        }
    }

    /// Leave Cook Mode (the ✕). An explicit user action, so every dish's pending timer
    /// notifications are cancelled here (the background/teardown path never calls this).
    func end() {
        cancelTimers()
        alarm.stop()
        session = nil
    }

    /// Cook Mode is app-scoped so it survives ordinary navigation/backgrounding, but
    /// it must not survive an account, household, profile, or server boundary. Called
    /// from SyncManager's awaited principal-artifact cleanup before the next gate opens.
    func clearPrincipalArtifacts() {
        principalGeneration &+= 1
        end()
        pendingPantryReconcile = nil
    }

    /// Finish & mark cooked (last step). Records the cook of the dish on screen by id —
    /// independent of the (possibly torn-down) recipe detail view — closes Cook Mode, then
    /// (like the recipe screen's "Mark cooked") offers the "Used from your pantry"
    /// reconcile when the server finds on-hand matches. Presented once, from `RootView`,
    /// off `pendingPantryReconcile`.
    ///
    /// NOTE: on a plate this finishes the *session*, marking the dish you're looking at
    /// cooked. Finishing one dish and rolling on to the next (with a reconcile each) is
    /// deliberately out of scope here — the reconcile sheet is per recipe and combining
    /// several plates' matches risks double-decrementing a shared pantry item.
    func finish() {
        guard let dish = session?.activeDish else { end(); return }
        let id = dish.id, title = dish.title
        let generation = principalGeneration
        end()   // close Cook Mode straight away
        Task {
            guard principalGeneration == generation else { return }
            _ = try? await api.markRecipeCooked(id: id)
            guard principalGeneration == generation else { return }
            if let matches = try? await api.pantryForRecipe(recipeId: id), !matches.isEmpty {
                guard principalGeneration == generation else { return }
                pendingPantryReconcile = PantryReconcile(id: id, title: title, matches: matches)
            }
        }
    }
}

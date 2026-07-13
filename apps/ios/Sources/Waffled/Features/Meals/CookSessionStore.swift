import SwiftUI

/// A small, app-level link payload a fired cook-timer notification carries, so tapping
/// it can re-open Cook Mode at the right recipe + step. Kept separate from any view so
/// the notification delegate (in `NotificationManager`) can set it without importing
/// view types.
struct CookTimerLink: Equatable {
    let recipeId: String
    let stepIndex: Int
}

/// The active Cook Mode session, hoisted OUT of the transient `RecipeDetailView`/
/// `CookModeView` `@State` into a durable, app-level `@Observable` injected via
/// `.environment`. Cook Mode is presented from the app root (`RootView`) off this
/// store, so it survives whatever the inner navigation does when the app backgrounds
/// and returns (on the iPad the kiosk shell otherwise resets to Today, tearing the
/// old in-view cover down). It also owns the running `timers` + `alarm`, so a timer
/// keeps counting across backgrounding, and it's the target a tapped timer
/// notification deep-links into.
@MainActor
@Observable
final class CookSessionStore {
    /// The recipe currently being cooked. Non-nil ⇒ Cook Mode is presented.
    struct ActiveRecipe: Equatable {
        let id: String
        let title: String
        let steps: [WaffledAPI.RecipeStepDTO]
        let ingredients: [WaffledAPI.RecipeIngredientDTO]
    }

    private(set) var recipe: ActiveRecipe?
    /// The step Cook Mode is showing — lives here so it (and the timers) survive a
    /// background→foreground teardown of the presenting view.
    var index = 0
    /// The running/paused/ringing timers for this session. Owned here (not in the view)
    /// so they outlive the cover being torn down when the app backgrounds.
    var timers: [CookTimer] = []
    /// The in-app chime + local-notification scheduler. One instance for the session.
    let alarm = TimerAlarm()

    private let api = WaffledAPI()

    /// Non-nil recipe ⇒ present Cook Mode. Bound to the root `.fullScreenCover`.
    var isActive: Bool { recipe != nil }

    var steps: [WaffledAPI.RecipeStepDTO] { recipe?.steps ?? [] }

    /// Begin cooking a recipe (the Cook Mode button / auto-cook). Re-tapping the recipe
    /// that's already cooking is a no-op so its running timers + step position are kept.
    func start(id: String, title: String,
               steps: [WaffledAPI.RecipeStepDTO], ingredients: [WaffledAPI.RecipeIngredientDTO]) {
        if recipe?.id == id { return }
        // Switching to a different recipe → drop the previous session's pending alerts.
        for t in timers { alarm.cancelNotification(t.notifId) }
        timers = []
        index = 0
        recipe = ActiveRecipe(id: id, title: title, steps: steps, ingredients: ingredients)
    }

    /// A fired cook-timer notification was tapped: (re)present Cook Mode for that recipe
    /// and jump to the step whose timer went off. If that session is still active we just
    /// move to the step (keeping other timers); otherwise we fetch the recipe and present.
    func openFromNotification(_ link: CookTimerLink) {
        if recipe?.id == link.recipeId {
            if steps.indices.contains(link.stepIndex) { index = link.stepIndex }
            return
        }
        Task {
            guard let d = try? await api.recipeDetail(id: link.recipeId) else { return }
            for t in timers { alarm.cancelNotification(t.notifId) }
            timers = []
            recipe = ActiveRecipe(id: link.recipeId, title: d.recipe.title,
                                  steps: d.steps, ingredients: d.ingredients)
            index = d.steps.indices.contains(link.stepIndex) ? link.stepIndex : 0
        }
    }

    /// Leave Cook Mode (the ✕). An explicit user action, so pending timer notifications
    /// are cancelled here (the background/teardown path never calls this).
    func end() {
        for t in timers { alarm.cancelNotification(t.notifId) }
        timers = []
        alarm.stop()
        recipe = nil
        index = 0
    }

    /// Finish & mark cooked (last step). Records the cook by id — independent of the
    /// (possibly torn-down) recipe detail view — then closes Cook Mode.
    func finish() {
        if let id = recipe?.id {
            Task { _ = try? await api.markRecipeCooked(id: id) }
        }
        end()
    }
}

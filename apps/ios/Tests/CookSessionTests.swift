import Foundation
import Testing
@testable import Waffled

// Cooking a PLATE — a named, multi-recipe meal ("BBQ Sunday" = BBQ Chicken + Potato
// Salad + Coleslaw + Peach Cobbler) — means cooking several recipes at once: each dish
// keeps its own place in its own method, and several timers run across different dishes
// at the same time. That forces three things these tests pin down:
//
//   1. a timer is keyed by (dish, step), never by step alone — step 3 of the main and
//      step 3 of the side are different timers with different names;
//   2. moving between dishes is NOT starting a new session, so it must never cancel the
//      timers (or the pending notifications) of the dish you just left;
//   3. a fired timer's notification carries the dish id, so tapping it lands on the dish
//      that actually beeped.
//
// (`#expect` captures its expression in an escaping closure, so the mutating calls are
// hoisted into a `let` first rather than written inline in the macro.)

// MARK: fixtures

private func step(_ n: Int, _ text: String, timer: Int? = nil) -> WaffledAPI.RecipeStepDTO {
    WaffledAPI.RecipeStepDTO(stepNumber: n, instruction: text, ingredients: [],
                             timerSeconds: timer, note: nil)
}

private func ingredient(_ name: String) -> WaffledAPI.RecipeIngredientDTO {
    WaffledAPI.RecipeIngredientDTO(id: "ing-\(name)", name: name, amount: nil, unit: nil,
                                   prepNote: nil, display: nil, section: nil, aisle: nil,
                                   isStaple: false, sortOrder: nil, sub: nil)
}

private func dish(_ id: String, _ title: String, steps: Int = 4, role: String? = nil) -> CookDish {
    CookDish(id: id, title: title, role: role,
             steps: (1...steps).map { step($0, "\(title) step \($0)") },
             ingredients: [ingredient(title)])
}

private func plateSession(_ dishes: [CookDish], id: String = "plate-1",
                          name: String = "BBQ Sunday") -> CookSession {
    CookSession(plateId: id, title: name, dishes: dishes)!
}

private func soloSession(_ d: CookDish) -> CookSession {
    CookSession(plateId: nil, title: d.title, dishes: [d])!
}

private func timer(dish: String, dishTitle: String? = nil, step: Int, number: Int? = nil,
                   secs: Int = 300) -> CookTimer {
    CookTimer(notifId: "waffled.cook.\(dish)-\(step)", dishId: dish, dishTitle: dishTitle,
              stepIndex: step, stepNumber: number ?? step + 1, total: secs,
              fireAt: Date().addingTimeInterval(TimeInterval(secs)),
              running: true, firing: false, pausedRemaining: secs)
}

// MARK: the session itself

@Suite("CookSession — several dishes, each at its own step")
struct CookSessionTests {

    @Test("the first dish is the one on screen")
    func firstDishIsActive() {
        let s = plateSession([dish("main", "BBQ Chicken"), dish("side", "Potato Salad")])
        #expect(s.activeDishId == "main")
        #expect(s.activeDish?.title == "BBQ Chicken")
        #expect(s.isPlate)
    }

    @Test("a one-dish plate is still a plate — plateId decides, not the dish count")
    func oneDishPlateIsStillAPlate() {
        #expect(plateSession([dish("main", "BBQ Chicken")]).isPlate)
        #expect(!soloSession(dish("r1", "Tacos")).isPlate)
    }

    @Test("a session with no dishes cannot exist")
    func emptySessionIsNil() {
        #expect(CookSession(plateId: "plate-1", title: "BBQ Sunday", dishes: []) == nil)
    }

    @Test("switching dishes preserves each dish's own step")
    func switchingPreservesEachDishesStep() {
        var s = plateSession([dish("main", "BBQ Chicken"), dish("side", "Potato Salad")])
        s.index = 3                       // main is on step 4
        let toSide = s.activate("side")
        #expect(toSide)
        #expect(s.index == 0)             // the side hasn't started
        s.index = 2                       // side is on step 3
        let backToMain = s.activate("main")
        #expect(backToMain)
        #expect(s.index == 3)             // …and the main is right where we left it
        let toSideAgain = s.activate("side")
        #expect(toSideAgain)
        #expect(s.index == 2)
    }

    @Test("the step index is clamped to the active dish's own method")
    func indexIsClampedPerDish() {
        var s = plateSession([dish("main", "BBQ Chicken", steps: 4),
                              dish("dessert", "Peach Cobbler", steps: 2)])
        s.index = 99
        #expect(s.index == 3)
        let toDessert = s.activate("dessert")
        #expect(toDessert)
        s.index = 99
        #expect(s.index == 1)             // the cobbler only has two steps
        s.index = -4
        #expect(s.index == 0)
    }

    @Test("activating a dish that isn't on the plate changes nothing")
    func activatingAnUnknownDishIsANoOp() {
        var s = plateSession([dish("main", "BBQ Chicken")])
        let toNothing = s.activate("nope")
        #expect(!toNothing)
        #expect(s.activeDishId == "main")
        #expect(!s.contains("nope"))
        #expect(s.contains("main"))
    }

    @Test("jumping goes to a dish AND that dish's step in one move")
    func jumpMovesDishAndStep() {
        var s = plateSession([dish("main", "BBQ Chicken"), dish("side", "Potato Salad")])
        let jumped = s.jump(toDish: "side", step: 2)
        #expect(jumped)
        #expect(s.activeDishId == "side")
        #expect(s.index == 2)
        // The main is untouched — a jump doesn't rewind the dish you left.
        let toMain = s.activate("main")
        #expect(toMain)
        #expect(s.index == 0)
    }
}

// MARK: timers keyed by dish

@Suite("CookTimer — keyed by dish, not by step alone")
struct CookTimerKeyTests {

    @Test("the same step number on two dishes is two different timers")
    func sameStepDifferentDishesDontCollide() {
        let a = timer(dish: "main", dishTitle: "BBQ Chicken", step: 2)
        let b = timer(dish: "side", dishTitle: "Potato Salad", step: 2)
        #expect(a.key != b.key)
        #expect(a.key == CookTimer.Key(dishId: "main", stepIndex: 2))
        let mine = CookSession.timers([a, b], for: "side")
        #expect(mine.map(\.id) == [b.id])
    }

    @Test("a plate's timer names its dish; a lone recipe's just names the step")
    func timerLabelNamesTheDishOnAPlate() {
        let onAPlate = timer(dish: "side", dishTitle: "Potato Salad", step: 1, number: 2)
        #expect(onAPlate.stepLabel == "Step 2")
        #expect(onAPlate.label == "Potato Salad · Step 2")
        #expect(onAPlate.displayName == "Potato Salad · Step 2 · 5-minute timer")

        let alone = timer(dish: "r1", step: 1, number: 2)
        #expect(alone.label == "Step 2")
        #expect(alone.displayName == "Step 2 · 5-minute timer")
    }
}

// MARK: the notification round-trip

@Suite("CookTimerLink — a fired timer says which dish it belongs to")
struct CookTimerLinkTests {

    @Test("the dish and its plate round-trip through the notification payload")
    func roundTripsDishAndPlate() {
        let link = CookTimerLink(dishId: "side", stepIndex: 2, plateId: "plate-1")
        let info = link.userInfo(timerId: "waffled.cook.abc")
        #expect(info["cookTimerId"] as? String == "waffled.cook.abc")
        #expect(CookTimerLink.from(userInfo: info) == link)
    }

    @Test("a lone recipe round-trips with no plate")
    func roundTripsSoloRecipe() {
        let link = CookTimerLink(dishId: "r1", stepIndex: 0, plateId: nil)
        #expect(CookTimerLink.from(userInfo: link.userInfo(timerId: "t")) == link)
    }

    @Test("a payload from before plates (recipe id only) still deep-links")
    func legacyPayloadStillDecodes() {
        let info: [AnyHashable: Any] = ["cookRecipeId": "r1", "cookStepIndex": 3,
                                        "cookTimerId": "t"]
        #expect(CookTimerLink.from(userInfo: info)
                == CookTimerLink(dishId: "r1", stepIndex: 3, plateId: nil))
    }

    @Test("someone else's notification is not a cook timer")
    func foreignPayloadIsIgnored() {
        #expect(CookTimerLink.from(userInfo: ["eventId": "e1"]) == nil)
    }
}

// MARK: the store — the bit that used to kill the timers

@Suite("CookSessionStore — switching dishes is not starting a session")
@MainActor
struct CookSessionStoreTests {

    private func plateStore() -> CookSessionStore {
        let store = CookSessionStore()
        store.start(plateSession([dish("main", "BBQ Chicken", role: "main"),
                                  dish("side", "Potato Salad", role: "side")]))
        return store
    }

    @Test("a timer started on one dish keeps running after switching to another")
    func timersSurviveADishSwitch() {
        let store = plateStore()
        let t = try! #require(store.startTimer(secs: 600, stepIndex: 2, stepNumber: 3))
        #expect(t.dishId == "main")
        #expect(t.dishTitle == "BBQ Chicken")   // a plate's timers name their dish

        store.switchToDish("side")

        #expect(store.activeDishId == "side")
        #expect(store.timers.count == 1)
        #expect(store.timers.first?.id == t.id)
        #expect(store.timers.first?.running == true)
    }

    @Test("timers pile up across dishes and the dock can tell them apart")
    func timersAccumulateAcrossDishes() {
        let store = plateStore()
        _ = store.startTimer(secs: 600, stepIndex: 2, stepNumber: 3)
        store.switchToDish("side")
        _ = store.startTimer(secs: 300, stepIndex: 2, stepNumber: 3)   // same step, other dish

        #expect(store.timers.count == 2)
        #expect(Set(store.timers.map(\.key)).count == 2)
        #expect(store.dishTimers("main").count == 1)
        #expect(store.dishTimers("side").first?.dishTitle == "Potato Salad")
    }

    @Test("cooking a recipe that's already on the plate switches to it, plate intact")
    func cookingAPlateDishSwitchesInsteadOfReplacing() {
        let store = plateStore()
        _ = store.startTimer(secs: 600, stepIndex: 1, stepNumber: 2)

        // What RecipeDetailView's Cook button does — with a recipe already on the plate.
        store.start(id: "side", title: "Potato Salad",
                    steps: [step(1, "Boil"), step(2, "Chop")], ingredients: [])

        #expect(store.isPlate)                       // still cooking the whole plate
        #expect(store.dishes.count == 2)
        #expect(store.activeDishId == "side")
        #expect(store.timers.count == 1)             // …and the main's timer is untouched
    }

    @Test("cooking an unrelated recipe replaces the session and drops its timers")
    func aGenuinelyNewSessionDropsTheOldTimers() {
        let store = plateStore()
        _ = store.startTimer(secs: 600, stepIndex: 1, stepNumber: 2)

        store.start(id: "other", title: "Pancakes", steps: [step(1, "Whisk")], ingredients: [])

        #expect(!store.isPlate)
        #expect(store.dishes.map(\.id) == ["other"])
        #expect(store.timers.isEmpty)
    }

    @Test("re-tapping the recipe already cooking keeps its timers and its step")
    func restartingTheSameRecipeIsANoOp() {
        let store = CookSessionStore()
        store.start(id: "r1", title: "Tacos", steps: [step(1, "a"), step(2, "b"), step(3, "c")],
                    ingredients: [])
        store.index = 2
        _ = store.startTimer(secs: 60, stepIndex: 2, stepNumber: 3)

        store.start(id: "r1", title: "Tacos", steps: [step(1, "a"), step(2, "b"), step(3, "c")],
                    ingredients: [])

        #expect(store.index == 2)
        #expect(store.timers.count == 1)
    }

    @Test("a lone recipe's timers don't carry a dish name")
    func soloTimersAreUnqualified() {
        let store = CookSessionStore()
        store.start(id: "r1", title: "Tacos", steps: [step(1, "a")], ingredients: [])
        let t = try! #require(store.startTimer(secs: 60, stepIndex: 0, stepNumber: 1))
        #expect(t.dishTitle == nil)
        #expect(t.label == "Step 1")
    }

    @Test("ending the session cancels every dish's timers")
    func endingCancelsEverything() {
        let store = plateStore()
        _ = store.startTimer(secs: 600, stepIndex: 1, stepNumber: 2)
        store.switchToDish("side")
        _ = store.startTimer(secs: 600, stepIndex: 1, stepNumber: 2)
        #expect(store.timers.count == 2)

        store.end()

        #expect(store.timers.isEmpty)
        #expect(!store.isActive)
        #expect(store.dishes.isEmpty)
    }

    @Test("tapping another dish's timer jumps to THAT dish's step")
    func jumpingToATimerMovesItsOwnDish() {
        let store = plateStore()
        let t = try! #require(store.startTimer(secs: 600, stepIndex: 2, stepNumber: 3))
        store.switchToDish("side")
        store.index = 1

        store.jump(to: t)

        #expect(store.activeDishId == "main")
        #expect(store.index == 2)
        // The side kept its own place rather than being dragged to step 3.
        store.switchToDish("side")
        #expect(store.index == 1)
    }

    @Test("a fired timer's notification reopens its dish at its step")
    func notificationOpensTheRightDish() {
        let store = plateStore()
        store.index = 3

        store.openFromNotification(CookTimerLink(dishId: "side", stepIndex: 2, plateId: "plate-1"))

        #expect(store.activeDishId == "side")
        #expect(store.index == 2)
        #expect(store.isPlate)
    }
}

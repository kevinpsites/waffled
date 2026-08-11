import Foundation
import Testing
@testable import Waffled

// "Back to where I was" after a timer pulls you across the plate.
//
// A fired timer jumps you to ITS dish and ITS step. That is right — the beeping pan is
// the live one — but it costs you two things at once: the dish you were reading, and,
// if the timer belongs to the dish you're already on, your own place in it. Cooking
// three things at once is exactly when you can least afford to reconstruct that.
//
// So a jump records where it took you from, and the screen offers one tap back.
private func dish(_ id: String, steps: Int) -> CookDish {
    CookDish(id: id, title: id.capitalized, role: nil,
             steps: (1...steps).map {
                 WaffledAPI.RecipeStepDTO(stepNumber: $0, instruction: "step \($0)",
                                          ingredients: [], timerSeconds: nil, note: nil)
             },
             ingredients: [])
}

private func session() -> CookSession {
    CookSession(plateId: "m1", title: "BBQ Sunday",
                dishes: [dish("chicken", steps: 8), dish("salad", steps: 4), dish("bread", steps: 3)])!
}

@Suite struct CookReturnMarkTests {
    @Test("a fresh session has nowhere to go back to")
    func startsWithNoMark() {
        #expect(session().pendingReturn == nil)
    }

    @Test("a timer jump remembers the dish and step it pulled you off")
    func jumpRecordsWhereYouWere() throws {
        var s = session()
        s.index = 5                                   // knee-deep in the chicken
        s.jump(toDish: "salad", step: 1)              // the salad's timer goes off

        let back = try #require(s.pendingReturn)
        #expect(back.dishId == "chicken")
        #expect(back.step == 5)
        // and the jump did what it was asked
        #expect(s.activeDishId == "salad")
        #expect(s.index == 1)
    }

    @Test("going back restores both the dish and the step")
    func goBackRestoresBoth() {
        var s = session()
        s.index = 5
        s.jump(toDish: "salad", step: 1)
        s.goBack()
        #expect(s.activeDishId == "chicken")
        #expect(s.index == 5)
        // used up — the pill has done its job
        #expect(s.pendingReturn == nil)
    }

    /// The × on the pill.
    @Test("dismissing clears the mark without moving you")
    func dismissClearsWithoutMoving() {
        var s = session()
        s.index = 5
        s.jump(toDish: "salad", step: 1)
        s.dismissReturn()
        #expect(s.pendingReturn == nil)
        #expect(s.activeDishId == "salad")
        #expect(s.index == 1)
    }

    /// The jump that moves you nowhere shouldn't offer a way back to where you already
    /// are — tapping a timer for the step you're reading is a no-op, not a journey.
    @Test("a jump that doesn't move you records nothing")
    func standingStillRecordsNothing() {
        var s = session()
        s.index = 3
        s.jump(toDish: "chicken", step: 3)
        #expect(s.pendingReturn == nil)
    }

    /// A timer on the dish you're ALREADY reading still steals your place — this is the
    /// case that has no tab to get back from, so it matters most.
    @Test("a same-dish jump is still worth a way back")
    func sameDishJumpIsRecorded() throws {
        var s = session()
        s.index = 6
        s.jump(toDish: "chicken", step: 1)            // its own step-1 timer fires
        let back = try #require(s.pendingReturn)
        #expect(back.dishId == "chicken")
        #expect(back.step == 6)
    }

    /// Walking back by hand should retire the pill — it would otherwise point at the
    /// spot you're standing on.
    @Test("the offer disappears once you're back under your own steam")
    func selfRescueHidesTheOffer() {
        var s = session()
        s.index = 5
        s.jump(toDish: "salad", step: 1)
        #expect(s.pendingReturn != nil)
        s.activate("chicken")                         // tapped the tab yourself
        #expect(s.pendingReturn == nil)               // already there; nothing to offer
    }

    /// Two timers in a row: the way back is to where the LAST jump took you from, which
    /// is the thing you were most recently reading.
    @Test("a second jump re-points the way back")
    func secondJumpRepointsIt() throws {
        var s = session()
        s.index = 5
        s.jump(toDish: "salad", step: 1)
        s.index = 2                                   // read a little of the salad
        s.jump(toDish: "bread", step: 0)
        let back = try #require(s.pendingReturn)
        #expect(back.dishId == "salad")
        #expect(back.step == 2)
    }
}

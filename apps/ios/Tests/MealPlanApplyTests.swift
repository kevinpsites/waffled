import Foundation
import Testing
@testable import Waffled

/// What "Plan my week/month & build list" actually sends, as data.
///
/// The week-derivation used to live inline in each sheet's `apply()`, which meant the only
/// tests possible were of `GroceryWeeks.weekStarts` in isolation — nothing asserted that an
/// apply *issues* those rebuilds. A code review found the consequence: reverting either
/// sheet to a single `rebuildGroceryFromWeek(weekStart: monthStart)` left every iOS test
/// green, restoring the exact bug this branch set out to fix.
///
/// So the decision is a value now, the way `MealPlanSwap.writes` already does it for drags,
/// and the sheets are dumb executors of it. Mirrors that file's FakeMealServer pattern.
@Suite struct MealPlanApplyTests {

    private func card(_ date: String, _ title: String, recipeId: String? = nil) -> WaffledAPI.PlanCardDTO {
        WaffledAPI.PlanCardDTO(date: date, mealType: "dinner", title: title, recipeId: recipeId,
                               emoji: nil, minutes: 30, servings: 4, note: nil)
    }

    private func rebuilds(_ ops: [MealPlanApply.Op]) -> [String] {
        ops.compactMap { if case let .rebuild(week) = $0 { return week } else { return nil } }
    }
    private func writes(_ ops: [MealPlanApply.Op]) -> [String] {
        ops.compactMap { if case let .set(date, _, _, _) = $0 { return date } else { return nil } }
    }
    private func clears(_ ops: [MealPlanApply.Op]) -> [String] {
        ops.compactMap { if case let .clear(date, _) = $0 { return date } else { return nil } }
    }

    // MARK: month

    /// The original bug, now unrevertable without failing here: a month is 4–6 grocery
    /// weeks and a rebuild covers exactly one, so one call leaves the rest never shopped
    /// for. Wednesdays across September 2026 — four distinct weeks under either cut.
    @Test func aMonthRebuildsEveryWeekItTouches() {
        let ops = MealPlanApply.month(
            suggestions: ["2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23"].map { card($0, "Dish \($0)") },
            plannedDates: [], dirty: [], skipped: [], firstDay: .sunday
        )
        #expect(rebuilds(ops) == ["2026-08-30", "2026-09-06", "2026-09-13", "2026-09-20"])
    }

    /// Ordering is not cosmetic: a rebuild reads the plan back off the server, so one
    /// issued before its night is written builds the list from the OLD plan.
    @Test func everyWriteHappensBeforeAnyRebuild() {
        let ops = MealPlanApply.month(
            suggestions: ["2026-09-02", "2026-09-09"].map { card($0, "Dish \($0)") },
            plannedDates: ["2026-09-16"], dirty: [], skipped: ["2026-09-16"], firstDay: .sunday
        )
        let firstRebuild = ops.firstIndex { if case .rebuild = $0 { return true } else { return false } }
        let lastMutation = ops.lastIndex {
            switch $0 { case .set, .clear: return true; case .rebuild: return false }
        }
        #expect(firstRebuild != nil && lastMutation != nil)
        #expect(lastMutation! < firstRebuild!)
    }

    /// A night the user skipped that WAS planned has to be cleared — and its week rebuilt,
    /// or its shopping stays on the list for a dinner nobody is cooking.
    @Test func aSkippedNightIsClearedAndItsWeekStillRebuilt() {
        let ops = MealPlanApply.month(
            suggestions: [card("2026-09-02", "Kept")],
            plannedDates: ["2026-09-16"], dirty: [], skipped: ["2026-09-16"], firstDay: .sunday
        )
        #expect(clears(ops) == ["2026-09-16"])
        #expect(rebuilds(ops).contains("2026-09-13"))   // the cleared night's week
        #expect(rebuilds(ops).contains("2026-08-30"))   // the written night's week
    }

    /// A night that was already planned and wasn't edited is left alone — rewriting it
    /// would be pointless traffic, and its groceries are already on the list.
    @Test func anUntouchedExistingNightIsNotRewritten() {
        let ops = MealPlanApply.month(
            suggestions: [card("2026-09-02", "Already there"), card("2026-09-09", "New")],
            plannedDates: ["2026-09-02"], dirty: [], skipped: [], firstDay: .sunday
        )
        #expect(writes(ops) == ["2026-09-09"])
        #expect(rebuilds(ops) == ["2026-09-06"])
    }

    /// ...unless it was edited, in which case it is written and its week rebuilt.
    @Test func anEditedExistingNightIsRewritten() {
        let ops = MealPlanApply.month(
            suggestions: [card("2026-09-02", "Changed my mind")],
            plannedDates: ["2026-09-02"], dirty: ["2026-09-02"], skipped: [], firstDay: .sunday
        )
        #expect(writes(ops) == ["2026-09-02"])
        #expect(rebuilds(ops) == ["2026-08-30"])
    }

    /// A recipe-backed card sends its id and no title; a free-text card sends the reverse.
    /// Sending both is what made a picked recipe land as a plain string.
    @Test func aRecipeCardSendsItsIdAndAFreeTextCardItsTitle() {
        let ops = MealPlanApply.month(
            suggestions: [card("2026-09-02", "Tacos", recipeId: "r1"), card("2026-09-03", "Leftovers")],
            plannedDates: [], dirty: [], skipped: [], firstDay: .sunday
        )
        #expect(ops.contains(.set(date: "2026-09-02", mealType: "dinner", recipeId: "r1", title: nil)))
        #expect(ops.contains(.set(date: "2026-09-03", mealType: "dinner", recipeId: nil, title: "Leftovers")))
    }

    // MARK: week

    /// A week of planning is usually one grocery week — but the planner grid snaps to the
    /// DEVICE's first day while the list is keyed by the HOUSEHOLD's, so a Sun–Sat grid can
    /// straddle two household weeks. Both get built.
    @Test func aWeekThatStraddlesTwoHouseholdWeeksBuildsBoth() {
        let ops = MealPlanApply.week(
            suggestions: ["2026-09-06", "2026-09-07"].map { card($0, "Dish \($0)") },
            firstDay: .monday
        )
        #expect(rebuilds(ops) == ["2026-08-31", "2026-09-07"])
    }

    @Test func aWeekWritesEveryDraftedNight() {
        let ops = MealPlanApply.week(
            suggestions: ["2026-09-07", "2026-09-08"].map { card($0, "Dish \($0)") },
            firstDay: .monday
        )
        #expect(writes(ops) == ["2026-09-07", "2026-09-08"])
        #expect(rebuilds(ops) == ["2026-09-07"])
    }

    /// Nothing drafted means nothing sent — not a stray rebuild of the current week.
    @Test func anEmptyPlanSendsNothing() {
        #expect(MealPlanApply.week(suggestions: [], firstDay: .sunday).isEmpty)
        #expect(MealPlanApply.month(suggestions: [], plannedDates: [], dirty: [], skipped: [], firstDay: .sunday).isEmpty)
    }

    /// Unknown preference → cover both cuts, same rule as GroceryWeeks.
    @Test func anUnknownPreferenceCoversBothCuts() {
        let ops = MealPlanApply.week(suggestions: [card("2026-09-09", "Dish")], firstDay: nil)
        #expect(rebuilds(ops) == ["2026-09-06", "2026-09-07"])
    }
}

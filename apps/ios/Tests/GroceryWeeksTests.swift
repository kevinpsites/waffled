import Foundation
import Testing
@testable import Waffled

// Which weeks a meal-plan apply has to rebuild groceries for.
//
// The bug: "Plan my month" rebuilt with `weekStart: monthStart` — ONE call, and a
// rebuild covers exactly one week (weekStart … +6 days). A month is 4–6 weeks, so
// every week after the first was planned but never shopped for.
//
// The trap in the fix: the grocery list is keyed by the HOUSEHOLD's week_start
// preference, not the device's region setting. Grouping a monday household on Sundays
// merges two of its weeks into a single call and leaves another genuinely uncovered —
// which is why this takes the first-day explicitly instead of reusing `Cal.weekStart`
// (that one deliberately follows the device).
@Suite struct GroceryWeeksTests {

    /// August 2026 starts on a Saturday and has 31 days, so a Sunday-keyed month spans
    /// SIX week-starts (Jul 26, Aug 2, 9, 16, 23, 30). One rebuild call covered one.
    @Test func coversEveryWeekOfAMonth() {
        let dates = (1...31).map { String(format: "2026-08-%02d", $0) }
        #expect(GroceryWeeks.weekStarts(dates, firstDay: .sunday)
                == ["2026-07-26", "2026-08-02", "2026-08-09", "2026-08-16", "2026-08-23", "2026-08-30"])
    }

    /// A five-week span yields five rebuilds — one per week, no more.
    @Test func yieldsOneRebuildPerWeek() {
        let dates = ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29"]
        #expect(GroceryWeeks.weekStarts(dates, firstDay: .sunday).count == 5)
    }

    /// Two nights in the same week are one call, not two.
    @Test func doesNotRepeatAWeek() {
        #expect(GroceryWeeks.weekStarts(["2026-08-17", "2026-08-19", "2026-08-22"], firstDay: .sunday)
                == ["2026-08-16"])
    }

    /// A monday household groups on Mondays. 2026-08-16 is a Sunday: it CLOSES the week
    /// that began Monday the 10th, and does not open a new one.
    @Test func groupsAMondayHouseholdOnMondays() {
        #expect(GroceryWeeks.weekStarts(["2026-08-16"], firstDay: .monday) == ["2026-08-10"])
        #expect(GroceryWeeks.weekStarts(["2026-08-17"], firstDay: .monday) == ["2026-08-17"])
        // The same two dates land in ONE week for a sunday household and TWO for a
        // monday one — the exact disagreement that makes the preference load-bearing.
        #expect(GroceryWeeks.weekStarts(["2026-08-16", "2026-08-17"], firstDay: .sunday) == ["2026-08-16"])
        #expect(GroceryWeeks.weekStarts(["2026-08-16", "2026-08-17"], firstDay: .monday)
                == ["2026-08-10", "2026-08-17"])
    }

    /// Cleared nights count too: that shopping has to come back OFF the list, which
    /// only happens if its week is rebuilt.
    @Test func includesClearedDates() {
        let written = ["2026-08-18"]
        let cleared = ["2026-09-03"]
        #expect(GroceryWeeks.weekStarts(written + cleared, firstDay: .sunday)
                == ["2026-08-16", "2026-08-30"])
    }

    /// Garbage in, nothing out — an unparseable date must not become a bogus rebuild.
    @Test func skipsUnparseableDates() {
        #expect(GroceryWeeks.weekStarts(["", "not-a-date", "2026-08-18"], firstDay: .sunday)
                == ["2026-08-16"])
        #expect(GroceryWeeks.weekStarts([], firstDay: .sunday).isEmpty)
    }

    /// "We haven't synced the household's preference yet" is a real state, and it is NOT
    /// the same as "sunday". Assuming sunday for a monday household merges two of its real
    /// weeks into one key; the server snaps that key to its own boundary and rebuilds one
    /// week, so the other never gets built at all. The window is normally one sync tick —
    /// but it is unbounded whenever PowerSync is offline while REST still works, and
    /// planning is REST, so a plan can be applied against a preference that never arrived.
    @Test func coversBothCutsWhenTheHouseholdPreferenceIsUnknown() {
        // Sun + Mon land in ONE sunday week but TWO monday weeks. Not knowing which, both.
        #expect(GroceryWeeks.weekStarts(["2026-09-06", "2026-09-07"], firstDay: nil)
                == ["2026-08-31", "2026-09-06", "2026-09-07"])
        // A midweek date: the two conventions disagree, so both keys are covered.
        #expect(GroceryWeeks.weekStarts(["2026-09-09"], firstDay: nil)
                == ["2026-09-06", "2026-09-07"])
        // And a known preference still produces exactly one key per week — no extra calls
        // once we actually know the answer.
        #expect(GroceryWeeks.weekStarts(["2026-09-09"], firstDay: .monday) == ["2026-09-07"])
    }

    /// Stepping the grocery week has to move from the week the SERVER last returned, not
    /// from a week computed on the device. `Cal.weekStart` honors the DEVICE region's
    /// first-day-of-week while the server snaps to the HOUSEHOLD's, so on a Sunday-locale
    /// phone in a monday household a locally-computed "next week" snapped straight back to
    /// the week already on screen — and "last week" skipped one, leaving it unreachable.
    @Test func stepsAWeekFromTheServersOwnAnswer() {
        #expect(GroceryWeeks.step(from: "2026-08-17", weeks: 1) == "2026-08-24")
        #expect(GroceryWeeks.step(from: "2026-08-17", weeks: -1) == "2026-08-10")
        // Across a month boundary, and a year one.
        #expect(GroceryWeeks.step(from: "2026-09-28", weeks: 1) == "2026-10-05")
        #expect(GroceryWeeks.step(from: "2027-01-04", weeks: -1) == "2026-12-28")
        // Whatever the server said is carried forward verbatim — a monday key steps to a
        // monday key, a sunday key to a sunday key. The helper never re-decides the cut.
        #expect(GroceryWeeks.step(from: "2026-08-16", weeks: 1) == "2026-08-23")
        // Nothing to step from yet (board not loaded) is not a step to nowhere.
        #expect(GroceryWeeks.step(from: "", weeks: 1) == nil)
        #expect(GroceryWeeks.step(from: "not-a-date", weeks: 1) == nil)
    }

    /// The household preference arrives as free text off the synced `households` row.
    @Test func readsThePreferenceLeniently() {
        #expect(HouseholdWeekStart(raw: "monday") == .monday)
        #expect(HouseholdWeekStart(raw: "Monday") == .monday)
        #expect(HouseholdWeekStart(raw: "sunday") == .sunday)
        // Anything else — including nothing synced yet — is the server default.
        #expect(HouseholdWeekStart(raw: nil) == .sunday)
        #expect(HouseholdWeekStart(raw: "tuesday") == .sunday)
    }
}

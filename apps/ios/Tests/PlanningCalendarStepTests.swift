import Foundation
import Testing
@testable import Waffled

// Weekly Planning · step 2 "Calendar" — the week's arithmetic and the little state the step
// keeps. There is no network in this step, so what is worth pinning is: the seven days
// really are the SERVER'S week plus 0…6 with no device timezone near them, the one line
// under the week range says the true thing about what is open, and the crumb never erases
// what it found.

@MainActor
@Suite struct PlanningCalendarStepTests {

    // MARK: - The seven days

    @Test func theWeekIsTheServersWeekPlusZeroThroughSix() {
        let days = PlanningWeekDays.days(weekStart: "2026-09-06", todayKey: "2026-09-09")

        #expect(days.count == 7)
        #expect(days.map(\.key) == [
            "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09",
            "2026-09-10", "2026-09-11", "2026-09-12",
        ])
        #expect(days.first?.dow == "SUN")
        #expect(days.first?.full == "Sunday")
        #expect(days.first?.date == "Sep 6")
        #expect(days.last?.full == "Saturday")
        #expect(days.filter(\.isToday).map(\.key) == ["2026-09-09"])
    }

    @Test func todayOutsideThePlannedWeekMarksNoDay() {
        let days = PlanningWeekDays.days(weekStart: "2026-09-06", todayKey: "2026-09-05")
        #expect(days.allSatisfy { !$0.isToday })
    }

    /// A week start is a calendar LABEL, not an instant: the arithmetic is UTC string
    /// arithmetic precisely so a DST boundary or a negative device offset can't shift the
    /// week by a day.
    @Test func daysStepAcrossDstAndTheYearWithoutSlipping() {
        // US spring-forward is 2026-03-08.
        #expect(PlanningWeekDays.addDays("2026-03-07", 1) == "2026-03-08")
        #expect(PlanningWeekDays.addDays("2026-03-07", 2) == "2026-03-09")
        #expect(PlanningWeekDays.addDays("2026-12-28", 6) == "2027-01-03")
        // A day-of-week read off the string, with no calendar in sight.
        #expect(PlanningWeekDays.dayOfWeek("2026-09-06") == 0)
        #expect(PlanningWeekDays.dayOfWeek("2026-09-12") == 6)
    }

    @Test func garbageDatesFallThroughRatherThanCrashing() {
        #expect(PlanningWeekDays.addDays("not-a-day", 3) == "not-a-day")
        #expect(PlanningWeekDays.monthDay("nope") == "nope")
        #expect(PlanningWeekDays.weekRangeLabel("") == "")
    }

    // MARK: - The header

    @Test func theWeekRangeNamesTheSecondMonthOnlyWhenItStraddlesOne() {
        #expect(PlanningWeekDays.weekRangeLabel("2026-09-06") == "Sep 6 – 12")
        #expect(PlanningWeekDays.weekRangeLabel("2026-09-27") == "Sep 27 – Oct 3")
    }

    @Test func namesReadsLikeSomebodySayingThem() {
        #expect(PlanningWeekDays.names([]) == "")
        #expect(PlanningWeekDays.names(["Sunday"]) == "Sunday")
        #expect(PlanningWeekDays.names(["Sunday", "Thursday"]) == "Sunday and Thursday")
        #expect(
            PlanningWeekDays.names(["Sunday", "Thursday", "Friday"])
                == "Sunday, Thursday and Friday")
    }

    /// THE OPEN DAYS ARE THE POINT OF THE STEP — a week with room in it is the thing a
    /// family can still decide about — so they are NAMED, never counted.
    @Test func theSummaryNamesWhatIsStillOpen() {
        #expect(
            PlanningWeekDays.summary(total: 7, openDays: ["Sunday", "Thursday"])
                == "7 events · Sunday and Thursday are still open")
        #expect(
            PlanningWeekDays.summary(total: 1, openDays: ["Friday"])
                == "1 event · Friday is still open")
        #expect(
            PlanningWeekDays.summary(total: 28, openDays: [])
                == "28 events · every day has something")
    }

    @Test func anEmptyWeekSaysSoBothWays() {
        let all = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        #expect(
            PlanningWeekDays.summary(total: 0, openDays: all)
                == "Nothing on the week yet · every day is still open")
    }

    // MARK: - The crumb
    //
    // WHAT STEP 1 ROUTED HERE IS NOT THIS STEP'S STATE. One box holds both a routed loose
    // end and a parked note tagged for this step, and the rule for what goes in it is
    // asserted against `PlanningRouteSeed.sentHere` in `PlanningSentHereTests`
    // (PlanningLooseEndsTests.swift).

    @Test func addingAnEventIsOnlyEverACount() {
        let model = PlanningCalendarModel()
        #expect(model.decisionData == ["added": .int(0)])

        model.recordEventAdded()
        model.recordEventAdded()

        // A COUNT, and nothing about the events themselves: the recap reads through to the
        // calendar, so copying a title here would give the two something to disagree about.
        #expect(model.decisionData == ["added": .int(2)])
    }

    /// THE CRUMB REPLACES THE STEP'S DATA when the step is answered — and it stays a pure
    /// count because everything else this step touches lives in the module that owns it. (A
    /// step whose OWN row carries a mid-step write — Goals, Kids, Connection — must mirror
    /// it back, or the affirmative wipes it.)
    @Test func theCrumbStaysACountBecauseNothingElseLivesOnThisStepsRow() {
        let model = PlanningCalendarModel()
        model.recordEventAdded()

        #expect(model.decisionData == ["added": .int(1)])
        #expect(model.decisionData["routes"] == nil)
    }
}

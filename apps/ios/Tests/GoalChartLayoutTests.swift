import XCTest
import SwiftUI
@testable import Waffled

/// A family goal ("750 hours outside" by default) with a log every day from Jul 7 to Sep 14 2026.
enum GoalChartFixture {
    static let today = "2026-09-14"

    static func goal(type: String = "total", target: Double = 750) throws -> WaffledAPI.GoalDetail {
        let json = """
        {"id":"g-outside","goalListId":null,"title":"750 Hours Outside","emoji":null,"category":"physical",
         "goalType":"\(type)","unit":"hours","target":\(target),"trackingMode":"shared_total","participantMode":"count_once",
         "targetBasis":"family","habitPeriod":null,"habitTargetPerPeriod":null,"isFeatured":false,"isSpotlight":false,
         "hasRewards":false,"totalProgress":563,"periodDone":null,"stepTotal":0,"stepDone":0,"loggedTodayBy":[],
         "streakDays":81,"deadline":"2026-12-31","createdAt":"2026-07-07T12:00:00Z","thisWeek":0.33,
         "autoFromCalendar":false,"healthMetric":null,"healthDailyTarget":null,
         "participants":[
           {"personId":"p1","name":"Kelly","avatarEmoji":"🐻","colorHex":"#E8836B","target":null,"progress":140},
           {"personId":"p2","name":"Sam","avatarEmoji":"🐼","colorHex":"#7BB9A3","target":null,"progress":140},
           {"personId":"p3","name":"Riley","avatarEmoji":"🦄","colorHex":"#A88FD6","target":null,"progress":140},
           {"personId":"p4","name":"Max","avatarEmoji":"🐵","colorHex":"#E8B84B","target":null,"progress":140}],
         "milestones":[],"steps":[],"recent":[]}
        """
        return try JSONDecoder().decode(WaffledAPI.GoalDetail.self, from: Data(json.utf8))
    }

    static func context(type: String = "total", target: Double = 750) throws -> GoalDataContext {
        let goal = try goal(type: type, target: target)
        var days: [DayEntry] = []
        var key = "2026-07-07"
        var i = 0
        while key <= today {
            let total = [1.33, 0.08, 0.5, 5.17, 3.5, 1, 4.5, 2, 0.5, 8.5][i % 10]
            let members = ["p1", "p2", "p3", "p4"].prefix(1 + i % 4)
            days.append(DayEntry(dateKey: key, total: total, perMember: Dictionary(uniqueKeysWithValues: members.map { ($0, total) })))
            key = GoalDateKey.addDays(key, 1)
            i += 1
        }
        let stats = GoalStats.compute(today: today, startDate: "2026-07-07", endDate: "2026-12-31", target: target, days: days)
        return GoalDataContext(
            goal: goal, stats: stats,
            personMap: Dictionary(uniqueKeysWithValues: goal.participants.map { ($0.personId, $0) }),
            onDayTap: { _ in }, onMonthTap: { _, _ in }, firstDay: .sunday)
    }
}

/// The heatmaps' first layout pass is the one the goal-detail card sizes itself from on
/// iPad, so the grid must report its real height up front, not after a later measurement.
@MainActor
final class GoalChartLayoutTests: XCTestCase {
    private static let cardWidth: CGFloat = 562 // iPad 13" landscape, left detail column

    private func fittingHeight(_ view: some View) -> CGFloat {
        let host = UIHostingController(rootView: view.frame(width: Self.cardWidth))
        return host.sizeThatFits(in: CGSize(width: Self.cardWidth, height: .greatestFiniteMagnitude)).height
    }

    func testMonthGridReportsItsFullHeightOnTheFirstPass() throws {
        let ctx = try GoalChartFixture.context()
        // September 2026 from Sunday: 2 lead blanks + 30 days = 5 rows of square cells.
        let cell = (Self.cardWidth - 6 * 6) / 7
        let gridHeight = 5 * cell + 4 * 6
        XCTAssertGreaterThan(fittingHeight(MonthHeatmapView(ctx: ctx)), gridHeight)
    }

    func testWeekStripReportsItsFullHeightOnTheFirstPass() throws {
        let ctx = try GoalChartFixture.context()
        let cell = (Self.cardWidth - 6 * 6) / 7
        // Header + day labels + weekly total add ~100pt around one row of square cells.
        XCTAssertGreaterThan(fittingHeight(WeekHeatmapView(ctx: ctx)), cell + 80)
    }
}

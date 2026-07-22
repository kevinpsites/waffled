import SwiftUI

/// Habit's signature view — a consistency dot-calendar. Did you show up? A month
/// of hit/miss dots plus streak stats. (WeekHeatmapView is the compact "7-dot
/// week strip" variant, offered alongside this for habit goals.)
struct ConsistencyCalendarView: View {
    let ctx: GoalDataContext
    var headerRight: AnyView?

    private static let columns = Array(repeating: GridItem(.flexible(), spacing: 5), count: 7)

    private var todayDate: Date { GoalDateKey.parse(ctx.stats.today) }
    private var year: Int { GoalDateKey.calendar.component(.year, from: todayDate) }
    private var month: Int { GoalDateKey.calendar.component(.month, from: todayDate) - 1 }
    private var daysInMonth: Int { GoalDateKey.calendar.range(of: .day, in: .month, for: todayDate)!.count }
    private var lead: Int { GoalDateKey.calendar.component(.weekday, from: GoalDateKey.calendar.date(from: DateComponents(year: year, month: month + 1, day: 1))!) - 1 }
    private var dayOfMonth: Int { GoalDateKey.calendar.component(.day, from: todayDate) }

    private struct DayInfo { let day: Int; let dateKey: String; let future: Bool; let hit: Bool }
    private var dayInfos: [DayInfo] {
        (1...daysInMonth).map { day in
            let dateKey = GoalDateKey.toKey(GoalDateKey.calendar.date(from: DateComponents(year: year, month: month + 1, day: day))!)
            let future = dateKey > ctx.stats.today
            let hit = !future && ctx.stats.dayEntry(dateKey).total > 0
            return DayInfo(day: day, dateKey: dateKey, future: future, hit: hit)
        }
    }
    private var hitsThisMonth: Int { dayInfos.filter(\.hit).count }
    private var pct: Int { Int((Double(hitsThisMonth) / Double(dayOfMonth)) * 100) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(GoalViewFmt.monthName(month)).font(WF.serif(17, .semibold)).foregroundStyle(WF.ink)
                    Text(ctx.goal.title).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                Spacer()
                headerRight
            }

            LazyVGrid(columns: Self.columns, spacing: 5) {
                ForEach(0..<lead, id: \.self) { _ in Color.clear.frame(height: 1) }
                ForEach(dayInfos, id: \.dateKey) { info in
                    Button { ctx.onDayTap(info.dateKey) } label: {
                        Circle()
                            .fill(info.hit ? WF.success : (info.future ? Color.clear : WF.panel))
                            .overlay(info.future ? Circle().strokeBorder(WF.hair, style: StrokeStyle(lineWidth: 1, dash: [3, 3])) : nil)
                            .aspectRatio(1, contentMode: .fit)
                    }
                    .buttonStyle(.plain)
                    .disabled(info.future)
                }
            }

            HStack(spacing: 24) {
                statColumn("🔥 \(ctx.stats.currentStreak)", "current", WF.primary)
                statColumn("\(ctx.stats.longestStreak)", "longest", WF.ink)
                statColumn("\(pct)%", "this month", WF.ink)
                Spacer()
            }
        }
    }

    private func statColumn(_ value: String, _ label: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value).font(WF.serif(20, .semibold)).foregroundStyle(color)
            Text(label).font(.system(size: 11, weight: .heavy)).foregroundStyle(WF.ink3)
        }
    }
}

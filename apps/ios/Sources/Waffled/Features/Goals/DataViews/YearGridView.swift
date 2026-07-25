import SwiftUI

/// Year — Contribution grid (GitHub-style). Consistency at a glance for the whole
/// current calendar year so far: every day Jan 1 → today gets a square, even the
/// ones before a mid-year-created goal existed (those just sit empty). `viewStart`
/// (the goal's own start) scopes only the "% of days" denominator.
struct YearGridView: View {
    let ctx: GoalDataContext
    var headerRight: AnyView?

    private static let cell: CGFloat = 13
    private static let gap: CGFloat = 3.5
    private static let labelRowH: CGFloat = 16
    private static let monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    private var today: String { ctx.stats.today }
    private var jan1Key: String {
        GoalDateKey.toKey(GoalDateKey.calendar.date(from: DateComponents(year: GoalDateKey.calendar.component(.year, from: GoalDateKey.parse(today)), month: 1, day: 1))!)
    }
    private var viewStart: String { ctx.stats.startDate > jan1Key ? ctx.stats.startDate : jan1Key }
    private var startSun: String {
        let weekday = GoalDateKey.calendar.component(.weekday, from: GoalDateKey.parse(jan1Key)) // 1 = Sunday
        return GoalDateKey.addDays(jan1Key, -(weekday - 1))
    }
    private var weeks: [[String]] {
        var result: [[String]] = []
        var cursor = startSun
        while cursor <= today {
            result.append((0..<7).map { GoalDateKey.addDays(cursor, $0) })
            cursor = GoalDateKey.addDays(cursor, 7)
        }
        return result
    }
    private var yearMax: Double { max(1, ctx.stats.yearMax) }
    // ctx.stats.activeDays is a lifetime count (no lower date bound on the query
    // behind it), but this grid only spans the current calendar year — using the
    // lifetime count against an in-year day span could push "% of days" past
    // 100% and made the header's "N active days" describe a bigger number than
    // what's actually plotted here.
    private var activeDaysInViewCount: Int {
        weeks.flatMap { $0 }.filter { $0 >= viewStart && $0 <= today }.filter { ctx.stats.dayEntry($0).total > 0 }.count
    }
    private var activeDaysInView: Int { max(1, GoalDateKey.diffDays(today, viewStart) + 1) }
    private var pct: Int { Int((Double(activeDaysInViewCount) / Double(activeDaysInView)) * 100) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("The whole year").font(WF.serif(17, .semibold)).foregroundStyle(WF.ink)
                    Text("\(activeDaysInViewCount) active days · every square is a day")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                Spacer()
                headerRight
            }

            // Cells before the goal's own start date are drawn as nothing (by
            // design — see gridCanvas), so a goal that didn't start Jan 1 would
            // default-open on a blank leading stretch of the scroll view unless
            // we jump to the trailing (most-recent) edge on appear.
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    gridCanvas.id("grid")
                }
                .onAppear { proxy.scrollTo("grid", anchor: .trailing) }
            }

            HStack(spacing: 20) {
                statColumn("🔥 \(ctx.stats.currentStreak)", "current streak", WF.primary)
                statColumn("\(ctx.stats.longestStreak)", "longest streak", WF.ink)
                statColumn("\(activeDaysInViewCount)", "active days", WF.ink)
                statColumn("\(pct)%", "of days", WF.ink)
                Spacer()
            }
        }
    }

    private func statColumn(_ value: String, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 4) {
            Text(value).font(WF.serif(20, .semibold)).foregroundStyle(color)
            Text(label).font(.system(size: 11, weight: .heavy)).foregroundStyle(WF.ink3)
        }
    }

    @ViewBuilder private var gridCanvas: some View {
        let ws = weeks
        let gw = CGFloat(ws.count) * (Self.cell + Self.gap)
        let gh = Self.labelRowH + 7 * (Self.cell + Self.gap)
        Canvas { context, _ in
            var lastMonth = -1
            for (ci, col) in ws.enumerated() {
                let d = GoalDateKey.parse(col[0])
                let m = GoalDateKey.calendar.component(.month, from: d) - 1
                let day = GoalDateKey.calendar.component(.day, from: d)
                if m != lastMonth, day <= 7 {
                    context.draw(
                        Text(Self.monthNames[m]).font(.system(size: 10, weight: .bold)).foregroundStyle(WF.ink3),
                        at: CGPoint(x: CGFloat(ci) * (Self.cell + Self.gap) + Self.cell / 2, y: 6)
                    )
                    lastMonth = m
                }
            }
            for (ci, col) in ws.enumerated() {
                for (ri, dateKey) in col.enumerated() {
                    // Paint the whole year so far (Jan 1 → today); pre-goal days sit empty.
                    guard dateKey >= jan1Key, dateKey <= today else { continue }
                    let total = ctx.stats.dayEntry(dateKey).total
                    let x = CGFloat(ci) * (Self.cell + Self.gap)
                    let y = Self.labelRowH + CGFloat(ri) * (Self.cell + Self.gap)
                    let color: Color
                    if total > 0 {
                        let (r, g, b) = GoalStats.heat(total / yearMax)
                        color = Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
                    } else {
                        color = WF.panel
                    }
                    let path = Path(roundedRect: CGRect(x: x, y: y, width: Self.cell, height: Self.cell), cornerRadius: 3)
                    context.fill(path, with: .color(color))
                }
            }
        }
        .frame(width: gw, height: gh)
        .gesture(
            SpatialTapGesture().onEnded { value in
                let ci = Int(value.location.x / (Self.cell + Self.gap))
                let ri = Int((value.location.y - Self.labelRowH) / (Self.cell + Self.gap))
                guard ci >= 0, ci < ws.count, ri >= 0, ri < 7 else { return }
                let dateKey = ws[ci][ri]
                guard dateKey >= jan1Key, dateKey <= today else { return }
                ctx.onDayTap(dateKey)
            }
        )
    }
}

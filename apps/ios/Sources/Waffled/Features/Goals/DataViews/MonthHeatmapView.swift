import SwiftUI

/// Month — Calendar heatmap. A familiar month grid where shade = hours logged
/// that day. Navigable back/forth, clamped so you can't page past the current month.
struct MonthHeatmapView: View {
    let ctx: GoalDataContext
    var headerRight: AnyView?
    @State private var monthOffset = 0
    // See WeekHeatmapView's identical fix: aspectRatio(1, .fit/.fill) can't reliably
    // square a grid cell when nothing else pins its height, so measure the grid's
    // actual width and set an explicit width==height frame instead.
    @State private var gridWidth: CGFloat = 280
    private static let gridSpacing: CGFloat = 6
    private var cellSize: CGFloat { max(24, (gridWidth - Self.gridSpacing * 6) / 7) }

    private static let weekdayHeads = ["S", "M", "T", "W", "T", "F", "S"]
    private static let heatStops: [Double] = [0.12, 0.35, 0.6, 0.85, 1]
    private static let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 7)

    private var todayDate: Date { GoalDateKey.parse(ctx.stats.today) }
    private var shown: Date {
        let c = GoalDateKey.calendar.dateComponents([.year, .month], from: todayDate)
        return GoalDateKey.calendar.date(from: DateComponents(year: c.year!, month: c.month! + monthOffset, day: 1))!
    }
    private var year: Int { GoalDateKey.calendar.component(.year, from: shown) }
    private var month: Int { GoalDateKey.calendar.component(.month, from: shown) - 1 } // 0-indexed
    private var daysInMonth: Int { GoalDateKey.calendar.range(of: .day, in: .month, for: shown)!.count }
    private var lead: Int { GoalDateKey.calendar.component(.weekday, from: shown) - 1 }
    private var canGoForward: Bool { monthOffset < 0 }

    private struct DayInfo { let day: Int; let dateKey: String; let future: Bool; let total: Double; let perMember: [String: Double] }

    private var dayInfos: [DayInfo] {
        (1...daysInMonth).map { day in
            let dateKey = GoalDateKey.toKey(GoalDateKey.calendar.date(from: DateComponents(year: year, month: month + 1, day: day))!)
            let future = dateKey > ctx.stats.today
            let entry = ctx.stats.dayEntry(dateKey)
            return DayInfo(day: day, dateKey: dateKey, future: future, total: entry.total, perMember: entry.perMember)
        }
    }
    private var monthTotal: Double { dayInfos.filter { !$0.future }.reduce(0) { $0 + $1.total } }
    private var monthMax: Double { max(1, dayInfos.filter { !$0.future }.map(\.total).max() ?? 1) }
    private var bestDay: DayInfo? { dayInfos.filter { !$0.future && $0.total > 0 }.max { $0.total < $1.total } }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 10) {
                Button { monthOffset -= 1 } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.plain).foregroundStyle(WF.ink2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(year == GoalDateKey.calendar.component(.year, from: todayDate) ? GoalViewFmt.monthName(month) : "\(GoalViewFmt.monthName(month)) \(year)")
                        .font(WF.serif(17, .semibold)).foregroundStyle(WF.ink)
                    Text("\(GoalViewFmt.num(monthTotal))\(ctx.goal.unit.map { " \($0)" } ?? "") this month")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 8)
                Button { monthOffset = min(0, monthOffset + 1) } label: { Image(systemName: "chevron.right") }
                    .buttonStyle(.plain).foregroundStyle(canGoForward ? WF.ink2 : WF.ink3.opacity(0.4))
                    .disabled(!canGoForward)
                headerRight
            }

            LazyVGrid(columns: Self.columns, spacing: 6) {
                ForEach(Self.weekdayHeads.indices, id: \.self) { i in
                    Text(Self.weekdayHeads[i]).font(.system(size: 11, weight: .heavy)).foregroundStyle(WF.ink3)
                        .frame(maxWidth: .infinity)
                }
            }
            LazyVGrid(columns: Self.columns, spacing: 6) {
                ForEach(0..<lead, id: \.self) { _ in Color.clear.frame(height: 1) }
                ForEach(dayInfos, id: \.dateKey) { info in
                    let intensity = info.total > 0 ? info.total / monthMax : 0
                    let (r, g, b) = GoalStats.heat(intensity)
                    let dark = intensity > GoalStats.heatDarkThreshold
                    let isToday = info.dateKey == ctx.stats.today
                    Button { ctx.onDayTap(info.dateKey) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            // Today: a red circle around the day number, so you can see where
                            // you are in the month at a glance (mirrors the week view).
                            Text("\(info.day)").font(.system(size: 11.5, weight: .heavy))
                                .foregroundStyle(isToday ? WF.danger : (info.future ? WF.ink3 : (dark ? .white : WF.ink2)))
                                .frame(minWidth: isToday ? 16 : nil, minHeight: isToday ? 16 : nil)
                                .overlay(isToday ? Circle().stroke(WF.danger, lineWidth: 1.5) : nil)
                            if !info.future, info.total > 0 {
                                Text(GoalViewFmt.num(info.total)).font(WF.serif(12, .semibold))
                                    .foregroundStyle(dark ? .white : WF.ink)
                            }
                            Spacer(minLength: 0)
                            if !info.perMember.isEmpty {
                                HStack(spacing: 2) {
                                    ForEach(Array(info.perMember.keys), id: \.self) { pid in
                                        Circle().fill(dark ? Color.white.opacity(0.9) : (ctx.personMap[pid].flatMap { Color(hexString: $0.colorHex) } ?? WF.ink3))
                                            .frame(width: 4, height: 4)
                                    }
                                }
                            }
                        }
                        .padding(5)
                        .frame(width: cellSize, height: cellSize)
                        .background(info.future ? Color.clear : (info.total > 0 ? Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255) : WF.panel))
                        .overlay(info.future ? RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(WF.hair, style: StrokeStyle(lineWidth: 1, dash: [3, 3])) : nil)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(info.future)
                }
            }
            .background(
                GeometryReader { geo in
                    Color.clear
                        .onAppear { gridWidth = geo.size.width }
                        .onChange(of: geo.size.width) { _, newWidth in gridWidth = newWidth }
                }
            )

            HStack(spacing: 10) {
                Text("Less").font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                HStack(spacing: 4) {
                    ForEach(Self.heatStops, id: \.self) { t in
                        let (r, g, b) = GoalStats.heat(t)
                        RoundedRectangle(cornerRadius: 5).fill(Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)).frame(width: 16, height: 16)
                    }
                }
                Text("More").font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                Spacer()
                if let bestDay {
                    Text("Best day · ").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
                        + Text("\(GoalViewFmt.num(bestDay.total))\(ctx.goal.unit.map { " \($0)" } ?? "")").font(WF.serif(12, .semibold)).foregroundStyle(WF.ink)
                }
            }
            .padding(.top, 8)
        }
        // Swipe to page months (same forward-clamp as the chevrons). minimumDistance
        // keeps per-cell taps working; the horizontal-dominance check ignores scrolls.
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    let dx = value.translation.width
                    guard abs(dx) > 44, abs(dx) > abs(value.translation.height) else { return }
                    withAnimation(.easeOut(duration: 0.2)) {
                        if dx < 0 { monthOffset = min(0, monthOffset + 1) }  // drag left → later month
                        else { monthOffset -= 1 }                             // drag right → earlier month
                    }
                }
        )
    }
}

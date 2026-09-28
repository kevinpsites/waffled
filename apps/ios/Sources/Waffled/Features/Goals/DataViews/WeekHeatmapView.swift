import SwiftUI

/// Week — Heatmap strip (Treatment A, the chosen week treatment). Only what was
/// done is drawn; rest days sit light and quiet — never an "empty bar = failure".
/// Navigable back/forth — clamped so you can't page past the current week.
struct WeekHeatmapView: View {
    let ctx: GoalDataContext
    @State private var weekOffset = 0
    // Same flexible 7-column grid and spacing as MonthHeatmapView, so the two views'
    // cells come out identical at the same card width.
    private static let cellSpacing: CGFloat = 6
    private static let columns = Array(repeating: GridItem(.flexible(), spacing: cellSpacing), count: 7)

    private var today: String { ctx.stats.today }
    // Anchor to the fixed calendar week (Sun–Sat) containing today (± weekOffset
    // weeks), NOT a rolling 7-day window ending today.
    private var weekStart: String { GoalDateKey.startOfWeek(GoalDateKey.addDays(today, weekOffset * 7), ctx.firstDay) }
    private var weekEnd: String { GoalDateKey.addDays(weekStart, 6) }
    private var weekKeys: [String] { (0..<7).map { GoalDateKey.addDays(weekStart, $0) } }
    private var canGoForward: Bool { weekOffset < 0 }

    private var weekMax: Double {
        max(1, weekKeys.map { ctx.stats.dayEntry($0).total }.max() ?? 1)
    }
    private var weekTotal: Double {
        weekKeys.reduce(0) { $0 + ctx.stats.dayEntry($1).total }
    }
    private var prevWeekTotal: Double {
        (0..<7).map { GoalDateKey.addDays(weekStart, $0 - 7) }.reduce(0) { $0 + ctx.stats.dayEntry($1).total }
    }
    private var delta: Double { ((weekTotal - prevWeekTotal) * 10).rounded() / 10 }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 10) {
                Button { weekOffset -= 1 } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.plain).foregroundStyle(WF.ink2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(weekOffset == 0
                         ? "This week"
                         : "Week of \(GoalViewFmt.monthDay(weekKeys[0])) – \(GoalViewFmt.monthDay(weekEnd))")
                        .font(WF.serif(17, .semibold)).foregroundStyle(WF.ink)
                    // For the current week the title is just "This week", so the date range
                    // lives in the subtitle; for other weeks the title already carries the
                    // range, so the subtitle is just the tagline (no duplicated dates).
                    Text(weekOffset == 0
                         ? "\(GoalViewFmt.monthDay(weekKeys[0])) – \(GoalViewFmt.monthDay(weekEnd)) · the rhythm of your week"
                         : "the rhythm of your week")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 8)
                Button { weekOffset = min(0, weekOffset + 1) } label: { Image(systemName: "chevron.right") }
                    .buttonStyle(.plain).foregroundStyle(canGoForward ? WF.ink2 : WF.ink3.opacity(0.4))
                    .disabled(!canGoForward)
            }

            LazyVGrid(columns: Self.columns, spacing: Self.cellSpacing) {
                ForEach(weekKeys, id: \.self) { dateKey in
                    let entry = ctx.stats.dayEntry(dateKey)
                    let intensity = entry.total > 0 ? entry.total / weekMax : 0
                    let (r, g, b) = GoalStats.heat(intensity)
                    let dark = intensity > GoalStats.heatDarkThreshold
                    let isToday = dateKey == today
                    Button { ctx.onDayTap(dateKey) } label: {
                        VStack(spacing: 6) {
                            // Squared off the column's own width — see MonthHeatmapView.
                            Color.clear
                                .aspectRatio(1, contentMode: .fit)
                                .overlay {
                                    VStack(spacing: 3) {
                                        Text(entry.total > 0 ? GoalViewFmt.num(entry.total) : "·")
                                            .font(WF.serif(15, .semibold))
                                            .foregroundStyle(dark ? .white : (entry.total > 0 ? WF.ink : WF.ink3))
                                        if !entry.perMember.isEmpty {
                                            HStack(spacing: 2) {
                                                ForEach(Array(entry.perMember.keys), id: \.self) { pid in
                                                    Circle()
                                                        .fill(dark ? Color.white.opacity(0.9) : (ctx.personMap[pid].flatMap { Color(hexString: $0.colorHex) } ?? WF.ink3))
                                                        .frame(width: 5, height: 5)
                                                }
                                            }
                                        }
                                    }
                                }
                                .background(entry.total > 0 ? Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255) : WF.panel)
                                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                            Text(GoalViewFmt.weekdayDay(dateKey))
                                .font(.system(size: 11, weight: .heavy))
                                .foregroundStyle(isToday ? WF.primary : WF.ink3)
                                .lineLimit(1).minimumScaleFactor(0.8)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }

            (Text(GoalViewFmt.num(weekTotal)).font(WF.serif(15, .semibold)).foregroundStyle(WF.ink)
                + Text(ctx.goal.unit.map { " \($0)" } ?? "").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
                + Text(" this week").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
                + (prevWeekTotal > 0 || weekTotal > 0
                    ? Text(" · \(delta >= 0 ? "+" : "")\(GoalViewFmt.num(delta)) vs last")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(delta >= 0 ? WF.success : WF.danger)
                    : Text("")))
        }
        // Swipe to page weeks (same forward-clamp as the chevrons). A minimumDistance
        // keeps per-cell taps working — a tap moves < the threshold, so the drag never
        // claims it; the horizontal-dominance check ignores vertical scroll drags.
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    let dx = value.translation.width
                    guard abs(dx) > 44, abs(dx) > abs(value.translation.height) else { return }
                    withAnimation(.easeOut(duration: 0.2)) {
                        if dx < 0 { weekOffset = min(0, weekOffset + 1) }  // drag left → later week
                        else { weekOffset -= 1 }                            // drag right → earlier week
                    }
                }
        )
    }
}

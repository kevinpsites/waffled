import SwiftUI

/// Week — Heatmap strip (Treatment A, the chosen week treatment). Only what was
/// done is drawn; rest days sit light and quiet — never an "empty bar = failure".
/// Navigable back/forth — clamped so you can't page past the current week.
struct WeekHeatmapView: View {
    let ctx: GoalDataContext
    var headerRight: AnyView?
    @State private var weekOffset = 0
    // `aspectRatio(1, contentMode:)` can't reliably square a cell here: it needs a
    // real proposed height to compare against, and this row's height is otherwise
    // just "whatever the content needs" — so .fit *and* .fill both collapsed to
    // content size (pill-shaped for a bare "·", oversized for a wrapped number).
    // A plain HStack has the same problem one level up: once each cell has an
    // explicit fixed frame instead of `maxWidth: .infinity`, the HStack itself
    // stops requesting the parent's full width and just self-sizes to content,
    // so a background GeometryReader measuring it gets stuck at whatever narrow
    // size it started from. A LazyVGrid of flexible columns (matching
    // MonthHeatmapView's identical, verified-working cell sizing) doesn't have
    // that trap: flexible columns always claim the parent's full width
    // regardless of what size its children ask for.
    @State private var gridWidth: CGFloat = 280
    // Spacing and floor match MonthHeatmapView's exactly (not just "close") — with
    // both views measuring the same card width via this identical formula, their
    // cells come out pixel-identical instead of just similar. A higher floor here
    // than Month's would also let Week force an overflow past the card's padding
    // at narrower widths where Month's lower floor still fits without one.
    private static let cellSpacing: CGFloat = 6
    private static let columns = Array(repeating: GridItem(.flexible(), spacing: cellSpacing), count: 7)
    private var cellSize: CGFloat { max(24, (gridWidth - Self.cellSpacing * 6) / 7) }

    private var today: String { ctx.stats.today }
    // Anchor to the fixed calendar week (Sun–Sat) containing today (± weekOffset
    // weeks), NOT a rolling 7-day window ending today.
    private var weekStart: String { GoalDateKey.startOfWeek(GoalDateKey.addDays(today, weekOffset * 7)) }
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
                    Text(weekOffset == 0 ? "This week" : "That week")
                        .font(WF.serif(17, .semibold)).foregroundStyle(WF.ink)
                    Text("\(GoalViewFmt.monthDay(weekKeys[0])) – \(GoalViewFmt.monthDay(weekEnd)) · the rhythm of your week")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 8)
                Button { weekOffset = min(0, weekOffset + 1) } label: { Image(systemName: "chevron.right") }
                    .buttonStyle(.plain).foregroundStyle(canGoForward ? WF.ink2 : WF.ink3.opacity(0.4))
                    .disabled(!canGoForward)
                headerRight
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
                            .frame(width: cellSize, height: cellSize)
                            .background(entry.total > 0 ? Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255) : WF.panel)
                            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                            Text(GoalViewFmt.weekdayDay(dateKey))
                                .font(.system(size: 11, weight: .heavy))
                                .foregroundStyle(isToday ? WF.primary : WF.ink3)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(
                GeometryReader { geo in
                    Color.clear
                        .onAppear { gridWidth = geo.size.width }
                        .onChange(of: geo.size.width) { _, newWidth in gridWidth = newWidth }
                }
            )

            (Text(GoalViewFmt.num(weekTotal)).font(WF.serif(15, .semibold)).foregroundStyle(WF.ink)
                + Text(ctx.goal.unit.map { " \($0)" } ?? "").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
                + Text(" this week").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
                + (prevWeekTotal > 0 || weekTotal > 0
                    ? Text(" · \(delta >= 0 ? "+" : "")\(GoalViewFmt.num(delta)) vs last")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(delta >= 0 ? WF.success : WF.danger)
                    : Text("")))
        }
    }
}

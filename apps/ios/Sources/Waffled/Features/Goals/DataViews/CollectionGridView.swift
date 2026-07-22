import SwiftUI

/// Count's signature view — a collection grid. Progress reads as "the shelf
/// fills up," not a percentage bar: `target` slots, the first `done` filled.
struct CollectionGridView: View {
    let ctx: GoalDataContext
    var headerRight: AnyView?

    private static let columns = [GridItem(.adaptive(minimum: 30), spacing: 4)]

    private var target: Int { Int(ctx.goal.target ?? 0) }
    private var done: Int { Int(ctx.goal.totalProgress.rounded()) }
    private var currentMonth: Int { GoalDateKey.calendar.component(.month, from: GoalDateKey.parse(ctx.stats.today)) - 1 }
    private var monthMax: Double { max(1, ctx.stats.byMonth[0...currentMonth].max() ?? 1) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                Text(ctx.goal.title).font(WF.serif(17, .semibold)).foregroundStyle(WF.ink)
                Spacer()
                headerRight
            }

            LazyVGrid(columns: Self.columns, spacing: 4) {
                ForEach(0..<max(target, done), id: \.self) { i in
                    let filled = i < done
                    let (r, g, b) = GoalStats.heat(0.42 + 0.5 * Double((i * 3) % 5) / 5)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(filled ? Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255) : WF.panel)
                        .overlay(filled ? nil : RoundedRectangle(cornerRadius: 4).strokeBorder(WF.hair, style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
                        .frame(height: 46)
                }
            }

            (Text("\(done)").font(WF.serif(15, .semibold)).foregroundStyle(WF.ink)
                + Text(" of \(target)").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
                + (ctx.stats.projectedFinish.map { pf in
                    Text(" · on pace for \(GoalViewFmt.monthName(GoalDateKey.calendar.component(.month, from: GoalDateKey.parse(pf)) - 1))")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.success)
                } ?? Text("")))

            Text((ctx.goal.unit ?? "ITEMS").uppercased() + " PER MONTH")
                .font(.system(size: 11, weight: .heavy)).tracking(0.4).foregroundStyle(WF.ink3)
            HStack(alignment: .bottom, spacing: 6) {
                ForEach(0...currentMonth, id: \.self) { m in
                    VStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 3).fill(WF.success)
                            .frame(width: 18, height: max(2, 40 * ctx.stats.byMonth[m] / monthMax))
                        Text(GoalViewFmt.monthName(m).prefix(1)).font(.system(size: 9.5, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                }
            }
            .frame(height: 48, alignment: .bottom)
        }
    }
}

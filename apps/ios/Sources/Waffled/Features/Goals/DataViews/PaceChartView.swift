import SwiftUI
import Charts

/// Pace — cumulative logged amount vs. the straight-line path to target. Handles
/// three timeframes generically (fixed short/long, or open-ended) — never a
/// hard-coded 365; everything derives from the goal's own start/end.
struct PaceChartView: View {
    let ctx: GoalDataContext
    var headerRight: AnyView?

    private var target: Double { ctx.goal.target ?? 0 }
    private var pace: GoalPace? { ctx.stats.pace }
    private var projectedFinish: String? { ctx.stats.projectedFinish }

    private var domainEnd: String {
        if let e = ctx.stats.endDate { return e }
        if let pf = projectedFinish, pf > ctx.stats.today { return pf }
        return GoalDateKey.addDays(ctx.stats.today, 14)
    }

    private var points: [(date: Date, cumulative: Double)] {
        var cum = 0.0
        var result: [(Date, Double)] = []
        var d = ctx.stats.startDate
        while d <= ctx.stats.today {
            cum += ctx.stats.dayEntry(d).total
            result.append((GoalDateKey.parse(d), cum))
            d = GoalDateKey.addDays(d, 1)
        }
        return result
    }
    private var total: Double { points.last?.1 ?? 0 }
    private var yUpper: Double { max(target, total) > 0 ? max(target, total) * 1.05 : 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Path to \(GoalViewFmt.num(target))").font(WF.serif(17, .semibold)).foregroundStyle(WF.ink)
                    Text("cumulative \(ctx.goal.unit ?? "") vs. the pace you need")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                Spacer()
                if let pace {
                    Text("\(pace.delta >= 0 ? "+" : "")\(GoalViewFmt.num(pace.delta)) \(ctx.goal.unit ?? "") vs pace")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundStyle(pace.delta >= 0 ? WF.success : WF.danger)
                        .padding(.horizontal, 11).padding(.vertical, 5)
                        .background(pace.delta >= 0 ? WF.successT : WF.dangerT)
                        .clipShape(Capsule())
                }
                headerRight
            }

            Chart {
                ForEach(points, id: \.date) { p in
                    AreaMark(x: .value("Date", p.date), y: .value("Total", p.cumulative))
                        .foregroundStyle(LinearGradient(colors: [Color(hex: 0x25A368).opacity(0.28), Color(hex: 0x25A368).opacity(0)], startPoint: .top, endPoint: .bottom))
                    LineMark(x: .value("Date", p.date), y: .value("Total", p.cumulative))
                        .foregroundStyle(Color(hex: 0x1c9160))
                        .lineStyle(StrokeStyle(lineWidth: 3, lineJoin: .round))
                }
                if pace != nil {
                    LineMark(x: .value("Date", GoalDateKey.parse(ctx.stats.startDate)), y: .value("Pace", 0.0), series: .value("Series", "pace"))
                        .foregroundStyle(WF.ink3).lineStyle(StrokeStyle(lineWidth: 2, dash: [5, 5]))
                    LineMark(x: .value("Date", GoalDateKey.parse(domainEnd)), y: .value("Pace", target), series: .value("Series", "pace"))
                        .foregroundStyle(WF.ink3).lineStyle(StrokeStyle(lineWidth: 2, dash: [5, 5]))
                } else if target > 0 {
                    RuleMark(y: .value("Target", target))
                        .foregroundStyle(WF.ink3).lineStyle(StrokeStyle(lineWidth: 2, dash: [5, 5]))
                }
                RuleMark(x: .value("Today", GoalDateKey.parse(ctx.stats.today)))
                    .foregroundStyle(WF.primary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                PointMark(x: .value("Today", GoalDateKey.parse(ctx.stats.today)), y: .value("Total", total))
                    .foregroundStyle(Color(hex: 0x1c9160))
                    .symbolSize(80)
                    .annotation(position: .top) {
                        Text("\(GoalViewFmt.num(total)) \(ctx.goal.unit ?? "")")
                            .font(WF.serif(13, .bold)).foregroundStyle(Color(hex: 0x1c7a4e))
                    }
            }
            .chartYScale(domain: 0...yUpper)
            .frame(height: 220)

            HStack(spacing: 16) {
                legendDot(Color(hex: 0x1c9160), "Logged so far")
                if let pace {
                    legendDot(WF.ink3, "Pace to hit \(GoalViewFmt.num(target)) by \(GoalViewFmt.monthDay(pace.endLabel))")
                } else {
                    legendDot(WF.ink3, "Target · \(GoalViewFmt.num(target)) \(ctx.goal.unit ?? "")")
                }
                Spacer()
                if let pf = projectedFinish {
                    (Text(pace != nil ? "Projected finish · " : "On track to finish ~ ")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
                        + Text(GoalViewFmt.monthDay(pf)).font(WF.serif(12, .semibold)).foregroundStyle(WF.success))
                } else if pace == nil {
                    Text("Keep going — \(GoalViewFmt.num(max(0, target - total))) \(ctx.goal.unit ?? "") to go")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
                }
            }
        }
    }

    private func legendDot(_ color: Color, _ text: String) -> some View {
        HStack(spacing: 6) {
            RoundedRectangle(cornerRadius: 4).fill(color).frame(width: 11, height: 11)
            Text(text).font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
        }
    }
}

import SwiftUI
import Charts

/// By person — stacked columns by month. Who is driving the family total.
struct ByPersonBarsView: View {
    let ctx: GoalDataContext
    var headerRight: AnyView?

    private var year: Int { GoalDateKey.calendar.component(.year, from: GoalDateKey.parse(ctx.stats.today)) }
    private var currentMonth: Int { GoalDateKey.calendar.component(.month, from: GoalDateKey.parse(ctx.stats.today)) - 1 } // 0-indexed
    private var months: [Int] { Array(0...currentMonth) }
    private var monthLabels: [String] { months.map { GoalViewFmt.monthName($0).prefix(3).description } }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("By month · by person").font(WF.serif(17, .semibold)).foregroundStyle(WF.ink)
                    Text("who is driving the family total").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                Spacer()
                headerRight
            }

            Chart {
                ForEach(months, id: \.self) { m in
                    ForEach(ctx.goal.participants, id: \.personId) { p in
                        let amount = ctx.stats.byMonthPerMember[m][p.personId] ?? 0
                        if amount > 0 {
                            BarMark(x: .value("Month", monthLabels[m]), y: .value("Amount", amount))
                                .foregroundStyle(Color(hexString: p.colorHex) ?? WF.ink3)
                        }
                    }
                }
            }
            .chartXScale(domain: monthLabels)
            .chartLegend(.hidden)
            .frame(height: 190)
            .chartOverlay { proxy in
                GeometryReader { geo in
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .onTapGesture { location in
                            guard let plotFrame = proxy.plotFrame,
                                  let label: String = proxy.value(atX: location.x - geo[plotFrame].origin.x),
                                  let idx = monthLabels.firstIndex(of: label) else { return }
                            ctx.onMonthTap(year, months[idx])
                        }
                }
            }

            FlowChips(participants: ctx.goal.participants, stats: ctx.stats, unit: ctx.goal.unit)
        }
    }
}

/// Wrap row of per-person total chips — `{dot} {Name} {total} {unit}` on a panel pill.
private struct FlowChips: View {
    let participants: [WaffledAPI.Goal.Participant]
    let stats: GoalStatsResult
    let unit: String?

    private static let columns = [GridItem(.adaptive(minimum: 110), spacing: 8)]

    var body: some View {
        LazyVGrid(columns: Self.columns, alignment: .leading, spacing: 8) {
            ForEach(participants, id: \.personId) { p in
                HStack(spacing: 9) {
                    Circle().fill(Color(hexString: p.colorHex) ?? WF.ink3).frame(width: 12, height: 12)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(goalFirstName(p.name)).font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                        (Text(GoalViewFmt.num(stats.byPerson[p.personId] ?? 0)).font(WF.serif(15, .semibold)).foregroundStyle(WF.ink)
                            + Text(unit.map { " \($0)" } ?? "").font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3))
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(WF.panel)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }
}

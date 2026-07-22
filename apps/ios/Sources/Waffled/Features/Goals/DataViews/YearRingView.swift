import SwiftUI

/// Year ring — radial polar bars. A glanceable, decorative "year so far": each
/// wedge is a month, a longer filled arc = more logged that month. The most
/// optional view — a Canvas-drawn donut, cheap enough for a single detail screen.
struct YearRingView: View {
    let ctx: GoalDataContext
    var headerRight: AnyView?

    private static let s: CGFloat = 260
    private static let r0: CGFloat = 56
    private static let r1: CGFloat = 116
    private static let gapDeg: Double = 3
    private static let monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    private var year: Int { GoalDateKey.calendar.component(.year, from: GoalDateKey.parse(ctx.stats.today)) }
    private var currentMonth: Int { GoalDateKey.calendar.component(.month, from: GoalDateKey.parse(ctx.stats.today)) - 1 }
    private var monthMax: Double { max(1, ctx.stats.byMonth[0...currentMonth].max() ?? 1) }
    private var total: Double { ctx.stats.byMonth.reduce(0, +) }
    private var target: Double { ctx.goal.target ?? 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("The year in a ring").font(WF.serif(17, .semibold)).foregroundStyle(WF.ink)
                    Text("each wedge is a month — longer = more \(ctx.goal.unit ?? "logged")")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                Spacer()
                headerRight
            }

            HStack(alignment: .center, spacing: 8) {
                ring
                    .frame(width: Self.s, height: Self.s)
                monthList
            }
        }
    }

    private func polar(_ r: CGFloat, _ angleDeg: Double, _ center: CGPoint) -> CGPoint {
        let t: Double = (angleDeg - 90) * .pi / 180
        let dx = CGFloat(cos(t)), dy = CGFloat(sin(t))
        return CGPoint(x: center.x + r * dx, y: center.y + r * dy)
    }

    private func sectorPath(_ rr0: CGFloat, _ rr1: CGFloat, _ a0: Double, _ a1: Double, _ center: CGPoint) -> Path {
        var p = Path()
        p.addArc(center: center, radius: rr1, startAngle: .degrees(a0 - 90), endAngle: .degrees(a1 - 90), clockwise: false)
        p.addLine(to: polar(rr0, a1, center))
        p.addArc(center: center, radius: rr0, startAngle: .degrees(a1 - 90), endAngle: .degrees(a0 - 90), clockwise: true)
        p.closeSubpath()
        return p
    }

    private var ring: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            for m in 0..<12 {
                let a0 = Double(m) * 30 + Self.gapDeg / 2
                let a1 = Double(m + 1) * 30 - Self.gapDeg / 2
                context.stroke(sectorPath(Self.r0, Self.r1, a0, a1, center), with: .color(WF.hair), lineWidth: 1)
                let monthTotal = ctx.stats.byMonth[m]
                if m <= currentMonth, monthTotal > 0 {
                    let rr = Self.r0 + CGFloat(monthTotal / monthMax) * (Self.r1 - Self.r0)
                    let (r, g, b) = GoalStats.heat(0.35 + 0.6 * (monthTotal / monthMax))
                    context.fill(sectorPath(Self.r0, rr, a0, a1, center), with: .color(Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)))
                }
                let mid = (a0 + a1) / 2
                let lp = polar(Self.r1 + 13, mid, center)
                context.draw(Text(Self.monthNames[m]).font(.system(size: 10, weight: .heavy)).foregroundStyle(m > currentMonth ? WF.ink3 : WF.ink2), at: lp)
            }
            context.fill(Path(ellipseIn: CGRect(x: center.x - (Self.r0 - 4), y: center.y - (Self.r0 - 4), width: (Self.r0 - 4) * 2, height: (Self.r0 - 4) * 2)), with: .color(WF.panel))
            context.draw(Text(GoalViewFmt.num(total)).font(WF.serif(28, .semibold)).foregroundStyle(WF.ink), at: CGPoint(x: center.x, y: center.y - 6))
            context.draw(Text("of \(GoalViewFmt.num(target))\(ctx.goal.unit.map { " \($0)" } ?? "")").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3), at: CGPoint(x: center.x, y: center.y + 14))
        }
        .gesture(
            SpatialTapGesture().onEnded { value in
                let center = CGPoint(x: Self.s / 2, y: Self.s / 2)
                let dx = Double(value.location.x - center.x), dy = Double(value.location.y - center.y)
                var deg = atan2(dy, dx) * 180 / Double.pi + 90
                if deg < 0 { deg += 360 }
                let m = min(11, Int(deg / 30))
                guard m <= currentMonth else { return }
                ctx.onMonthTap(year, m)
            }
        )
    }

    private var monthList: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(0...currentMonth, id: \.self) { m in
                HStack(spacing: 9) {
                    Text(Self.monthNames[m]).font(.system(size: 11.5, weight: .heavy)).foregroundStyle(WF.ink3).frame(width: 26, alignment: .leading)
                    GeometryReader { geo in
                        let (r, g, b) = GoalStats.heat(0.4 + 0.55 * (ctx.stats.byMonth[m] / monthMax))
                        ZStack(alignment: .leading) {
                            Capsule().fill(WF.panel)
                            Capsule().fill(Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255))
                                .frame(width: geo.size.width * min(1, ctx.stats.byMonth[m] / monthMax))
                        }
                    }
                    .frame(height: 8)
                    Text(GoalViewFmt.num(ctx.stats.byMonth[m])).font(WF.serif(12.5, .semibold)).foregroundStyle(WF.ink).frame(width: 34, alignment: .trailing)
                }
            }
            Text("\(GoalViewFmt.num(max(0, target - total)))\(ctx.goal.unit.map { " \($0)" } ?? "") to go")
                .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(WF.ink3)
        }
    }
}

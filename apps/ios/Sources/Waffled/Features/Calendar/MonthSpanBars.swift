import SwiftUI

/// Multi-day all-day events drawn as bars over one month row (`PhoneCalendar.weekSpans`), shared
/// by the iPhone grid (`PhoneMonthGrid`) and the iPad's (`KioskCalendarView`). The cells leave
/// `reservedHeight` empty under the day number; taps fall through to the cell underneath.
struct MonthSpanBars: View {
    @Environment(SyncManager.self) private var sync
    let spans: PhoneCalendar.WeekSpans
    let inMonth: [Bool]
    var kiosk = false

    private struct Metrics {
        let spacing, inset, top, height, gap, font, textPad: CGFloat
    }

    private static let phone = Metrics(
        spacing: 0, inset: 2,
        top: PhoneCalendar.cellTopPadding + PhoneCalendar.dayNumberHeight + PhoneCalendar.chipGap,
        height: PhoneCalendar.chipHeight, gap: PhoneCalendar.chipGap, font: 9, textPad: 3)
    // The iPad cell: 7pt padding, a 24pt day number, 3pt stack spacing, ~18pt chips.
    private static let pad = Metrics(spacing: 6, inset: 5, top: 34, height: 18, gap: 3, font: 11.5, textPad: 7)

    static func reservedHeight(lanes: Int, kiosk: Bool) -> CGFloat {
        let m = kiosk ? pad : phone
        return lanes > 0 ? CGFloat(lanes) * m.height + CGFloat(lanes - 1) * m.gap : 0
    }

    var body: some View {
        let m = kiosk ? Self.pad : Self.phone
        GeometryReader { geo in
            ForEach(spans.bars, id: \.event.id) { bar in
                let (background, foreground) = colors(bar.event)
                let lead: CGFloat = bar.continuesBefore ? 0 : 4
                let trail: CGFloat = bar.continuesAfter ? 0 : 4
                let frame = PhoneCalendar.spanBarX(startCol: bar.startCol, endCol: bar.endCol, rowWidth: geo.size.width,
                                                   spacing: m.spacing, inset: m.inset)
                let dim = !(inMonth.indices.contains(bar.startCol) && inMonth[bar.startCol])
                    && !(inMonth.indices.contains(bar.endCol) && inMonth[bar.endCol])
                Text(RhythmMark.prefixed(bar.event.title, isRhythm: bar.event.isRhythm))
                    .font(.system(size: m.font, weight: kiosk ? .semibold : .bold)).foregroundStyle(foreground)
                    .lineLimit(1)
                    .padding(.horizontal, m.textPad)
                    .frame(width: frame.width, height: m.height, alignment: .leading)
                    .background(background, in: UnevenRoundedRectangle(
                        topLeadingRadius: lead, bottomLeadingRadius: lead,
                        bottomTrailingRadius: trail, topTrailingRadius: trail, style: .continuous))
                    .opacity(dim ? 0.42 : 1)
                    .offset(x: frame.x, y: m.top + CGFloat(bar.lane) * (m.height + m.gap))
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func colors(_ event: SyncedEvent) -> (Color, Color) {
        if kiosk {
            let paint = sync.eventPalette.chip(for: event)
            return (paint.background, paint.foreground)
        }
        let paint = sync.eventPalette.phoneChip(for: event)
        return (paint.background, paint.foreground)
    }
}

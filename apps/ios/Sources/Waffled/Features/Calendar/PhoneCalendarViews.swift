import SwiftUI

// The three iPhone calendar screens drawn by `CalendarView`: Month grid, Week card rail and
// the Day timeline. Layout numbers come from `PhoneCalendar`; the iPad draws its own grids
// in `KioskCalendarView`.

/// Full-height month: week numbers in a left gutter, event titles in each day cell.
struct PhoneMonthGrid: View {
    @Environment(SyncManager.self) private var sync
    let rows: [PhoneCalendar.MonthRow]
    let firstDay: HouseholdWeekStart
    let tz: TimeZone
    let byDay: [String: [SyncedEvent]]
    let countdownsByDay: [String: [WaffledAPI.Countdown]]
    let todayKey: String
    let selectedDay: String
    let onPick: (String) -> Void

    private let gutter: CGFloat = 18

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Color.clear.frame(width: gutter)
                // Indexed by offset: "T" and "S" each appear twice.
                ForEach(Array(Cal.rotated(["S", "M", "T", "W", "T", "F", "S"], from: firstDay).enumerated()),
                        id: \.offset) { _, label in
                    Text(label).font(.system(size: 10, weight: .heavy)).foregroundStyle(WF.ink3)
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(height: 20)
            Rectangle().fill(WF.hair2).frame(height: 1)
            GeometryReader { geo in
                let rowHeight = rows.isEmpty ? 0 : geo.size.height / CGFloat(rows.count)
                VStack(spacing: 0) {
                    ForEach(rows, id: \.days.first?.key) { row in
                        HStack(spacing: 0) {
                            Text("\(row.weekNumber)").font(.system(size: 9, weight: .bold))
                                .foregroundStyle(WF.ink3.opacity(0.7))
                                .padding(.top, 5)
                                .frame(width: gutter, alignment: .top).frame(maxHeight: .infinity, alignment: .top)
                                .overlay(alignment: .trailing) { Rectangle().fill(WF.hair2).frame(width: 1) }
                                .accessibilityLabel("Week \(row.weekNumber)")
                            ForEach(row.days, id: \.key) { cell($0, rowHeight: rowHeight) }
                        }
                        .frame(height: rowHeight)
                    }
                }
            }
        }
        .padding(.horizontal, 8)
    }

    private func cell(_ d: PhoneCalendar.MonthDay, rowHeight: CGFloat) -> some View {
        let events = PhoneCalendar.displayOrder(byDay[d.key] ?? [])
        let countdown = countdownsByDay[d.key]?.first
        let chips = PhoneCalendar.cellChips(eventCount: events.count, hasCountdown: countdown != nil,
                                            rowHeight: rowHeight)
        let isToday = d.key == todayKey
        return Button { onPick(d.key) } label: {
            VStack(alignment: .leading, spacing: PhoneCalendar.chipGap) {
                dayNumber(d, isToday: isToday, isSelected: d.key == selectedDay && !isToday)
                Group {
                    if chips.showsCountdown, let countdown { countdownPill(countdown) }
                    ForEach(events.prefix(chips.shown)) { chip($0) }
                }
                .opacity(d.inMonth ? 1 : 0.42)
                if chips.more > 0 {
                    Text("+\(chips.more) more").font(.system(size: 8.5, weight: .heavy)).foregroundStyle(WF.ink3)
                        .lineLimit(1).padding(.leading, 3).frame(height: PhoneCalendar.moreLineHeight)
                }
            }
            .padding(.horizontal, 2).padding(.top, PhoneCalendar.cellTopPadding)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .overlay(alignment: .bottom) { Rectangle().fill(WF.hair2).frame(height: 1) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel(d, count: events.count))
    }

    private func dayNumber(_ d: PhoneCalendar.MonthDay, isToday: Bool, isSelected: Bool) -> some View {
        Text("\(d.day)")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(isToday ? .white : isSelected ? WF.primary : d.inMonth ? WF.ink : WF.ink3.opacity(0.6))
            .frame(width: 22, height: PhoneCalendar.dayNumberHeight - 2)
            .background(isToday ? WF.primary : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                if isSelected {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(WF.primary, lineWidth: 1.5)
                }
            }
            .frame(maxWidth: .infinity).frame(height: PhoneCalendar.dayNumberHeight)
    }

    private func chip(_ ev: SyncedEvent) -> some View {
        let paint = sync.eventPalette.phoneChip(for: ev)
        return Text(RhythmMark.prefixed(ev.title, isRhythm: ev.isRhythm))
            .font(.system(size: 9, weight: .bold)).foregroundStyle(paint.foreground)
            .lineLimit(1)
            .padding(.horizontal, 3)
            .frame(maxWidth: .infinity, alignment: .leading).frame(height: PhoneCalendar.chipHeight)
            .background(paint.background, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
    }

    private func countdownPill(_ c: WaffledAPI.Countdown) -> some View {
        HStack(spacing: 2) {
            Text(c.title).lineLimit(1)
            Spacer(minLength: 0)
            Text(CountdownFormat.short(c.daysLeft)).fontWeight(.black)
        }
        .font(.system(size: 8, weight: .heavy)).foregroundStyle(WF.warn)
        .padding(.horizontal, 3).frame(height: PhoneCalendar.chipHeight)
        .background(WF.warnT, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
    }

    private func accessibilityLabel(_ d: PhoneCalendar.MonthDay, count: Int) -> String {
        let date = DateFmt.date(d.key, "yyyy-MM-dd", tz).map { DateFmt.string($0, "EEEE, MMMM d", tz) } ?? d.key
        return count == 0 ? date : "\(date), \(count) event\(count == 1 ? "" : "s")"
    }
}

/// Day cards on one continuous rail — whole weeks either side of the selected one — so swiping
/// on from a week's last day simply scrolls into the next week. The day strip above and the dots
/// below show the selected day's week. Tapping an event opens its editor; the card is not a way
/// into Day.
struct PhoneWeekRail: View {
    @Environment(SyncManager.self) private var sync
    let days: [String]
    let tz: TimeZone
    let firstDay: HouseholdWeekStart
    let byDay: [String: [SyncedEvent]]
    let countdownsByDay: [String: [WaffledAPI.Countdown]]
    let todayKey: String
    @Binding var selectedDay: String
    let onEditEvent: (SyncedEvent) -> Void
    let onTapCountdown: (WaffledAPI.Countdown) -> Void

    private static let weeksEachSide = 26

    @State private var railDays: [String] = []
    @State private var railDay: String?
    /// The first day of the week the day strip is paged to.
    @State private var stripWeek: String?

    var body: some View {
        VStack(spacing: 0) {
            strip
            GeometryReader { geo in
                let cardWidth = max(220, geo.size.width - 101)
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 12) {
                        ForEach(railDays, id: \.self) { key in
                            card(key).frame(width: cardWidth, height: max(0, geo.size.height - 8))
                        }
                    }
                    .scrollTargetLayout()
                }
                .contentMargins(.leading, 16, for: .scrollContent)
                .contentMargins(.trailing, max(16, geo.size.width - cardWidth - 16), for: .scrollContent)
                .scrollTargetBehavior(.viewAligned)
                .scrollPosition(id: $railDay, anchor: .leading)
            }
            dots.padding(.vertical, 12)
        }
        .onAppear {
            recenter(on: selectedDay)
            railDay = selectedDay
            stripWeek = days.first
        }
        .onChange(of: railDay) { _, key in
            guard let key, key != selectedDay else { return }
            withAnimation(.snappy) { selectedDay = key }
        }
        .onChange(of: stripWeek) { _, week in
            // Paging the strip lands on that week's first day.
            guard let week, week != days.first else { return }
            withAnimation(.snappy) { selectedDay = week }
        }
        .onChange(of: selectedDay) { _, key in
            if PhoneCalendar.railNeedsRecenter(selected: key, days: railDays) { recenter(on: key) }
            if railDay != key { withAnimation(.snappy) { railDay = key } }
            if stripWeek != days.first { withAnimation(.snappy) { stripWeek = days.first } }
        }
    }

    private func recenter(on key: String) {
        railDays = PhoneCalendar.railDays(around: key, weeksEachSide: Self.weeksEachSide, tz: tz, firstDay: firstDay)
    }

    /// A real scroller paged by week, over the rail's own weeks, so it can only ever move the
    /// same way the cards do.
    private var strip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 0) {
                ForEach(PhoneCalendar.railWeeks(railDays), id: \.self) { week in
                    HStack(spacing: 3) {
                        ForEach(daysOfWeek(startingAt: week), id: \.self) { key in stripDay(key) }
                    }
                    .padding(.horizontal, 12)
                    .containerRelativeFrame(.horizontal)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: $stripWeek)
        // A horizontal ScrollView takes all the height it's offered; a day is ~52pt tall.
        .frame(height: 54)
        .padding(.top, 2).padding(.bottom, 10)
    }

    private func daysOfWeek(startingAt week: String) -> ArraySlice<String> {
        guard let i = railDays.firstIndex(of: week) else { return [] }
        return railDays[i..<min(i + 7, railDays.count)]
    }

    private func stripDay(_ key: String) -> some View {
        let on = key == selectedDay
        return Button { withAnimation(.snappy) { selectedDay = key } } label: {
            VStack(spacing: 3) {
                Text(format(key, "EEEEE")).font(.system(size: 9.5, weight: .heavy))
                    .foregroundStyle(on ? WF.primary : WF.ink3)
                Text(format(key, "d")).font(.system(size: 15, weight: .bold))
                    .foregroundStyle(on ? WF.primary : WF.ink)
                HStack(spacing: 2) {
                    ForEach(Array(personColors(key).prefix(3)), id: \.self) { hex in
                        Circle().fill(Color(hexString: hex) ?? WF.ink3).frame(width: 4, height: 4)
                    }
                }
                .frame(height: 4)
            }
            .padding(.vertical, 6).frame(maxWidth: .infinity)
            .background(on ? WF.card : Color.clear, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay {
                if on { RoundedRectangle(cornerRadius: 13, style: .continuous).strokeBorder(WF.primary, lineWidth: 1.5) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(format(key, "EEEE, MMMM d"))
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func card(_ key: String) -> some View {
        let events = PhoneCalendar.displayOrder(byDay[key] ?? [])
        let countdowns = countdownsByDay[key] ?? []
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(format(key, "EEE").uppercased()).font(.system(size: 10.5, weight: .heavy)).tracking(0.8)
                    .foregroundStyle(WF.ink3)
                Text(format(key, "d")).font(WF.serif(26)).foregroundStyle(WF.ink)
                if key == todayKey { WaffledStatusBadge(text: "TODAY", color: WF.primaryD, size: 9.5, weight: .heavy) }
                Spacer(minLength: 0)
                Text("\(events.count + countdowns.count)").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
            }
            .padding(.bottom, 10)
            Rectangle().fill(WF.hair2).frame(height: 1)
            if events.isEmpty && countdowns.isEmpty {
                Text("Nothing planned").font(.system(size: 13, weight: .medium)).foregroundStyle(WF.ink3)
                    .padding(.top, 14)
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 0) {
                        ForEach(countdowns) { c in
                            Button { onTapCountdown(c) } label: { countdownRow(c) }.buttonStyle(.plain)
                        }
                        ForEach(events) { ev in
                            Button { onEditEvent(ev) } label: { eventRow(ev) }.buttonStyle(.plain)
                        }
                    }
                }
            }
            if sync.module(.meals) {
                Spacer(minLength: 0)
                let dinner = PhoneCalendar.dinnerFooter(events)
                Text(dinner ?? "No dinner planned")
                    .font(.system(size: 11, weight: .bold)).foregroundStyle(dinner == nil ? WF.ink3 : WF.warn)
                    .lineLimit(1)
                    .padding(.top, 9).padding(.bottom, 12)
            }
        }
        .padding(.horizontal, 15).padding(.top, 15)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(WF.card, in: RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous)
            .strokeBorder(key == selectedDay ? WF.primary.opacity(0.45) : WF.hair2, lineWidth: 1))
        .wfShadow1()
    }

    private func eventRow(_ ev: SyncedEvent) -> some View {
        row(time: ev.allDay ? "all day" : ev.startsAt.map { PhoneCalendar.shortTime($0, tz: tz) } ?? "",
            timeColor: WF.ink3, bar: sync.eventPalette.phoneChip(for: ev).color) {
            RhythmEventMark(event: ev, size: 11)
            Text(ev.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
        }
    }

    private func countdownRow(_ c: WaffledAPI.Countdown) -> some View {
        row(time: CountdownFormat.short(c.daysLeft), timeColor: WF.warn,
            bar: c.color.flatMap { Color(hexString: $0) } ?? WF.warn) {
            Text("\(c.emoji ?? "⏳") \(c.title)").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
        }
    }

    private func row<Title: View>(time: String, timeColor: Color, bar: Color,
                                  @ViewBuilder title: () -> Title) -> some View {
        HStack(spacing: 9) {
            Text(time).font(.system(size: 10.5, weight: .bold)).monospacedDigit().foregroundStyle(timeColor)
                .frame(width: 50, alignment: .leading)
            RoundedRectangle(cornerRadius: 2).fill(bar).frame(width: 3, height: 18)
            title()
            Spacer(minLength: 0)
        }
        .padding(.vertical, 7)
        .overlay(alignment: .bottom) { Rectangle().fill(WF.hair2).frame(height: 1) }
        .contentShape(Rectangle())
    }

    private var dots: some View {
        HStack(spacing: 5) {
            ForEach(days, id: \.self) { key in
                Capsule().fill(key == selectedDay ? WF.primary : WF.ink3.opacity(0.35))
                    .frame(width: key == selectedDay ? 16 : 5, height: 5)
            }
        }
        .animation(.snappy, value: selectedDay)
        .accessibilityHidden(true)
    }

    /// Distinct event colors for a strip day — a whole-family event contributes the family color;
    /// meal and thaw events belong to nobody in particular, so they add no dot.
    private func personColors(_ key: String) -> [String] {
        var seen = Set<String>(), colors: [String] = []
        for e in byDay[key] ?? [] where PhoneCalendar.EventKind(origin: e.origin) == .regular {
            let hex = sync.eventPalette.hex(for: e) ?? "#A6A29B"
            if seen.insert(hex).inserted { colors.append(hex) }
        }
        return colors
    }

    private func format(_ key: String, _ pattern: String) -> String {
        DateFmt.date(key, "yyyy-MM-dd", tz).map { DateFmt.string($0, pattern, tz) } ?? ""
    }
}

/// One day: date header, an all-day strip, then a timed grid with overlap lanes and a now line.
struct PhoneDayTimeline: View {
    @Environment(SyncManager.self) private var sync
    let day: String
    let tz: TimeZone
    let events: [SyncedEvent]
    let countdowns: [WaffledAPI.Countdown]
    let isToday: Bool
    let onTapEvent: (SyncedEvent) -> Void
    let onTapCountdown: (WaffledAPI.Countdown) -> Void
    let onAddAt: (Date) -> Void
    let onSwipeDay: (Int) -> Void

    static let hourHeight: CGFloat = 56
    private let gutter: CGFloat = 46
    private let trailing: CGFloat = 12
    private let topInset: CGFloat = 12

    var body: some View {
        let ordered = PhoneCalendar.displayOrder(events)
        let allDay = ordered.filter(\.allDay)
        let timed = ordered.filter { !$0.allDay && $0.startsAt != nil }
        let hours = PhoneCalendar.dayHours(timed, tz: tz)
        VStack(spacing: 0) {
            header(count: events.count + countdowns.count)
            if !allDay.isEmpty || !countdowns.isEmpty { allDayStrip(allDay) }
            let opening = PhoneCalendar.openingHour(timed, hours: hours, tz: tz)
            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    grid(timed, hours: hours)
                }
                // On the grid only: the all-day strip above scrolls sideways itself.
                .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { value in
                    if let step = PhoneCalendar.daySwipeStep(startX: value.startLocation.x,
                                                             dx: value.translation.width,
                                                             dy: value.translation.height) {
                        onSwipeDay(step)
                    }
                })
                // Keyed on the opening hour too: on a cold launch the day's events sync in after
                // the first render, and the grid should still open on them.
                .task(id: "\(day)|\(opening)") {
                    try? await Task.sleep(for: .milliseconds(60))
                    proxy.scrollTo(opening, anchor: .top)
                }
            }
        }
    }

    private func header(count: Int) -> some View {
        HStack(alignment: .lastTextBaseline, spacing: 7) {
            Text(format("EEE").uppercased()).font(.system(size: 11, weight: .heavy)).tracking(0.9).foregroundStyle(WF.ink3)
            Text(format("d")).font(WF.serif(30)).foregroundStyle(WF.ink)
            Text(format("MMMM")).font(WF.serif(18, .regular)).foregroundStyle(WF.ink3)
            if isToday { WaffledStatusBadge(text: "TODAY", color: WF.primaryD, size: 10, weight: .heavy) }
            Spacer(minLength: 0)
            Text(count == 1 ? "1 event" : "\(count) events").font(.system(size: 11.5, weight: .bold)).foregroundStyle(WF.ink3)
        }
        .padding(.horizontal, 18).padding(.top, 2).padding(.bottom, 10)
        .overlay(alignment: .bottom) { Rectangle().fill(WF.hair).frame(height: 1) }
    }

    private func allDayStrip(_ allDay: [SyncedEvent]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 5) {
                ForEach(countdowns) { c in
                    Button { onTapCountdown(c) } label: {
                        stripChip("\(c.emoji ?? "⏳") \(c.title) · \(CountdownFormat.short(c.daysLeft))",
                                  foreground: WF.warn, background: WF.warnT)
                    }
                    .buttonStyle(.plain)
                }
                ForEach(allDay) { ev in
                    let paint = sync.eventPalette.phoneChip(for: ev)
                    Button { onTapEvent(ev) } label: {
                        stripChip(RhythmMark.prefixed(ev.title, isRhythm: ev.isRhythm),
                                  foreground: paint.foreground, background: paint.background)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
        .overlay(alignment: .bottom) { Rectangle().fill(WF.hair).frame(height: 1) }
    }

    private func stripChip(_ text: String, foreground: Color, background: Color) -> some View {
        Text(text).font(.system(size: 10.5, weight: .bold)).foregroundStyle(foreground).lineLimit(1)
            .frame(maxWidth: 180)
            .padding(.horizontal, 8).frame(height: 20)
            .background(background, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private func grid(_ timed: [SyncedEvent], hours: ClosedRange<Int>) -> some View {
        let gridHeight = CGFloat(hours.count - 1) * Self.hourHeight + topInset * 2
        return ZStack(alignment: .topLeading) {
            // Scroll targets sit `topInset` above each hour line, so the hour a day opens on
            // keeps its label (drawn half above the line) on screen.
            VStack(spacing: 0) {
                Color.clear.frame(height: topInset).id(hours.lowerBound)
                ForEach(hours.lowerBound..<hours.upperBound, id: \.self) { h in
                    Button { onAddAt(date(atHour: h)) } label: { hourRow(h, height: Self.hourHeight) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Add an event at \(hourLabel(h))")
                        .overlay(alignment: .bottom) {
                            Color.clear.frame(height: topInset).allowsHitTesting(false).id(h + 1)
                        }
                }
                hourRow(hours.upperBound, height: 1)
            }
            GeometryReader { geo in
                let laneArea = geo.size.width - gutter - trailing
                ForEach(TimeLanes.place(timed), id: \.event.id) { placed in
                    block(placed, laneArea: laneArea, firstHour: hours.lowerBound, gridHeight: gridHeight)
                }
            }
            if isToday { nowLine(hours) }
        }
        .frame(height: gridHeight, alignment: .top)
    }

    private func hourRow(_ h: Int, height: CGFloat) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Text(hourLabel(h)).font(.system(size: 9.5, weight: .semibold)).foregroundStyle(WF.ink3)
                .frame(width: gutter - 6, alignment: .trailing).padding(.trailing, 6)
                .offset(y: -6)
            Rectangle().fill(WF.hair2).frame(height: 1)
        }
        .padding(.trailing, trailing)
        .frame(height: height, alignment: .top)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func block(_ placed: TimeLanes.Placed, laneArea: CGFloat, firstHour: Int, gridHeight: CGFloat) -> some View {
        let ev = placed.event
        if let start = ev.startsAt {
            let y = hourOffset(start, firstHour: firstHour)
            let minutes = TimeLanes.end(of: ev).timeIntervalSince(start) / 60
            let height = min(max(22, CGFloat(minutes) / 60 * Self.hourHeight - 4), gridHeight - y)
            let laneWidth = laneArea / CGFloat(placed.lanes)
            let tight = minutes < 60
            let paint = sync.eventPalette.phoneChip(for: ev)
            Button { onTapEvent(ev) } label: {
                HStack(spacing: 0) {
                    Rectangle().fill(paint.color).frame(width: 3)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 3) {
                            RhythmEventMark(event: ev, size: 10)
                            Text(ev.title).font(.system(size: tight ? 11 : 12, weight: .bold))
                                .foregroundStyle(paint.foreground).lineLimit(tight ? 1 : 2)
                        }
                        if !tight {
                            Text(PhoneCalendar.shortTime(start, tz: tz)).font(.system(size: 9.5, weight: .bold))
                                .foregroundStyle(paint.foreground.opacity(0.72))
                        }
                    }
                    .padding(.horizontal, 7).padding(.vertical, tight ? 2 : 4)
                    Spacer(minLength: 0)
                }
                .frame(width: max(0, laneWidth - 4), height: height, alignment: .topLeading)
                .background(paint.background)
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            }
            .buttonStyle(.plain)
            .offset(x: gutter + laneWidth * CGFloat(placed.lane) + 2, y: y)
        }
    }

    private func nowLine(_ hours: ClosedRange<Int>) -> some View {
        TimelineView(.periodic(from: .now, by: 60)) { ctx in
            let c = Cal.gregorian(tz).dateComponents([.hour, .minute], from: ctx.date)
            let hour = CGFloat(c.hour ?? 0) + CGFloat(c.minute ?? 0) / 60
            if hour >= CGFloat(hours.lowerBound), hour <= CGFloat(hours.upperBound) {
                ZStack(alignment: .leading) {
                    Rectangle().fill(WF.primary).frame(height: 1.5).padding(.leading, gutter)
                    Circle().fill(WF.primary).frame(width: 7, height: 7).offset(x: gutter - 3)
                }
                .padding(.trailing, trailing)
                .offset(y: hourOffset(ctx.date, firstHour: hours.lowerBound) - 1)
                .allowsHitTesting(false)
            }
        }
    }

    private func hourOffset(_ date: Date, firstHour: Int) -> CGFloat {
        let c = Cal.gregorian(tz).dateComponents([.hour, .minute], from: date)
        return (CGFloat((c.hour ?? 0) - firstHour) + CGFloat(c.minute ?? 0) / 60) * Self.hourHeight + topInset
    }

    private func date(atHour h: Int) -> Date {
        let base = DateFmt.date(day, "yyyy-MM-dd", tz) ?? Date()
        return Cal.gregorian(tz).date(bySettingHour: min(h, 23), minute: 0, second: 0, of: base) ?? base
    }

    private func hourLabel(_ h: Int) -> String {
        let hr = h % 12 == 0 ? 12 : h % 12
        return "\(hr) \(h < 12 || h == 24 ? "AM" : "PM")"
    }

    private func format(_ pattern: String) -> String {
        DateFmt.date(day, "yyyy-MM-dd", tz).map { DateFmt.string($0, pattern, tz) } ?? ""
    }
}

extension EventPalette {
    /// The phone calendar's chip paint. People follow the household's Event style; a planned
    /// meal is always an amber wash so it reads as a meal, and a thaw reminder the faintest
    /// grey, because it's a daily constant that shouldn't compete with real events.
    func phoneChip(for e: SyncedEvent) -> EventChipPaint {
        switch PhoneCalendar.EventKind(origin: e.origin) {
        case .meal: return EventChipPaint(WF.gold, style: .tinted)
        case .prep: return EventChipPaint(WF.ink3, style: .tinted)
        case .regular: return chip(for: e)
        }
    }
}

extension View {
    /// Spread to zoom the calendar in (Month → Week → Day), pinch to zoom back out.
    func calendarPinchZoom(_ zoom: @escaping (_ zoomIn: Bool) -> Void) -> some View {
        simultaneousGesture(MagnifyGesture().onEnded { value in
            if value.magnification > 1.25 { zoom(true) } else if value.magnification < 0.8 { zoom(false) }
        })
    }
}

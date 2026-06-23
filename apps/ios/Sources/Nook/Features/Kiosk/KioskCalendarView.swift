import SwiftUI

/// The iPad Calendar page — web-like Month / Week / Day views. Month is a width-
/// filling grid with event chips + a side day panel; Week and Day are time-grids
/// (hour axis + positioned event blocks). Reuses the shared data, sheets
/// (`EventEditSheet`, `EventDetailView`), and `EventCard`; the phone `CalendarView`
/// is untouched. See `apps/ios/IPAD_ROADMAP.md` (Phase 3 — web-ify pages).
struct KioskCalendarView: View {
    @Environment(SyncManager.self) private var sync

    enum Mode: String, CaseIterable { case month, week, day
        var label: String { rawValue.capitalized }
    }

    @State private var mode: Mode = Mode(rawValue: DemoHooks.kioskCalMode ?? "") ?? .month
    @State private var monthAnchor = Date()
    @State private var selectedDay = Agenda.todayKey(TimeZone.current)
    @State private var filterPerson: String?
    @State private var editing: CalendarView.EventEditTarget?
    @State private var detailEvent: SyncedEvent?

    private var tz: TimeZone { sync.householdTz }

    private var filtered: [SyncedEvent] {
        guard let p = filterPerson else { return sync.events }
        return sync.events.filter { $0.personId == p || $0.participantIds.contains(p) }
    }
    private var selectedItems: [SyncedEvent] { Agenda.forDay(filtered, day: selectedDay, tz: tz) }

    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 28).padding(.top, 18).padding(.bottom, 12)
            content.padding(.horizontal, 28).padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(NK.canvas)
        .sheet(item: $editing) { target in
            switch target {
            case let .new(date): EventEditSheet(event: nil, initialDate: date)
            case let .edit(event): EventEditSheet(event: event, initialDate: event.startsAt ?? Date())
            }
        }
        .sheet(item: $detailEvent) { ev in EventDetailView(event: ev) }
        .task {
            guard DemoHooks.kioskOpenEvent else { return }
            for _ in 0..<40 { if !sync.events.isEmpty { break }; try? await Task.sleep(nanoseconds: 150_000_000) }
            if detailEvent == nil {
                detailEvent = selectedItems.first ?? filtered.sorted { ($0.startsAt ?? .distantFuture) < ($1.startsAt ?? .distantFuture) }.first
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch mode {
        case .month:
            HStack(alignment: .top, spacing: 20) {
                monthGrid.frame(maxWidth: .infinity, maxHeight: .infinity)
                dayPanel.frame(width: 340)
            }
        case .week:
            CalTimeGrid(days: weekDays(selectedDay), tz: tz, events: filtered,
                        showDayHeaders: true, selectedDay: selectedDay,
                        onTapEvent: { detailEvent = $0 }, onAddAt: { editing = .new($0) },
                        onPickDay: { selectedDay = $0 })
        case .day:
            CalTimeGrid(days: [selectedDay], tz: tz, events: filtered,
                        showDayHeaders: false, selectedDay: selectedDay,
                        onTapEvent: { detailEvent = $0 }, onAddAt: { editing = .new($0) },
                        onPickDay: { _ in })
        }
    }

    // MARK: header

    private var header: some View {
        VStack(spacing: 12) {
            HStack(spacing: 14) {
                Text(navTitle).font(NK.serif(34)).foregroundStyle(NK.ink).lineLimit(1)
                Button { step(-1) } label: { chevron("chevron.left") }
                Button { step(1) } label: { chevron("chevron.right") }
                Button { withAnimation { monthAnchor = Date(); selectedDay = Agenda.todayKey(tz) } } label: {
                    Text("Today").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(NK.card).clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1))
                }
                .buttonStyle(.plain)
                Spacer()
                Picker("", selection: $mode.animation()) {
                    ForEach(Mode.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 240)
                Button { editing = .new(dayKeyToDate(selectedDay) ?? Date()) } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "plus").font(.system(size: 15, weight: .bold))
                        Text("Add event").font(.system(size: 15, weight: .bold))
                    }
                    .foregroundStyle(.white).padding(.horizontal, 16).padding(.vertical, 11)
                    .background(NK.primary).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            personFilter
        }
    }

    private var navTitle: String {
        switch mode {
        case .month: return DateFmt.string(monthAnchor, "MMMM yyyy", tz)
        case .week:
            let days = weekDays(selectedDay)
            guard let first = days.first.flatMap(dayKeyToDate), let last = days.last.flatMap(dayKeyToDate) else { return "" }
            return "\(DateFmt.string(first, "MMM d", tz)) – \(DateFmt.string(last, "MMM d", tz))"
        case .day:
            guard let d = dayKeyToDate(selectedDay) else { return selectedDay }
            return DateFmt.string(d, "EEEE, MMM d", tz)
        }
    }

    private func step(_ n: Int) {
        switch mode {
        case .month:
            var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
            if let d = cal.date(byAdding: .month, value: n, to: monthAnchor) { withAnimation { monthAnchor = d } }
        case .week: shiftDay(n * 7)
        case .day: shiftDay(n)
        }
    }

    private func shiftDay(_ n: Int) {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        if let d = dayKeyToDate(selectedDay), let nd = cal.date(byAdding: .day, value: n, to: d) {
            withAnimation { selectedDay = EventTime.dayKey(nd, tz) }
        }
    }

    private func chevron(_ s: String) -> some View {
        Image(systemName: s).font(.system(size: 14, weight: .heavy)).foregroundStyle(NK.ink2)
            .frame(width: 36, height: 36).background(NK.card).clipShape(Circle())
            .overlay(Circle().strokeBorder(NK.hair, lineWidth: 1))
    }

    private var personFilter: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                filterChip(nil, label: "Everyone")
                ForEach(sync.members) { m in filterChip(m.id, label: m.name, member: m) }
            }
        }
        // A horizontal ScrollView is greedy vertically too — cap its height so it
        // doesn't steal space from the time grid below (which left a gap).
        .frame(height: 36)
    }

    private func filterChip(_ id: String?, label: String, member: SyncedMember? = nil) -> some View {
        let on = filterPerson == id
        return Button { withAnimation { filterPerson = id } } label: {
            HStack(spacing: 7) {
                if let m = member {
                    Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 22)
                } else {
                    Image(systemName: "person.2.fill").font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(on ? .white : NK.ink2)
                        .frame(width: 22, height: 22)
                        .background(on ? Color.white.opacity(0.22) : NK.panel).clipShape(Circle())
                }
                Text(label).font(.system(size: 13, weight: .bold)).foregroundStyle(on ? .white : NK.ink2)
            }
            .padding(.leading, 6).padding(.trailing, 13).padding(.vertical, 6)
            .background(on ? NK.ink : NK.card)
            .overlay(Capsule().strokeBorder(on ? Color.clear : NK.hair, lineWidth: 1))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: month grid

    private var monthGrid: some View {
        let cells = monthCells(monthAnchor)
        return VStack(spacing: 6) {
            HStack(spacing: 6) {
                ForEach(Array(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].enumerated()), id: \.offset) { _, d in
                    Text(d).font(.system(size: 12, weight: .heavy)).foregroundStyle(NK.ink3).frame(maxWidth: .infinity)
                }
            }
            ForEach(0..<6, id: \.self) { row in
                HStack(spacing: 6) {
                    ForEach(0..<7, id: \.self) { col in
                        let idx = row * 7 + col
                        if idx < cells.count { monthCell(cells[idx]) } else { Color.clear }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxHeight: .infinity)
    }

    private func monthCell(_ cell: CalendarView.MonthCell) -> some View {
        let isSelected = cell.key == selectedDay
        let isToday = cell.key == Agenda.todayKey(tz)
        let items = Agenda.forDay(filtered, day: cell.key, tz: tz)
        return Button { withAnimation { selectedDay = cell.key } } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text("\(cell.day)")
                        .font(.system(size: 14, weight: isToday ? .heavy : .semibold))
                        .foregroundStyle(cell.inMonth ? (isToday ? .white : NK.ink) : NK.ink3.opacity(0.5))
                        .frame(width: 24, height: 24)
                        .background(isToday ? NK.primary : Color.clear).clipShape(Circle())
                    Spacer(minLength: 0)
                }
                ForEach(items.prefix(3)) { ev in eventChip(ev) }
                if items.count > 3 {
                    Text("+\(items.count - 3) more").font(.system(size: 11, weight: .semibold)).foregroundStyle(NK.ink3)
                }
                Spacer(minLength: 0)
            }
            .padding(7)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(isSelected ? NK.primary.opacity(0.08) : (cell.inMonth ? NK.card : NK.panel.opacity(0.4)))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(isSelected ? NK.primary : NK.hair, lineWidth: isSelected ? 1.5 : 1))
        }
        .buttonStyle(.plain)
    }

    private func eventChip(_ ev: SyncedEvent) -> some View {
        let color = Color(hexString: ev.colorHex) ?? NK.ink3
        return HStack(spacing: 5) {
            RoundedRectangle(cornerRadius: 99).fill(color).frame(width: 3, height: 13)
            Text(chipLabel(ev)).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 5).padding(.vertical, 2)
        .background(color.opacity(0.12)).clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private func chipLabel(_ ev: SyncedEvent) -> String {
        if ev.allDay { return ev.title }
        if let d = ev.startsAt { return "\(EventTime.timeLabel(d, tz))  \(ev.title)" }
        return ev.title
    }

    // MARK: day panel (month mode)

    private var dayPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(relativeLabel(selectedDay)).font(NK.serif(24)).foregroundStyle(NK.ink)
                Text(dateLabel(selectedDay)).font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink3)
                Spacer()
            }
            .padding(.bottom, 14)
            if selectedItems.isEmpty {
                Button { editing = .new(dayKeyToDate(selectedDay) ?? Date()) } label: {
                    VStack(spacing: 10) {
                        Image(systemName: "calendar.badge.plus").font(.system(size: 30)).foregroundStyle(NK.ink3)
                        Text("Nothing scheduled").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink2)
                        Text("Tap to add an event").font(.system(size: 13)).foregroundStyle(NK.ink3)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 40)
                }
                .buttonStyle(.plain)
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 10) {
                        ForEach(selectedItems) { ev in EventCard(event: ev, tz: tz) { detailEvent = ev } }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .padding(18)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    // MARK: helpers

    private func dayKeyToDate(_ key: String) -> Date? { DateFmt.date(key, "yyyy-MM-dd", tz) }

    /// The Sun-led week (7 day keys) containing `key`.
    private func weekDays(_ key: String) -> [String] {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        guard let d = dayKeyToDate(key) else { return [] }
        let weekday = cal.component(.weekday, from: d) - 1   // 0=Sun
        guard let start = cal.date(byAdding: .day, value: -weekday, to: d) else { return [] }
        return (0..<7).compactMap { cal.date(byAdding: .day, value: $0, to: start).map { EventTime.dayKey($0, tz) } }
    }

    private func relativeLabel(_ key: String) -> String {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        let tomorrow = EventTime.dayKey(cal.date(byAdding: .day, value: 1, to: Date()) ?? Date(), tz)
        if key == Agenda.todayKey(tz) { return "Today" }
        if key == tomorrow { return "Tomorrow" }
        guard let d = dayKeyToDate(key) else { return key }
        return DateFmt.string(d, "EEEE", tz)
    }

    private func dateLabel(_ key: String) -> String {
        guard let d = dayKeyToDate(key) else { return "" }
        return DateFmt.string(d, "MMM d", tz)
    }

    private func monthCells(_ anchor: Date) -> [CalendarView.MonthCell] {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        let comps = cal.dateComponents([.year, .month], from: anchor)
        guard let first = cal.date(from: comps) else { return [] }
        let anchorMonth = cal.component(.month, from: first)
        let leading = cal.component(.weekday, from: first) - 1
        guard let start = cal.date(byAdding: .day, value: -leading, to: first) else { return [] }
        return (0..<42).compactMap { i in
            guard let d = cal.date(byAdding: .day, value: i, to: start) else { return nil }
            return CalendarView.MonthCell(key: EventTime.dayKey(d, tz), day: cal.component(.day, from: d),
                                          inMonth: cal.component(.month, from: d) == anchorMonth)
        }
    }
}

/// A web-like time grid: an hour axis with one positioned-event-block column per day.
/// Used by the Week (7 columns) and Day (1 column) calendar modes.
struct CalTimeGrid: View {
    let days: [String]
    let tz: TimeZone
    let events: [SyncedEvent]
    let showDayHeaders: Bool
    let selectedDay: String
    let onTapEvent: (SyncedEvent) -> Void
    let onAddAt: (Date) -> Void
    let onPickDay: (String) -> Void

    private let hourHeight: CGFloat = 56
    private let gutter: CGFloat = 56

    private func timed(_ key: String) -> [SyncedEvent] {
        events.filter { Agenda.dayKey($0, tz) == key && !$0.allDay && $0.startsAt != nil }
            .sorted { ($0.startsAt ?? .distantPast) < ($1.startsAt ?? .distantPast) }
    }
    private func allDay(_ key: String) -> [SyncedEvent] {
        events.filter { Agenda.dayKey($0, tz) == key && $0.allDay }
    }
    private var hasAllDay: Bool { days.contains { !allDay($0).isEmpty } }

    var body: some View {
        VStack(spacing: 0) {
            if showDayHeaders { dayHeaders }
            if hasAllDay { allDayRow }
            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    ZStack(alignment: .topLeading) {
                        // Hour-row background gives real layout + scrollTo ids.
                        VStack(spacing: 0) {
                            ForEach(0..<24, id: \.self) { h in
                                hourRow(h).frame(height: hourHeight, alignment: .top).id(h)
                            }
                        }
                        // Equal-width day columns; blocks fill their column, offset by time.
                        HStack(spacing: 4) {
                            Color.clear.frame(width: gutter)
                            ForEach(days, id: \.self) { key in
                                ZStack(alignment: .topLeading) {
                                    ForEach(timed(key)) { ev in block(ev) }
                                }
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            }
                        }
                        .frame(height: 24 * hourHeight, alignment: .topLeading)
                    }
                    .frame(height: 24 * hourHeight)
                }
                .background(NK.card)
                .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
                .task { try? await Task.sleep(for: .milliseconds(150)); proxy.scrollTo(7, anchor: .top) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var dayHeaders: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: gutter, height: 1)
            ForEach(days, id: \.self) { key in
                let isToday = key == Agenda.todayKey(tz)
                Button { onPickDay(key) } label: {
                    VStack(spacing: 2) {
                        Text(weekdayShort(key)).font(.system(size: 12, weight: .heavy)).foregroundStyle(NK.ink3)
                        Text(dayNumber(key))
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(isToday ? .white : NK.ink)
                            .frame(width: 30, height: 30)
                            .background(isToday ? NK.primary : Color.clear).clipShape(Circle())
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(height: 48)
        .padding(.bottom, 10)
    }

    private var allDayRow: some View {
        HStack(spacing: 0) {
            Text("all-day").font(.system(size: 10, weight: .heavy)).foregroundStyle(NK.ink3)
                .frame(width: gutter, alignment: .trailing).padding(.trailing, 6)
            ForEach(days, id: \.self) { key in
                VStack(spacing: 3) {
                    ForEach(allDay(key)) { ev in
                        Button { onTapEvent(ev) } label: { miniChip(ev) }.buttonStyle(.plain)
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 6).padding(.bottom, 4)
    }

    private func miniChip(_ ev: SyncedEvent) -> some View {
        let color = Color(hexString: ev.colorHex) ?? NK.ink3
        return Text(ev.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(color.opacity(0.14)).clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private func hourRow(_ h: Int) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(hourLabel(h)).font(.system(size: 11, weight: .semibold)).foregroundStyle(NK.ink3)
                .frame(width: gutter - 8, alignment: .trailing)
            Rectangle().fill(NK.hair).frame(height: 1)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    @ViewBuilder private func block(_ ev: SyncedEvent) -> some View {
        if let start = ev.startsAt {
            let (h, m) = hourMinute(start)
            let y = (CGFloat(h) + CGFloat(m) / 60) * hourHeight
            let durMin = ev.endsAt.map { max(30, $0.timeIntervalSince(start) / 60) } ?? 60
            let height = max(26, CGFloat(durMin) / 60 * hourHeight - 3)
            let color = Color(hexString: ev.colorHex) ?? NK.ink3
            Button { onTapEvent(ev) } label: {
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 99).fill(color).frame(width: 3)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(ev.title).font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink).lineLimit(1)
                        if height > 38 {
                            Text(EventTime.timeLabel(start, tz)).font(.system(size: 11, weight: .medium)).foregroundStyle(NK.ink3)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 7).padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .frame(height: height, alignment: .topLeading)
                .background(color.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 2)
            .offset(y: y)
        }
    }

    // MARK: formatting

    private func hourLabel(_ h: Int) -> String {
        let hr = h % 12 == 0 ? 12 : h % 12
        return "\(hr) \(h < 12 ? "AM" : "PM")"
    }
    private func hourMinute(_ date: Date) -> (Int, Int) {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        let c = cal.dateComponents([.hour, .minute], from: date)
        return (c.hour ?? 0, c.minute ?? 0)
    }
    private func weekdayShort(_ key: String) -> String {
        guard let d = DateFmt.date(key, "yyyy-MM-dd", tz) else { return "" }
        return DateFmt.string(d, "EEE", tz).uppercased()
    }
    private func dayNumber(_ key: String) -> String {
        guard let d = DateFmt.date(key, "yyyy-MM-dd", tz) else { return "" }
        return DateFmt.string(d, "d", tz)
    }
}

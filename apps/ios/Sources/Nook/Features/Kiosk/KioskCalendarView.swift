import SwiftUI

/// The iPad Calendar page — web-like Month / Week / Day views. Month is a width-
/// filling grid with event chips + a side day panel; Week and Day are time-grids
/// (hour axis + positioned event blocks). Reuses the shared data, sheets
/// (`EventEditSheet`, `EventDetailView`), and `EventCard`; the phone `CalendarView`
/// is untouched. See `apps/ios/IPAD_ROADMAP.md` (Phase 3 — web-ify pages).
struct KioskCalendarView: View {
    @Environment(SyncManager.self) private var sync

    enum Mode: String, CaseIterable { case month, week, day, agenda
        var label: String { rawValue.capitalized }
    }

    @State private var mode: Mode = Mode(rawValue: DemoHooks.kioskCalMode ?? "") ?? .month
    @State private var monthAnchor = Date()
    @State private var miniAnchor = Date()
    @State private var selectedDay = Agenda.todayKey(TimeZone.current)
    @State private var filterPerson: String?
    @State private var editing: CalendarView.EventEditTarget?
    @State private var detailEvent: SyncedEvent?
    @State private var headsUp: NookAPI.HeadsUp?

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
            guard DemoHooks.kioskOpenEvent || DemoHooks.kioskOpenEdit else { return }
            for _ in 0..<40 { if !sync.events.isEmpty { break }; try? await Task.sleep(nanoseconds: 150_000_000) }
            let ev = selectedItems.first ?? filtered.sorted { ($0.startsAt ?? .distantFuture) < ($1.startsAt ?? .distantFuture) }.first
            if DemoHooks.kioskOpenEdit, let ev { editing = .edit(ev) }
            else if detailEvent == nil, let ev { detailEvent = ev }
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
        case .agenda:
            agendaContent
        }
    }

    // MARK: header

    private var header: some View {
        VStack(spacing: 12) {
            HStack(spacing: 14) {
                Text(navTitle).font(NK.serif(34)).foregroundStyle(NK.ink).lineLimit(1)
                if mode != .agenda {
                    Button { step(-1) } label: { chevron("chevron.left") }
                    Button { step(1) } label: { chevron("chevron.right") }
                    Button { withAnimation { monthAnchor = Date(); selectedDay = Agenda.todayKey(tz) } } label: {
                        Text("Today").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(NK.card).clipShape(Capsule())
                            .overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
                Picker("", selection: $mode.animation()) {
                    ForEach(Mode.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 300)
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
        case .agenda:
            return DateFmt.string(Date(), "EEE, MMMM d", tz)
        }
    }

    private func step(_ n: Int) {
        switch mode {
        case .month:
            var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
            if let d = cal.date(byAdding: .month, value: n, to: monthAnchor) { withAnimation { monthAnchor = d } }
        case .week: shiftDay(n * 7)
        case .day: shiftDay(n)
        case .agenda: break   // no month/week stepping in agenda
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

    // MARK: agenda (upcoming list + mini-month + heads-up + busy bars)

    private var agendaContent: some View {
        HStack(alignment: .top, spacing: 20) {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    Text("What's coming up").font(NK.serif(28)).foregroundStyle(NK.ink)
                    let groups = Agenda.upcoming(filtered, from: Agenda.todayKey(tz), tz: tz)
                    if groups.isEmpty {
                        Text("Nothing upcoming.").font(.system(size: 16)).foregroundStyle(NK.ink3).padding(.vertical, 14)
                    } else {
                        ForEach(groups, id: \.day) { g in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(spacing: 8) {
                                    Text(relativeLabel(g.day)).font(NK.serif(20)).foregroundStyle(NK.ink)
                                    Text(agendaDateLabel(g.day)).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
                                }
                                ForEach(g.items) { ev in EventCard(event: ev, tz: tz) { detailEvent = ev } }
                            }
                        }
                    }
                }
                .padding(.bottom, 20)
            }
            .frame(maxWidth: .infinity)

            ScrollView(showsIndicators: false) {
                VStack(spacing: 16) { miniMonth; headsUpCard; busyCard }
                .padding(.bottom, 20)
            }
            .frame(width: 360)
        }
        .task(id: sync.events.count) { await loadHeadsUp() }
    }

    private func agendaDateLabel(_ key: String) -> String {
        guard let d = dayKeyToDate(key) else { return "" }
        return DateFmt.string(d, "EEE · MMM d", tz)
    }

    private var miniMonth: some View {
        let cells = monthCells(miniAnchor)
        return VStack(spacing: 8) {
            HStack {
                Text(DateFmt.string(miniAnchor, "MMMM", tz)).font(NK.serif(20)).foregroundStyle(NK.ink)
                Spacer()
                Button { stepMini(-1) } label: { miniChevron("chevron.left") }
                Button { stepMini(1) } label: { miniChevron("chevron.right") }
            }
            HStack(spacing: 0) {
                ForEach(Array(["S", "M", "T", "W", "T", "F", "S"].enumerated()), id: \.offset) { _, d in
                    Text(d).font(.system(size: 11, weight: .heavy)).foregroundStyle(NK.ink3).frame(maxWidth: .infinity)
                }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 7), spacing: 4) {
                ForEach(cells, id: \.key) { cell in miniCell(cell) }
            }
        }
        .padding(16)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private func miniCell(_ cell: CalendarView.MonthCell) -> some View {
        let isToday = cell.key == Agenda.todayKey(tz)
        let colors = dotColors(cell.key)
        return Button { withAnimation { selectedDay = cell.key; mode = .day } } label: {
            VStack(spacing: 2) {
                Text("\(cell.day)")
                    .font(.system(size: 13, weight: isToday ? .heavy : .semibold))
                    .foregroundStyle(cell.inMonth ? (isToday ? .white : NK.ink) : NK.ink3.opacity(0.5))
                    .frame(width: 26, height: 26)
                    .background(isToday ? NK.primary : Color.clear).clipShape(Circle())
                HStack(spacing: 2) {
                    ForEach(Array(colors.prefix(3).enumerated()), id: \.offset) { _, hex in
                        Circle().fill(Color(hexString: hex) ?? NK.ink3).frame(width: 4, height: 4)
                    }
                }
                .frame(height: 4)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }

    private var headsUpCard: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "sparkles").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ai)
                .frame(width: 32, height: 32).background(NK.ai.opacity(0.12)).clipShape(Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(headsUp?.headline ?? "Heads up this week").font(.system(size: 15, weight: .heavy)).foregroundStyle(NK.ink)
                if let h = headsUp {
                    Text(h.body).font(.system(size: 13)).foregroundStyle(NK.ink2).fixedSize(horizontal: false, vertical: true)
                } else {
                    HStack(spacing: 6) {
                        Text("Thinking…").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
                        ProgressView().controlSize(.small).tint(NK.ai)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(NK.ai.opacity(0.06)).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.ai.opacity(0.2), lineWidth: 1))
    }

    @ViewBuilder private var busyCard: some View {
        let rows = busyRows
        if !rows.isEmpty {
            let maxCount = rows.map(\.count).max() ?? 1
            VStack(alignment: .leading, spacing: 12) {
                Text("Whose week is busy?").font(.system(size: 16, weight: .heavy)).foregroundStyle(NK.ink)
                ForEach(rows, id: \.member.id) { row in
                    HStack(spacing: 10) {
                        Avatar(colorHex: row.member.colorHex, emoji: row.member.emoji ?? "🙂", size: 28)
                        Text(row.member.name).font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink)
                            .frame(width: 66, alignment: .leading).lineLimit(1)
                        GeometryReader { g in
                            let tint = Color(hexString: row.member.colorHex) ?? NK.ink3
                            ZStack(alignment: .leading) {
                                Capsule().fill(tint.opacity(0.18))
                                Capsule().fill(tint).frame(width: g.size.width * CGFloat(row.count) / CGFloat(maxCount))
                            }
                        }
                        .frame(height: 10)
                        Text("\(row.count)").font(.system(size: 14, weight: .heavy)).foregroundStyle(NK.ink2)
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        }
    }

    private var busyRows: [(member: SyncedMember, count: Int)] {
        let week = Set(weekDays(Agenda.todayKey(tz)))
        var counts: [String: Int] = [:]
        for e in filtered {
            guard week.contains(Agenda.dayKey(e, tz)) else { continue }
            var ids = Set(e.participantIds)
            if let p = e.personId { ids.insert(p) }
            for id in ids { counts[id, default: 0] += 1 }
        }
        return sync.members.compactMap { m in counts[m.id].map { (member: m, count: $0) } }
            .filter { $0.count > 0 }
            .sorted { $0.count > $1.count }
    }

    private func dotColors(_ key: String) -> [String] {
        var seen = Set<String>(); var colors: [String] = []
        for e in filtered where Agenda.dayKey(e, tz) == key {
            let hex = e.colorHex ?? "#A6A29B"
            if seen.insert(hex).inserted { colors.append(hex) }
        }
        return colors
    }

    private func stepMini(_ n: Int) {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        if let d = cal.date(byAdding: .month, value: n, to: miniAnchor) { withAnimation { miniAnchor = d } }
    }

    private func miniChevron(_ s: String) -> some View {
        Image(systemName: s).font(.system(size: 11, weight: .heavy)).foregroundStyle(NK.ink2)
            .frame(width: 28, height: 28).background(NK.panel).clipShape(Circle())
    }

    private func loadHeadsUp() async {
        let week = weekDays(Agenda.todayKey(tz))
        guard let from = week.first, let to = week.last else { return }
        headsUp = try? await NookAPI().headsUp(from: from, to: to)
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
                        // Equal-width day columns; overlapping events split into lanes.
                        HStack(spacing: 4) {
                            Color.clear.frame(width: gutter)
                            ForEach(days, id: \.self) { key in
                                GeometryReader { colGeo in
                                    ZStack(alignment: .topLeading) {
                                        ForEach(placedEvents(key), id: \.event.id) { placed in
                                            block(placed, colWidth: colGeo.size.width)
                                        }
                                    }
                                }
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
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

    /// An event placed into a lane within its overlap cluster.
    struct PlacedEvent { let event: SyncedEvent; let lane: Int; let lanes: Int }

    /// Lay a day's timed events into side-by-side lanes so overlaps don't obscure each
    /// other (interval partitioning: cluster transitively-overlapping events, then
    /// greedily assign each the first free lane).
    private func placedEvents(_ key: String) -> [PlacedEvent] {
        func startOf(_ e: SyncedEvent) -> Date { e.startsAt ?? .distantPast }
        func endOf(_ e: SyncedEvent) -> Date {
            let s = e.startsAt ?? .distantPast
            let dur = e.endsAt.map { max(1800, $0.timeIntervalSince(s)) } ?? 3600   // ≥30 min
            return s.addingTimeInterval(dur)
        }
        let sorted = timed(key)
        var result: [PlacedEvent] = []
        var i = 0
        while i < sorted.count {
            var clusterEnd = endOf(sorted[i])
            var j = i + 1
            while j < sorted.count, startOf(sorted[j]) < clusterEnd {
                clusterEnd = max(clusterEnd, endOf(sorted[j])); j += 1
            }
            let cluster = Array(sorted[i..<j])
            var laneEnds: [Date] = []
            var assigned: [(SyncedEvent, Int)] = []
            for e in cluster {
                if let li = laneEnds.firstIndex(where: { startOf(e) >= $0 }) {
                    laneEnds[li] = endOf(e); assigned.append((e, li))
                } else {
                    laneEnds.append(endOf(e)); assigned.append((e, laneEnds.count - 1))
                }
            }
            for (e, li) in assigned { result.append(PlacedEvent(event: e, lane: li, lanes: laneEnds.count)) }
            i = j
        }
        return result
    }

    @ViewBuilder private func block(_ placed: PlacedEvent, colWidth: CGFloat) -> some View {
        let ev = placed.event
        if let start = ev.startsAt {
            let (h, m) = hourMinute(start)
            let y = (CGFloat(h) + CGFloat(m) / 60) * hourHeight
            let durMin = ev.endsAt.map { max(30, $0.timeIntervalSince(start) / 60) } ?? 60
            let height = max(26, CGFloat(durMin) / 60 * hourHeight - 3)
            let laneW = colWidth / CGFloat(placed.lanes)
            let color = Color(hexString: ev.colorHex) ?? NK.ink3
            Button { onTapEvent(ev) } label: {
                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 99).fill(color).frame(width: 3)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(ev.title).font(.system(size: placed.lanes > 1 ? 12 : 13, weight: .bold))
                            .foregroundStyle(NK.ink).lineLimit(placed.lanes > 2 ? 1 : 2)
                        if height > 38, placed.lanes < 3 {
                            Text(EventTime.timeLabel(start, tz)).font(.system(size: 11, weight: .medium)).foregroundStyle(NK.ink3)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 6).padding(.vertical, 4)
                .frame(width: max(0, laneW - 3), height: height, alignment: .topLeading)
                .background(color.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(NK.card, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .offset(x: laneW * CGFloat(placed.lane) + 1, y: y)
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

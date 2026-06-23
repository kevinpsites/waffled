import SwiftUI

/// The iPad Calendar page — a web-like month grid that fills the width, with a
/// side panel for the selected day. Reuses the shared data, sheets (`EventEditSheet`,
/// `EventDetailView`), and `EventCard`; the phone `CalendarView` is untouched.
/// See `apps/ios/IPAD_ROADMAP.md` (Phase 3 — web-ify pages).
struct KioskCalendarView: View {
    @Environment(SyncManager.self) private var sync

    @State private var monthAnchor = Date()
    @State private var selectedDay = Agenda.todayKey(TimeZone.current)
    @State private var filterPerson: String?
    @State private var editing: CalendarView.EventEditTarget?
    @State private var detailEvent: SyncedEvent?
    @State private var showCapture = false
    @State private var dictateOnOpen = false

    private var tz: TimeZone { sync.householdTz }

    private var filtered: [SyncedEvent] {
        guard let p = filterPerson else { return sync.events }
        return sync.events.filter { $0.personId == p || $0.participantIds.contains(p) }
    }
    private var selectedItems: [SyncedEvent] { Agenda.forDay(filtered, day: selectedDay, tz: tz) }

    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 28).padding(.top, 18).padding(.bottom, 12)
            HStack(alignment: .top, spacing: 20) {
                monthGrid.frame(maxWidth: .infinity, maxHeight: .infinity)
                dayPanel.frame(width: 340)
            }
            .padding(.horizontal, 28).padding(.bottom, 24)
        }
        .background(NK.canvas)
        .sheet(item: $editing) { target in
            switch target {
            case let .new(date): EventEditSheet(event: nil, initialDate: date)
            case let .edit(event): EventEditSheet(event: event, initialDate: event.startsAt ?? Date())
            }
        }
        .sheet(item: $detailEvent) { ev in EventDetailView(event: ev) }
        .sheet(isPresented: $showCapture) {
            CaptureSheet(autoDictate: dictateOnOpen).presentationDragIndicator(.visible)
        }
    }

    // MARK: header

    private var header: some View {
        VStack(spacing: 12) {
            HStack(spacing: 14) {
                Text(monthTitle(monthAnchor)).font(NK.serif(34)).foregroundStyle(NK.ink).lineLimit(1)
                Button { stepMonth(-1) } label: { chevron("chevron.left") }
                Button { stepMonth(1) } label: { chevron("chevron.right") }
                Button { withAnimation { monthAnchor = Date(); selectedDay = Agenda.todayKey(tz) } } label: {
                    Text("Today").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(NK.card).clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1))
                }
                .buttonStyle(.plain)
                Spacer()
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
            .frame(maxWidth: .infinity, alignment: .leading)
        }
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
                    Text(d).font(.system(size: 12, weight: .heavy)).foregroundStyle(NK.ink3)
                        .frame(maxWidth: .infinity)
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
                        .background(isToday ? NK.primary : Color.clear)
                        .clipShape(Circle())
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
        .background(color.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private func chipLabel(_ ev: SyncedEvent) -> String {
        if ev.allDay { return ev.title }
        if let d = ev.startsAt { return "\(EventTime.timeLabel(d, tz))  \(ev.title)" }
        return ev.title
    }

    // MARK: day panel

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
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    // MARK: helpers (local copies so the phone CalendarView stays untouched)

    private func monthTitle(_ date: Date) -> String { DateFmt.string(date, "MMMM yyyy", tz) }

    private func stepMonth(_ n: Int) {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        if let d = cal.date(byAdding: .month, value: n, to: monthAnchor) { withAnimation { monthAnchor = d } }
    }

    private func dayKeyToDate(_ key: String) -> Date? { DateFmt.date(key, "yyyy-MM-dd", tz) }

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

    /// 42 day-cells (6 weeks, Sunday-led) covering `anchor`'s month.
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

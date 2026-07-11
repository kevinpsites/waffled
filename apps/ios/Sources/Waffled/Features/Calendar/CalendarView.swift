import SwiftUI

/// Calendar tab — an upcoming-agenda list grouped by day, read live from the
/// local mirror. (A month grid can follow; the agenda is the high-value first cut
/// and exercises the same synced data as Today.)
struct CalendarView: View {
    @Environment(SyncManager.self) private var sync
    /// A reminder tap routes here with the event id to open (see AppRoot).
    var openEventId: Binding<String?> = .constant(nil)
    @State private var editing: EventEditTarget?
    /// Tapping an event opens its full detail (the editor is reached from there).
    @State private var detailEvent: SyncedEvent?
    /// Remembered across tab switches + launches, so your preferred view sticks.
    @AppStorage("waffled.calendarMode") private var mode: CalMode = .agenda
    @State private var filterPerson: String?       // nil = Everyone
    @State private var monthAnchor = Date()         // the month the grid shows
    @State private var selectedDay = Agenda.todayKey(TimeZone.current)
    @State private var showCapture = false
    @State private var dictateOnOpen = false
    @State private var countdowns = CountdownsModel()

    enum CalMode: String, CaseIterable { case agenda, month, day
        var label: String { rawValue.capitalized }
        var icon: String {
            switch self { case .agenda: return "list.bullet"; case .month: return "calendar"; case .day: return "calendar.day.timeline.left" }
        }
    }

    /// What the event editor sheet is creating/editing.
    enum EventEditTarget: Identifiable {
        case new(Date)
        case edit(SyncedEvent)
        var id: String {
            switch self {
            case let .new(d): return "new:\(d.timeIntervalSince1970)"
            case let .edit(e): return "edit:\(e.id)"
            }
        }
    }

    private var tz: TimeZone { sync.householdTz }
    /// Events filtered to the selected person — owner or a participant — or all.
    private var filtered: [SyncedEvent] {
        guard let p = filterPerson else { return sync.events }
        return sync.events.filter { $0.personId == p || $0.participantIds.contains(p) }
    }
    private var groups: [(day: String, items: [SyncedEvent])] {
        Agenda.upcoming(filtered, from: Agenda.todayKey(tz), tz: tz)
    }

    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 10)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: mode == .agenda ? 18 : 14) {
                        switch mode {
                        case .agenda: agendaContent
                        case .month:  monthContent
                        case .day:    dayContent
                        }
                    }
                    .padding(.horizontal, 18).padding(.bottom, 110)
                }
                // When the day grid appears, jump to the morning (or the first event).
                .task(id: "\(mode.rawValue)-\(selectedDay)") {
                    guard mode == .day else { return }
                    try? await Task.sleep(for: .milliseconds(60))
                    withAnimation { proxy.scrollTo(dayScrollHour(), anchor: .top) }
                }
                // Swipe left/right on the month or day grid to step to the next/previous
                // month or day. Simultaneous (not exclusive) so vertical scrolling still
                // works; we only act on a clearly-horizontal flick.
                .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded(handleCalendarSwipe))
            }
        }
        .background(WF.canvas)
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
        // Open the event a tapped reminder routed us to (once it's in the mirror).
        .task { openReminderEvent(openEventId.wrappedValue) }
        .task { await countdowns.load() }
        .onChange(of: openEventId.wrappedValue) { _, id in openReminderEvent(id) }
        .onChange(of: sync.events) { _, _ in
            if openEventId.wrappedValue != nil { openReminderEvent(openEventId.wrappedValue) }
        }
    }

    /// Open an event's detail by id (from a reminder tap), then clear the request.
    private func openReminderEvent(_ id: String?) {
        guard let id, let ev = sync.events.first(where: { $0.id == id }) else { return }
        detailEvent = ev
        openEventId.wrappedValue = nil
    }

    // MARK: header (month title + view toggle + add)

    private var header: some View {
        HStack(spacing: 12) {
            switch mode {
            case .agenda:
                Text(monthTitle(Date(), year: false)).font(WF.serif(30)).foregroundStyle(WF.ink)
            case .month:
                Button { stepMonth(-1) } label: { chevron("chevron.left") }
                Text(monthTitle(monthAnchor, year: true)).font(WF.serif(24)).foregroundStyle(WF.ink).lineLimit(1)
                Button { stepMonth(1) } label: { chevron("chevron.right") }
            case .day:
                Button { stepDay(-1) } label: { chevron("chevron.left") }
                Text(dayTitle(selectedDay)).font(WF.serif(22)).foregroundStyle(WF.ink).lineLimit(1)
                Button { stepDay(1) } label: { chevron("chevron.right") }
            }
            Spacer()
            Menu {
                ForEach(CalMode.allCases, id: \.self) { m in
                    Button { withAnimation { mode = m } } label: { Label(m.label, systemImage: m.icon) }
                }
            } label: {
                Image(systemName: mode.icon)
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink2)
                    .frame(width: 38, height: 38).background(WF.card).clipShape(Circle())
                    .overlay(Circle().strokeBorder(WF.hair, lineWidth: 1))
            }
            Button { editing = .new(mode == .agenda ? Date() : (dayKeyToDate(selectedDay) ?? Date())) } label: {
                Image(systemName: "plus").font(.system(size: 18, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 38, height: 38).background(WF.primary).clipShape(Circle())
            }
            .buttonStyle(.plain)
        }
    }

    private func chevron(_ s: String) -> some View {
        Image(systemName: s).font(.system(size: 13, weight: .heavy)).foregroundStyle(WF.ink2)
            .frame(width: 30, height: 30).background(WF.card).clipShape(Circle())
            .overlay(Circle().strokeBorder(WF.hair, lineWidth: 1))
    }

    // MARK: agenda

    @ViewBuilder private var agendaContent: some View {
        AICaptureBar(placeholder: "Add an event…",
                     onTap: { dictateOnOpen = false; showCapture = true },
                     onMic: { dictateOnOpen = true; showCapture = true })
        personFilter
        if groups.isEmpty {
            VStack(spacing: 10) {
                Image(systemName: "calendar").font(.system(size: 34)).foregroundStyle(WF.ink3)
                Text(filterPerson == nil ? "No upcoming events." : "Nothing for them coming up.")
                    .font(.system(size: 14)).foregroundStyle(WF.ink2)
            }
            .frame(maxWidth: .infinity).padding(.top, 56)
        } else {
            ForEach(groups, id: \.day) { group in
                VStack(alignment: .leading, spacing: 8) {
                    dayHeading(group.day)
                    ForEach(group.items) { ev in
                        EventCard(event: ev, tz: tz) { detailEvent = ev }
                    }
                }
            }
        }
    }

    private var personFilter: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                filterChip(nil, label: "Everyone")
                ForEach(sync.members) { m in filterChip(m.id, label: m.name, member: m) }
            }
            .padding(.vertical, 1)
        }
    }

    private func filterChip(_ id: String?, label: String, member: SyncedMember? = nil) -> some View {
        let on = filterPerson == id
        return Button { withAnimation { filterPerson = id } } label: {
            HStack(spacing: 7) {
                if let m = member {
                    Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 24)
                } else {
                    // "Everyone" — a family glyph so the chip matches the person chips' size.
                    Image(systemName: "person.2.fill").font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(on ? .white : WF.ink2)
                        .frame(width: 24, height: 24)
                        .background(on ? Color.white.opacity(0.22) : WF.panel).clipShape(Circle())
                }
                Text(label).font(.system(size: 14, weight: .bold))
                    .foregroundStyle(on ? .white : WF.ink2)
            }
            .padding(.leading, 6).padding(.trailing, 14).padding(.vertical, 7)
            .background(on ? WF.ink : WF.card)
            .overlay(Capsule().strokeBorder(on ? Color.clear : WF.hair, lineWidth: 1))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: month grid

    @ViewBuilder private var monthContent: some View {
        let cells = monthCells(monthAnchor)
        VStack(spacing: 8) {
            HStack(spacing: 0) {
                ForEach(["S", "M", "T", "W", "T", "F", "S"], id: \.self) { d in
                    Text(d).font(.system(size: 11, weight: .heavy)).foregroundStyle(WF.ink3)
                        .frame(maxWidth: .infinity)
                }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 7), spacing: 4) {
                ForEach(cells, id: \.key) { cell in monthCell(cell) }
            }
        }
        .padding(12)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))

        dayHeading(selectedDay).padding(.top, 6)
        let dayItems = Agenda.forDay(filtered, day: selectedDay, tz: tz)
        if dayItems.isEmpty {
            Button { editing = .new(dayKeyToDate(selectedDay) ?? Date()) } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus").font(.system(size: 12, weight: .heavy))
                    Text("Add an event").font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(WF.ink3).padding(.vertical, 10)
            }
            .buttonStyle(.plain)
        } else {
            VStack(spacing: 8) {
                ForEach(dayItems) { ev in EventCard(event: ev, tz: tz) { detailEvent = ev } }
            }
        }
    }

    private func monthCell(_ cell: MonthCell) -> some View {
        let isSelected = cell.key == selectedDay
        let isToday = cell.key == Agenda.todayKey(tz)
        return Button { withAnimation { selectedDay = cell.key } } label: {
            VStack(spacing: 3) {
                Text("\(cell.day)")
                    .font(.system(size: 14, weight: isToday ? .heavy : .semibold))
                    .foregroundStyle(cell.inMonth ? (isToday ? WF.primary : WF.ink) : WF.ink3.opacity(0.5))
                if let cds = countdowns.byDate[cell.key], let first = cds.first {
                    HStack(spacing: 2) {
                        Text(first.emoji ?? "⏳").font(.system(size: 8))
                        Text(CountdownFormat.short(first.daysLeft)).font(.system(size: 8, weight: .heavy)).foregroundStyle(Color(hex: 0x8A6D3B))
                        if cds.count > 1 { Text("+\(cds.count - 1)").font(.system(size: 8, weight: .bold)).foregroundStyle(WF.ink3) }
                    }
                    .padding(.horizontal, 3).padding(.vertical, 1)
                    .background(Color(hex: 0xF4ECD8)).clipShape(Capsule())
                } else {
                    HStack(spacing: 2) {
                        ForEach(Array(dotColors(cell.key).prefix(3).enumerated()), id: \.offset) { _, hex in
                            Circle().fill(Color(hexString: hex) ?? WF.ink3).frame(width: 5, height: 5)
                        }
                    }
                    .frame(height: 5)
                }
            }
            .frame(maxWidth: .infinity).frame(height: 44)
            .background(isSelected ? WF.primary.opacity(0.12) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(isSelected ? WF.primary : Color.clear, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
    }

    /// Distinct owner colors of events on a day (for the month dots).
    private func dotColors(_ key: String) -> [String] {
        var seen = Set<String>(); var colors: [String] = []
        for e in filtered where Agenda.dayKey(e, tz) == key {
            let hex = e.colorHex ?? "#A6A29B"
            if seen.insert(hex).inserted { colors.append(hex) }
        }
        return colors
    }

    // MARK: day grid

    private static let hourHeight: CGFloat = 52

    @ViewBuilder private var dayContent: some View {
        let all = Agenda.forDay(filtered, day: selectedDay, tz: tz)
        let allDay = all.filter { $0.allDay }
        let timed = all.filter { !$0.allDay && $0.startsAt != nil }

        if !allDay.isEmpty {
            VStack(spacing: 6) {
                ForEach(allDay) { ev in EventCard(event: ev, tz: tz) { detailEvent = ev } }
            }
        }
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                ForEach(0..<24, id: \.self) { h in
                    Button { editing = .new(dateAt(hour: h)) } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Text(hourLabel(h)).font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(WF.ink3).frame(width: 48, alignment: .trailing)
                            Rectangle().fill(WF.hair).frame(height: 1)
                            Spacer(minLength: 0)
                        }
                        .frame(height: Self.hourHeight, alignment: .top)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .id(h)
                }
            }
            ForEach(timed) { ev in dayBlock(ev) }
            // The "now" line, only on today.
            if selectedDay == Agenda.todayKey(tz) { nowLine }
        }
        .padding(.top, 2)
    }

    /// Live red current-time indicator (dot in the hour gutter + a rule across the day),
    /// repositioned every minute. Only shown when the day view is on today.
    private var nowLine: some View {
        TimelineView(.periodic(from: .now, by: 60)) { ctx in
            let comps = hourMinute(ctx.date)
            let y = (CGFloat(comps.h) + CGFloat(comps.m) / 60) * Self.hourHeight
            ZStack(alignment: .leading) {
                Rectangle().fill(Self.nowRed).frame(height: 2).padding(.leading, 56)
                Circle().fill(Self.nowRed).frame(width: 8, height: 8).offset(x: 52)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .offset(y: y - 1)
            .allowsHitTesting(false)
        }
    }

    private static let nowRed = Color(red: 0.89, green: 0.22, blue: 0.20)

    @ViewBuilder private func dayBlock(_ ev: SyncedEvent) -> some View {
        if let start = ev.startsAt {
            let comps = hourMinute(start)
            let y = (CGFloat(comps.h) + CGFloat(comps.m) / 60) * Self.hourHeight
            let durMin = ev.endsAt.map { max(30, $0.timeIntervalSince(start) / 60) } ?? 60
            let height = max(30, CGFloat(durMin) / 60 * Self.hourHeight - 4)
            let color = Color(hexString: ev.colorHex) ?? WF.ink3
            Button { detailEvent = ev } label: {
                HStack(spacing: 7) {
                    RoundedRectangle(cornerRadius: 99).fill(color).frame(width: 3)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(ev.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                        if height > 40 {
                            Text(EventTime.timeLabel(start, tz)).font(.system(size: 10.5, weight: .medium)).foregroundStyle(WF.ink3)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8).padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .leading).frame(height: height, alignment: .top)
                .background(color.opacity(0.13))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .padding(.leading, 60).padding(.trailing, 2)
            .offset(y: y)
        }
    }

    private func hourLabel(_ h: Int) -> String {
        let hr = h % 12 == 0 ? 12 : h % 12
        return "\(hr) \(h < 12 ? "AM" : "PM")"
    }
    private func hourMinute(_ date: Date) -> (h: Int, m: Int) {
        let cal = Cal.gregorian(tz)
        let c = cal.dateComponents([.hour, .minute], from: date)
        return (c.hour ?? 0, c.minute ?? 0)
    }
    private func dateAt(hour: Int) -> Date {
        let cal = Cal.gregorian(tz)
        let base = dayKeyToDate(selectedDay) ?? Date()
        return cal.date(bySettingHour: hour, minute: 0, second: 0, of: base) ?? base
    }
    /// Hour to scroll the day grid to: one before the first event, else 7 AM.
    private func dayScrollHour() -> Int {
        let starts = Agenda.forDay(filtered, day: selectedDay, tz: tz)
            .filter { !$0.allDay }.compactMap(\.startsAt)
        if let first = starts.min() { return max(0, hourMinute(first).h - 1) }
        return 7
    }
    private func stepDay(_ n: Int) {
        let cal = Cal.gregorian(tz)
        if let d = dayKeyToDate(selectedDay), let nd = cal.date(byAdding: .day, value: n, to: d) {
            withAnimation { selectedDay = EventTime.dayKey(nd, tz) }
        }
    }
    private func dayTitle(_ key: String) -> String {
        guard let d = dayKeyToDate(key) else { return key }
        return DateFmt.string(d, "EEE · MMM d", tz)
    }

    // MARK: helpers

    private func monthTitle(_ date: Date, year: Bool) -> String {
        return DateFmt.string(date, year ? "MMMM yyyy" : "MMMM", tz)
    }

    private func stepMonth(_ n: Int) {
        let cal = Cal.gregorian(tz)
        if let d = cal.date(byAdding: .month, value: n, to: monthAnchor) { withAnimation { monthAnchor = d } }
    }

    /// Horizontal flick on the grid → step month (month view) or day (day view). Ignored
    /// in agenda mode (a continuous list) and for predominantly-vertical drags.
    private func handleCalendarSwipe(_ value: DragGesture.Value) {
        let dx = value.translation.width, dy = value.translation.height
        guard abs(dx) > 50, abs(dx) > abs(dy) * 1.5 else { return }
        let forward = dx < 0   // swipe left = go forward (next)
        switch mode {
        case .month: stepMonth(forward ? 1 : -1)
        case .day:   stepDay(forward ? 1 : -1)
        case .agenda: break
        }
    }

    private func dayKeyToDate(_ key: String) -> Date? {
        return DateFmt.date(key, "yyyy-MM-dd", tz)
    }

    struct MonthCell { let key: String; let day: Int; let inMonth: Bool }

    /// 42 day-cells (6 weeks, Sunday-led) covering `anchor`'s month.
    private func monthCells(_ anchor: Date) -> [MonthCell] {
        let cal = Cal.gregorian(tz)
        let comps = cal.dateComponents([.year, .month], from: anchor)
        guard let first = cal.date(from: comps) else { return [] }
        let anchorMonth = cal.component(.month, from: first)
        let leading = cal.component(.weekday, from: first) - 1   // 1=Sun → 0 offset
        guard let start = cal.date(byAdding: .day, value: -leading, to: first) else { return [] }
        return (0..<42).compactMap { i in
            guard let d = cal.date(byAdding: .day, value: i, to: start) else { return nil }
            return MonthCell(key: EventTime.dayKey(d, tz), day: cal.component(.day, from: d),
                             inMonth: cal.component(.month, from: d) == anchorMonth)
        }
    }

    /// A day heading: serif relative label ("Today") + gray date ("Sat · May 31").
    @ViewBuilder private func dayHeading(_ key: String) -> some View {
        HStack(spacing: 8) {
            Text(relativeLabel(key)).font(WF.serif(20)).foregroundStyle(WF.ink)
            Text(dateLabel(key)).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
            Spacer()
        }
    }

    private func relativeLabel(_ key: String) -> String {
        let cal = Cal.gregorian(tz)
        let tomorrow = EventTime.dayKey(cal.date(byAdding: .day, value: 1, to: Date()) ?? Date(), tz)
        if key == Agenda.todayKey(tz) { return "Today" }
        if key == tomorrow { return "Tomorrow" }
        guard let d = dayKeyToDate(key) else { return key }
        return DateFmt.string(d, "EEEE", tz)
    }

    private func dateLabel(_ key: String) -> String {
        guard let d = dayKeyToDate(key) else { return "" }
        return DateFmt.string(d, "EEE · MMM d", tz)
    }
}

/// One agenda event as its own rounded card — time, owner color bar, title, owner
/// avatar — matching the mobile calendar mock.
struct EventCard: View {
    let event: SyncedEvent
    let tz: TimeZone
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                Text(timeText).font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink2)
                    .frame(width: 72, alignment: .leading)
                RoundedRectangle(cornerRadius: 99).fill(Color(hexString: event.colorHex) ?? WF.ink3)
                    .frame(width: 4, height: 34)
                Text(event.title).font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                Spacer(minLength: 8)
                if let emoji = event.emoji {
                    Avatar(colorHex: event.colorHex, emoji: emoji, size: 30)
                }
            }
            .padding(.horizontal, 15).padding(.vertical, 13)
            .frame(maxWidth: .infinity)
            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
            .wfShadow1()
            .contentShape(Rectangle())
            // Subtly fade events that have already finished, so the eye lands on what's
            // still ahead.
            .opacity(isPast ? 0.5 : 1)
        }
        .buttonStyle(.plain)
    }

    private var timeText: String {
        if event.allDay { return "All day" }
        if let d = event.startsAt { return EventTime.timeLabel(d, tz) }
        return ""
    }

    /// Has this event already ended? Shared with the Today agenda rows via `Agenda.isPast`.
    private var isPast: Bool { Agenda.isPast(event, tz) }
}

/// Shared empty-state for not-yet-built tabs — keeps the scaffold honest about
/// what's real vs. stubbed.
struct TabPlaceholder: View {
    let icon: String
    let title: String
    let note: String
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 40, weight: .regular))
                .foregroundStyle(WF.ink3)
            Text(title).font(WF.serif(26)).foregroundStyle(WF.ink)
            Text(note)
                .font(.system(size: 14)).foregroundStyle(WF.ink2)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(WF.canvas)
    }
}

/// Create or edit a calendar event — title, date, time + duration (or all-day),
/// participants, calendar (Google destination, create only), and location. Each
/// field is its own labeled card, mirroring the web EventModal. Writes to the
/// local PowerSync mirror (offline-first; uploads on reconnect).
struct EventEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(SyncManager.self) private var sync
    let event: SyncedEvent?
    let initialDate: Date

    /// The id to edit/delete against. A recurring occurrence's row id doesn't exist in
    /// the `events` table — it lives on the master, so we resolve through `seriesId`
    /// (an edit applies to the whole series; iOS has no per-occurrence scope dialog yet).
    /// For a single event `seriesId == id`, so this is a no-op there.
    private var editId: String? { event.map { $0.seriesId ?? $0.id } }

    @State private var title: String
    @State private var day: Date
    @State private var start: Date
    @State private var durationMin: Int
    @State private var allDay: Bool
    /// Waffled-owned "show a countdown" flag — surfaces this event in the countdowns list.
    @State private var isCountdown: Bool
    /// Ordered so the first one picked is the "owner" (drives the calendar list).
    @State private var participants: [String]
    @State private var location: String
    @State private var confirmDelete = false
    @State private var loadedParticipants = false
    /// The "Repeats" picker state. Built into an RRULE on save (recurring events go
    /// through REST — the local mirror can't expand a rule). Loaded from the master's
    /// rule when editing an existing recurring event.
    @State private var repeatState = RepeatState.none
    @State private var loadedRepeat = false
    /// The recurrence end condition (web parity). `never` repeats forever; `on` passes a
    /// hard end date (`recurrenceEndAt`); `after` rides a `COUNT=N` inside the rule.
    @State private var endMode: RepeatEnd = .never
    @State private var untilDate = Date().addingTimeInterval(60 * 60 * 24 * 90) // ~3 months out
    @State private var occurrenceCount = 10
    enum RepeatEnd { case never, on, after }
    /// When editing/deleting an already-recurring event, ask which occurrences to touch.
    @State private var scopePrompt: ScopePrompt?
    enum ScopePrompt { case save, delete }
    // Google calendar picker (create only).
    @State private var calendars: [WaffledAPI.CalendarLink] = []
    @State private var calendarId: String?
    @State private var calTouched = false
    // Goal linking, available on create AND edit (consistent picker). The PowerSync
    // events table has no goal columns, so a goal-linked save goes through the rich
    // REST route (POST on create, PATCH on edit) instead of the local mirror.
    let prefillGoalId: String?
    let prefillGoalStepId: String?
    let prefillParticipantIds: [String]?
    @State private var goalId: String?
    @State private var goalStepId: String?
    @State private var eligibleGoals: [WaffledAPI.Goal] = []
    @State private var goalSteps: [WaffledAPI.GoalDetail.Step] = []
    @State private var suggestion: WaffledAPI.GoalSuggestOne?
    @State private var suggesting = false
    @State private var suggestTask: Task<Void, Never>?
    // Auto-link: when memory is confident enough the goal is pre-filled; the note
    // stays until the person overrides the picker (mirrors the web's userTouchedGoal).
    @State private var autoLinkedId: String?
    @State private var userTouchedGoal = false
    @FocusState private var titleFocused: Bool

    private static let iso = ISO8601DateFormatter()
    private static let durations = [15, 30, 45, 60, 90, 120, 180, 240]

    init(event: SyncedEvent?, initialDate: Date, prefillGoalId: String? = nil,
         prefillGoalStepId: String? = nil, prefillParticipantIds: [String]? = nil) {
        self.event = event
        self.initialDate = initialDate
        self.prefillGoalId = prefillGoalId
        self.prefillGoalStepId = prefillGoalStepId
        self.prefillParticipantIds = prefillParticipantIds
        let cal = Cal.current
        // Create defaults to 5pm on the given day; edit uses the event's times.
        let startDate = event?.startsAt ?? (cal.date(bySettingHour: 17, minute: 0, second: 0, of: initialDate) ?? initialDate)
        let mins: Int = {
            guard let s = event?.startsAt, let e = event?.endsAt else { return 60 }
            return max(15, Int(e.timeIntervalSince(s) / 60))
        }()
        _title = State(initialValue: event?.title ?? "")
        _day = State(initialValue: startDate)
        _start = State(initialValue: startDate)
        _durationMin = State(initialValue: mins)
        _allDay = State(initialValue: event?.allDay ?? false)
        _isCountdown = State(initialValue: event?.isCountdown ?? false)
        _participants = State(initialValue: prefillParticipantIds ?? (event?.personId.map { [$0] } ?? []))
        _location = State(initialValue: event?.location ?? "")
        _goalId = State(initialValue: prefillGoalId)
        _goalStepId = State(initialValue: prefillGoalStepId)
    }

    private var editing: Bool { event != nil }
    private var canSave: Bool { !title.trimmingCharacters(in: .whitespaces).isEmpty }
    /// True when editing a materialized occurrence of a recurring series (the local
    /// mirror sets `occurrenceStart` only for those). Drives the scope chooser.
    private var wasRecurring: Bool { event?.occurrenceStart != nil }
    /// The chosen start instant (device tz) — used for the RRULE's default weekday /
    /// nth-weekday ordinal and the live "Repeats" summary.
    private var resolvedStart: Date {
        let cal = Cal.current
        return allDay ? (cal.date(bySettingHour: 12, minute: 0, second: 0, of: day) ?? day) : combine(day, start)
    }

    /// The owner (first family member who's a participant) drives the calendar list.
    private var primaryPerson: String? { participants.first }
    /// The owner's own writable calendars that sync (or are their ★ target).
    private var ownerCals: [WaffledAPI.CalendarLink] {
        guard let p = primaryPerson else { return [] }
        return calendars.filter { $0.isWritable && $0.personId == p && ($0.selected || $0.isWriteTarget) }
    }
    private var showCalendarPicker: Bool { !editing && ownerCals.count > 1 }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    group("Title") {
                        TextField("Soccer practice", text: $title)
                            .font(.system(size: 16, weight: .semibold)).textInputAutocapitalization(.sentences)
                            .focused($titleFocused)
                            .padding(.horizontal, 13).padding(.vertical, 11).innerField()
                    }

                    group("Date") {
                        DatePicker("", selection: $day, displayedComponents: .date)
                            .labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if !allDay {
                        HStack(spacing: 14) {
                            group("Time") {
                                DatePicker("", selection: $start, displayedComponents: .hourAndMinute)
                                    .labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                            }
                            group("Duration") {
                                Menu {
                                    ForEach(durationOptions, id: \.self) { m in
                                        Button(durationLabel(m)) { durationMin = m }
                                    }
                                } label: {
                                    HStack {
                                        Text(durationLabel(durationMin)).font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink)
                                        Spacer()
                                        Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                                    }
                                    .padding(.horizontal, 13).padding(.vertical, 11).innerField()
                                }
                            }
                        }
                    }

                    // All day — boxed grouping like the web, with a toggle.
                    Toggle(isOn: $allDay.animation()) {
                        Text("All day").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                    }
                    .tint(FamilyColor.wally.solid)
                    .padding(14).cardBox()

                    // Countdown flag — surfaces this event in the "N days until…" list.
                    Toggle(isOn: $isCountdown) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("⏳ Show a countdown").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                            Text("Build anticipation with “N days until…”").font(.system(size: 12)).foregroundStyle(WF.ink3)
                        }
                    }
                    .tint(FamilyColor.wally.solid)
                    .padding(14).cardBox()

                    repeatSection

                    group("Who") {
                        ChipFlow(spacing: 8, lineSpacing: 8) {
                            ForEach(sync.members) { m in
                                let on = participants.contains(m.id)
                                let c = Color(hexString: m.colorHex) ?? WF.ink3
                                Button {
                                    if let idx = participants.firstIndex(of: m.id) { participants.remove(at: idx) }
                                    else { participants.append(m.id) }
                                } label: {
                                    HStack(spacing: 7) {
                                        Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 24)
                                        Text(m.name).font(.system(size: 14, weight: .semibold))
                                            .foregroundStyle(on ? WF.ink : WF.ink2)
                                    }
                                    .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 6)
                                    .wfChip(selected: on, tint: c)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    goalSection

                    if showCalendarPicker {
                        group("Calendar") {
                            Menu {
                                ForEach(ownerCals) { c in
                                    Button { calendarId = c.id; calTouched = true } label: {
                                        Text("\(c.summary ?? "Calendar")\(c.isWriteTarget ? " ★" : "")")
                                    }
                                }
                            } label: {
                                HStack {
                                    let sel = ownerCals.first { $0.id == calendarId }
                                    Text("\(sel?.summary ?? "Choose…")\(sel?.isWriteTarget == true ? " ★" : "")")
                                        .font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                                    Spacer()
                                    Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                                }
                                .padding(.horizontal, 13).padding(.vertical, 11).innerField()
                            }
                        }
                    }

                    group("Location · optional") {
                        TextField("Field 3", text: $location)
                            .font(.system(size: 16, weight: .semibold))
                            .padding(.horizontal, 13).padding(.vertical, 11).innerField()
                    }

                    bottomBar.padding(.top, 6)
                }
                .padding(18)
            }
            .background(WF.canvas)
            .navigationTitle(editing ? "Edit event" : "New event")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task { await load() }
            .task {
                // Autofocus the title on a fresh event (small delay lets the sheet settle).
                if !editing { try? await Task.sleep(for: .milliseconds(350)); titleFocused = true }
            }
            .onChange(of: participants) { _, _ in recomputeDefaultCalendar(); clearOrphanGoal(); scheduleSuggest() }
            .onChange(of: title) { _, _ in scheduleSuggest() }
            .confirmationDialog(
                scopePrompt == .delete ? "Delete repeating event" : "Save repeating event",
                isPresented: Binding(get: { scopePrompt != nil }, set: { if !$0 { scopePrompt = nil } }),
                titleVisibility: .visible
            ) {
                let del = scopePrompt == .delete
                Button(del ? "This event" : "Save this event") { applyScope("this") }
                Button(del ? "This and all future events" : "Save this and all future events",
                       role: del ? .destructive : nil) { applyScope("following") }
                // "All events" (incl. past) is offered only for edits — needed to change
                // the recurrence rule — never for delete, so past events can't be wiped.
                if !del { Button("Save all events") { applyScope("all") } }
                Button("Cancel", role: .cancel) { scopePrompt = nil }
            } message: {
                Text(scopePrompt == .delete
                     ? "This is part of a repeating series."
                     : "Apply your changes to which occurrences?")
            }
        }
        .modifier(KioskSheetPresentation(kiosk: DeviceExperience.current == .kiosk))
    }

    private var bottomBar: some View {
        HStack(spacing: 14) {
            if editing {
                Button {
                    // Recurring events choose a scope; single events use tap-again confirm.
                    if wasRecurring { scopePrompt = .delete }
                    else if confirmDelete { performDelete(scope: nil); dismiss() }
                    else { withAnimation { confirmDelete = true } }
                } label: {
                    Text(confirmDelete && !wasRecurring ? "Tap again" : "Delete")
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.primary)
                }
                .buttonStyle(.plain)
            }
            WaffledPrimaryCTA(
                label: editing ? "Save" : "Add event",
                tint: WF.primary,
                isDisabled: !canSave,
                action: { save() }
            )
        }
    }

    // MARK: goal linking (create only)

    /// Calendar-opted goals whose participants include every chosen attendee.
    /// Empty until ≥1 attendee is picked (web: the picker is participant-gated, and
    /// an empty attendee set must NOT vacuously match every goal).
    private var eligibleGoalsForAttendees: [WaffledAPI.Goal] {
        guard !participants.isEmpty else { return [] }
        let att = Set(participants)
        return eligibleGoals.filter { g in
            g.autoFromCalendar
            && ["total", "count", "habit", "checklist"].contains(g.goalType)
            && att.isSubset(of: Set(g.participants.map(\.personId)))
        }
    }
    private var selectedGoal: WaffledAPI.Goal? { eligibleGoals.first { $0.id == goalId } }

    @ViewBuilder private var goalSection: some View {
        let options = eligibleGoalsForAttendees
        if let g = autoLinkedGoal { autoLinkedHint(g) }
        else if suggesting, goalId == nil { suggestingHint }
        else if let s = suggestion, goalId == nil { suggestionHint(s) }
        if !options.isEmpty || goalId != nil {
            group("Counts toward · optional") {
                Menu {
                    Button("No goal") { userTouchedGoal = true; autoLinkedId = nil; goalId = nil; goalStepId = nil; goalSteps = [] }
                    ForEach(options) { g in
                        Button("\(g.emoji.map { "\($0) " } ?? "")\(g.title)") { userTouchedGoal = true; selectGoal(g.id) }
                    }
                } label: {
                    HStack {
                        Text(goalMenuLabel).font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(goalId == nil ? WF.ink3 : WF.ink).lineLimit(1)
                        Spacer()
                        Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                    }
                    .padding(.horizontal, 13).padding(.vertical, 11).innerField()
                }
                if !goalSteps.isEmpty {
                    Menu {
                        Button("No specific step") { goalStepId = nil }
                        ForEach(goalSteps) { s in
                            Button("\(s.done ? "✓ " : "")\(s.label)") { goalStepId = s.id }
                        }
                    } label: {
                        HStack {
                            Text(stepMenuLabel).font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(goalStepId == nil ? WF.ink3 : WF.ink).lineLimit(1)
                            Spacer()
                            Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                        }
                        .padding(.horizontal, 13).padding(.vertical, 10).innerField()
                    }
                }
            }
        }
    }

    private var goalMenuLabel: String {
        guard let g = selectedGoal else { return "No goal" }
        return "\(g.emoji.map { "\($0) " } ?? "")\(g.title)"
    }
    private var stepMenuLabel: String {
        guard let id = goalStepId, let s = goalSteps.first(where: { $0.id == id }) else { return "Whole goal — no specific step" }
        return "Completes: \(s.label)"
    }

    /// The pre-linked goal to surface the "we've learned this" note — only while it's
    /// still the chosen goal and the person hasn't overridden the picker.
    private var autoLinkedGoal: WaffledAPI.Goal? {
        guard let id = autoLinkedId, goalId == id, !userTouchedGoal else { return nil }
        return eligibleGoals.first { $0.id == id }
    }

    /// Auto-link note: memory was confident, so the goal is pre-filled below.
    private func autoLinkedHint(_ g: WaffledAPI.Goal) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ai)
            Text("Auto-linked to \(g.emoji.map { "\($0) " } ?? "")\(g.title) — we've learned this. Change it below if needed.")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 6)
        }
        .padding(12)
        .background(WF.ai.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.ai.opacity(0.25), lineWidth: 1))
    }

    /// The web's "thinking" box, shown while the server matches a goal.
    private var suggestingHint: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ai)
            Text("Looking for a goal this counts toward…")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
            Spacer(minLength: 6)
            ProgressView().controlSize(.small).tint(WF.ai)
        }
        .padding(12)
        .background(WF.ai.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.ai.opacity(0.25), lineWidth: 1))
    }

    private func suggestionHint(_ s: WaffledAPI.GoalSuggestOne) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ai)
            Text("Looks like this counts toward \(s.goalEmoji.map { "\($0) " } ?? "")\(s.goalTitle)")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 6)
            Button("Link") { selectGoal(s.goalId) }.font(.system(size: 13, weight: .heavy)).foregroundStyle(WF.ai)
            Button { suggestion = nil } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
            }.buttonStyle(.plain)
        }
        .padding(12)
        .background(WF.ai.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.ai.opacity(0.25), lineWidth: 1))
    }

    private func selectGoal(_ id: String) {
        goalId = id; goalStepId = nil; suggestion = nil; suggesting = false; suggestTask?.cancel()
        Task { await loadSteps(for: id) }
    }

    /// Fetch a goal's checklist steps (empty for non-checklist goals).
    private func loadSteps(for id: String) async {
        goalSteps = (try? await WaffledAPI().goalDetail(id: id))?.steps ?? []
    }

    /// Drop a chosen goal that no longer fits the attendees (mirrors the web's
    /// orphan-clear). Guarded so an async-loading goal list can't wipe a prefill.
    private func clearOrphanGoal() {
        guard !eligibleGoals.isEmpty, let gid = goalId else { return }
        if !eligibleGoalsForAttendees.contains(where: { $0.id == gid }) {
            goalId = nil; goalStepId = nil; goalSteps = []; suggestion = nil; autoLinkedId = nil
        }
    }

    /// Debounced live goal match for the inline hint (create, no goal chosen yet) —
    /// only once attendees are chosen, so a suggestion never names people who aren't
    /// on the event. Server `suggest-one` runs memory → keyword → LLM.
    private func scheduleSuggest() {
        suggestTask?.cancel()
        let t = title.trimmingCharacters(in: .whitespaces)
        guard !editing, goalId == nil, !userTouchedGoal, !participants.isEmpty, t.count >= 3 else {
            suggestion = nil; suggesting = false; return
        }
        let ids = participants
        suggestion = nil
        suggesting = true
        suggestTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(600))
            if Task.isCancelled { return }
            let s = try? await WaffledAPI().suggestOne(title: t, participantIds: ids)
            if Task.isCancelled || goalId != nil || userTouchedGoal { return }
            suggesting = false
            if let s, s.auto == true {
                // Learned pattern — pre-link automatically; the note + picker let
                // the person unlink. (Web: an `auto` result overrides the chip.)
                suggestion = nil
                autoLinkedId = s.goalId
                goalId = s.goalId
                goalStepId = nil
                await loadSteps(for: s.goalId)
            } else {
                suggestion = s
            }
        }
    }

    // MARK: data

    private func load() async {
        if editing, !loadedParticipants {
            loadedParticipants = true
            let ids = await sync.eventParticipantIds(editId ?? event!.id)
            // Keep the owner (person_id) first, then any other participants.
            if !ids.isEmpty { participants = (participants + ids.filter { !participants.contains($0) }) }
        }
        if !editing, calendars.isEmpty {
            calendars = (try? await WaffledAPI().calendarLinks()) ?? []
            recomputeDefaultCalendar()
        }
        // Goals power the "Counts toward" picker on both create and edit.
        if eligibleGoals.isEmpty {
            eligibleGoals = (try? await WaffledAPI().goalsIn(listId: nil)) ?? []
        }
        if let gid = goalId, goalSteps.isEmpty { await loadSteps(for: gid) }
        // The local mirror doesn't carry the rule; load it from the master so the
        // "Repeats" picker reflects the current cadence when editing a recurring event.
        if wasRecurring, !loadedRepeat, let ev = event {
            loadedRepeat = true
            if let detail = try? await WaffledAPI().eventDetail(id: ev.seriesId ?? ev.id), let rule = detail.rrule {
                // COUNT rides in the rule; strip it before parsing the cadence, then
                // restore it as the "after N times" end condition (mirrors the web).
                if let n = Self.extractCount(rule) { endMode = .after; occurrenceCount = n }
                repeatState = Recurrence.parseRepeat(Self.stripCount(rule))
            }
        }
    }

    /// Pull the `COUNT=N` out of a stored rule (the end-condition picker owns it).
    private static func extractCount(_ rule: String) -> Int? {
        guard let r = rule.range(of: "COUNT=\\d+", options: .regularExpression) else { return nil }
        return Int(rule[r].dropFirst("COUNT=".count))
    }
    private static func stripCount(_ rule: String) -> String {
        rule.replacingOccurrences(of: ";?COUNT=\\d+", with: "", options: .regularExpression)
    }

    /// Default to the owner's ★ calendar (then any of theirs), until manually picked.
    private func recomputeDefaultCalendar() {
        guard !editing, !calTouched else { return }
        calendarId = (ownerCals.first { $0.isWriteTarget } ?? ownerCals.first)?.id
    }

    private var durationOptions: [Int] {
        Self.durations.contains(durationMin) ? Self.durations : (Self.durations + [durationMin]).sorted()
    }
    private func durationLabel(_ m: Int) -> String {
        if m < 60 { return "\(m) min" }
        let h = Double(m) / 60
        return h == h.rounded() ? "\(Int(h)) hr" : String(format: "%.1f hr", h)
    }

    // MARK: repeats picker

    private static let freqOptions: [RepeatFreq] = [.none, .daily, .weekdays, .weekly, .monthly, .custom]

    private func freqLabel(_ f: RepeatFreq) -> String {
        switch f {
        case .none: return "Does not repeat"
        case .daily: return "Daily"
        case .weekdays: return "Every weekday (Mon–Fri)"
        case .weekly: return "Weekly"
        case .monthly: return "Monthly"
        case .custom: return "Custom…"
        }
    }

    /// A live plain-English summary of the rule the picker currently builds, including
    /// the end condition (COUNT renders via `describeRrule`; an end date is appended).
    private var repeatSummary: String {
        let d = buildDraft()
        let base = Recurrence.describeRrule(d.rrule, start: resolvedStart)
        if endMode == .on, d.rrule != nil {
            return "\(base), until \(DateFmt.string(untilDate, "MMM d, yyyy", sync.householdTz))"
        }
        return base
    }

    @ViewBuilder private var repeatSection: some View {
        group("Repeats") {
            VStack(alignment: .leading, spacing: 12) {
                Menu {
                    ForEach(Self.freqOptions, id: \.self) { f in
                        Button(freqLabel(f)) { setFreq(f) }
                    }
                } label: {
                    HStack {
                        Text(freqLabel(repeatState.freq)).font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink)
                        Spacer()
                        Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                    }
                    .padding(.horizontal, 13).padding(.vertical, 11).innerField()
                }
                if repeatState.freq == .weekly { weekdayChips }
                if repeatState.freq == .custom { customBuilder }
                if repeatState.freq != .none {
                    endsRow
                    Text(repeatSummary).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                }
            }
        }
    }

    /// The end condition — Never · On a date · After N times. Mirrors the web's picker.
    private var endsRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text("Ends").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink2)
                Menu {
                    Button("Never") { endMode = .never }
                    Button("On a date") { endMode = .on }
                    Button("After…") { endMode = .after }
                } label: {
                    HStack(spacing: 5) {
                        Text(endModeLabel).font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink)
                        Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9).innerField()
                }
                Spacer(minLength: 0)
            }
            if endMode == .on {
                DatePicker("", selection: $untilDate, in: day..., displayedComponents: .date)
                    .labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
            }
            if endMode == .after {
                HStack(spacing: 10) {
                    Stepper(value: $occurrenceCount, in: 1...365) {
                        Text("\(occurrenceCount)").font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                    }
                    .fixedSize()
                    Text(occurrenceCount == 1 ? "occurrence" : "occurrences")
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink2)
                }
            }
        }
    }

    private var endModeLabel: String {
        switch endMode { case .never: return "Never"; case .on: return "On a date"; case .after: return "After N times" }
    }

    private func setFreq(_ f: RepeatFreq) {
        repeatState.freq = f
        // byday only applies to the weekly preset + custom-weekly; clear it otherwise so
        // the built rule (and summary) stay clean.
        if f != .weekly && f != .custom { repeatState.byday = [] }
    }

    /// The weekday set the picker is effectively using — an empty `byday` means "the
    /// event's own weekday" (what `buildRrule` defaults to).
    private var effectiveByday: [String] {
        repeatState.byday.isEmpty ? [Recurrence.weekdayCode(resolvedStart)] : repeatState.byday
    }

    private func toggleWeekday(_ code: String) {
        var days = Set(effectiveByday)
        if days.contains(code) { if days.count > 1 { days.remove(code) } } // keep ≥1
        else { days.insert(code) }
        repeatState.byday = Recurrence.weekdays.filter { days.contains($0) }
    }

    private var weekdayChips: some View {
        let current = effectiveByday
        return HStack(spacing: 6) {
            ForEach(Recurrence.weekdays, id: \.self) { code in
                let on = current.contains(code)
                Button { toggleWeekday(code) } label: {
                    Text(Self.chipDay[code] ?? code)
                        .font(.system(size: 13, weight: .bold))
                        .frame(width: 38, height: 36)
                        .wfChip(selected: on, tint: FamilyColor.wally.solid)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private static let chipDay = ["SU": "Su", "MO": "Mo", "TU": "Tu", "WE": "We", "TH": "Th", "FR": "Fr", "SA": "Sa"]

    private func unitLabel(_ u: CustomUnit, plural: Bool) -> String {
        let base: String
        switch u { case .day: base = "day"; case .week: base = "week"; case .month: base = "month"; case .year: base = "year" }
        return plural ? base + "s" : base
    }

    private var customBuilder: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Text("Every").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink2)
                Stepper(value: $repeatState.interval, in: 1...99) {
                    Text("\(repeatState.interval)").font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                }
                .fixedSize()
                Menu {
                    ForEach(CustomUnit.allCases, id: \.self) { u in
                        Button(unitLabel(u, plural: repeatState.interval != 1)) { repeatState.unit = u }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text(unitLabel(repeatState.unit, plural: repeatState.interval != 1))
                            .font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink)
                        Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9).innerField()
                }
            }
            if repeatState.unit == .week { weekdayChips }
            if repeatState.unit == .month { monthlyModeMenu }
        }
    }

    /// Ordinals offered for "the Nth <weekday> of the month": 1…5 and -1 (last).
    private static let monthlyOrdinals = [1, 2, 3, 4, 5, -1]
    private static let ordinalWord = ["", "first", "second", "third", "fourth", "fifth"]

    private func ordinalWord(_ n: Int) -> String {
        n == -1 ? "last" : (Self.ordinalWord.indices.contains(n) ? Self.ordinalWord[n] : "\(n)th")
    }

    private var monthlyModeMenu: some View {
        // Deliberately gregorian: this day-of-month drives the RRULE BYMONTHDAY, which is
        // gregorian by spec — so it must match the rule we emit, not the device's calendar
        // system (Islamic/Hebrew). `Cal.current` is correct here, not `Calendar.current`.
        let dom = Cal.current.component(.day, from: resolvedStart)
        let weekdayName = DateFmt.string(resolvedStart, "EEEE", sync.householdTz)
        let dayLabel = "On day \(dom)"
        func nthLabel(_ ord: Int) -> String { "On the \(ordinalWord(ord)) \(weekdayName)" }
        let current = repeatState.monthlyMode == .dayOfMonth ? dayLabel : nthLabel(repeatState.monthlyOrdinal)
        return Menu {
            Button(dayLabel) { repeatState.monthlyMode = .dayOfMonth }
            ForEach(Self.monthlyOrdinals, id: \.self) { ord in
                Button(nthLabel(ord)) { repeatState.monthlyMode = .nthWeekday; repeatState.monthlyOrdinal = ord }
            }
        } label: {
            HStack {
                Text(current).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                Spacer()
                Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
            }
            .padding(.horizontal, 12).padding(.vertical, 9).innerField()
        }
    }

    /// The resolved field values for a save — recomputed deterministically so both the
    /// direct save and the scope-chooser path build the same payload.
    private struct Draft {
        let startISO: String, endISO: String?, name: String, loc: String?
        let ids: [String], chosenCal: String?, rrule: String?, recurrenceEndAt: String?
    }

    private func buildDraft() -> Draft {
        let startDate = resolvedStart
        let startISO = Self.iso.string(from: startDate)
        let endISO = allDay ? nil : Self.iso.string(from: startDate.addingTimeInterval(Double(durationMin) * 60))
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedLoc = location.trimmingCharacters(in: .whitespaces)
        // The cadence rule; the end condition is layered on (COUNT in the rule, an end
        // date passed separately) the same way the web composes it.
        let base = Recurrence.buildRrule(repeatState, start: startDate)
        var rrule = base
        var recurrenceEndAt: String?
        if let base {
            if endMode == .after, occurrenceCount > 0 { rrule = "\(base);COUNT=\(occurrenceCount)" }
            else if endMode == .on {
                let cal = Cal.current
                let endOfDay = cal.date(bySettingHour: 23, minute: 59, second: 0, of: untilDate) ?? untilDate
                recurrenceEndAt = Self.iso.string(from: endOfDay)
            }
        }
        return Draft(
            startISO: startISO, endISO: endISO, name: name,
            loc: trimmedLoc.isEmpty ? nil : trimmedLoc,
            ids: Array(participants),
            chosenCal: showCalendarPicker ? calendarId : nil,
            rrule: rrule, recurrenceEndAt: recurrenceEndAt)
    }

    private func save() {
        // Editing an already-recurring event first asks which occurrences to change.
        if wasRecurring { scopePrompt = .save; return }
        performSave(scope: nil)
        // performSave dismisses once the write lands, so the detail screen's reload
        // (on our dismiss) sees fresh data instead of racing the in-flight write.
    }

    /// The scope chooser picked an option — run the right action; it dismisses when done.
    private func applyScope(_ scope: String) {
        let mode = scopePrompt
        scopePrompt = nil
        if mode == .delete { performDelete(scope: scope) } else { performSave(scope: scope) }
    }

    private func performSave(scope: String?) {
        let d = buildDraft()
        let tz = sync.householdTz.identifier
        Task {
            if let editId {
                if wasRecurring {
                    // Recurring edit through REST (server-materialized). 'this'/'following'
                    // change only the occurrence's own fields; 'all' also rewrites the rule
                    // (or clears it, turning the series back into a single event).
                    let isAll = scope == "all"
                    try? await WaffledAPI().updateEvent(
                        id: editId, title: d.name, startsAtISO: d.startISO, endsAtISO: d.endISO,
                        allDay: allDay, location: d.loc, personIds: d.ids,
                        goalId: goalId, goalStepId: goalStepId,
                        rrule: isAll ? d.rrule : nil, clearRrule: isAll && d.rrule == nil,
                        recurrenceEndAt: isAll ? d.recurrenceEndAt : nil,
                        scope: scope, occurrenceStart: event?.occurrenceStart, isCountdown: isCountdown)
                    sync.touchGoals()
                } else if let rrule = d.rrule {
                    // A single event being made recurring — promote in place (no scope),
                    // routed through REST so the server materializes the occurrences.
                    try? await WaffledAPI().updateEvent(
                        id: editId, title: d.name, startsAtISO: d.startISO, endsAtISO: d.endISO,
                        allDay: allDay, location: d.loc, personIds: d.ids,
                        goalId: goalId, goalStepId: goalStepId, rrule: rrule,
                        recurrenceEndAt: d.recurrenceEndAt, isCountdown: isCountdown)
                    sync.touchGoals()
                } else if goalId != nil || prefillGoalId != nil {
                    // A goal link was set, changed, or removed → PATCH the rich REST
                    // route (the local mirror has no goal columns); PowerSync re-syncs.
                    try? await WaffledAPI().updateEvent(
                        id: editId, title: d.name, startsAtISO: d.startISO, endsAtISO: d.endISO,
                        allDay: allDay, location: d.loc, personIds: d.ids, goalId: goalId, goalStepId: goalStepId,
                        isCountdown: isCountdown)
                    sync.touchGoals()
                } else {
                    _ = await sync.updateEvent(id: editId, title: d.name, startsAtISO: d.startISO,
                                               endsAtISO: d.endISO, allDay: allDay, location: d.loc, personIds: d.ids,
                                               isCountdown: isCountdown)
                }
            } else if d.rrule != nil || goalId != nil {
                // Recurring and/or goal-linked create goes through the rich REST route
                // (the local events table has no goal columns and can't expand a rule);
                // PowerSync down-syncs the master + materialized occurrences.
                _ = try? await WaffledAPI().createEvent(
                    title: d.name, startsAtISO: d.startISO, endsAtISO: d.endISO, allDay: allDay,
                    location: d.loc, personIds: d.ids, goalId: goalId, goalStepId: goalStepId,
                    calendarId: d.chosenCal, timezone: tz, rrule: d.rrule, recurrenceEndAt: d.recurrenceEndAt,
                    isCountdown: isCountdown)
                if goalId != nil { sync.touchGoals() }
            } else {
                _ = await sync.createCalendarEvent(title: d.name, startsAtISO: d.startISO, endsAtISO: d.endISO,
                                                   allDay: allDay, location: d.loc, personIds: d.ids, calendarId: d.chosenCal,
                                                   isCountdown: isCountdown)
            }
            dismiss()   // after the write, so the caller's reload picks up fresh data
        }
    }

    private func performDelete(scope: String?) {
        guard let id = editId else { return }
        Task {
            if wasRecurring {
                // 'this' cancels one occurrence, 'following' caps the series, 'all' (or
                // nil) drops the whole series — all server-side over REST.
                try? await WaffledAPI().deleteEvent(id: id, scope: scope, occurrenceStart: event?.occurrenceStart)
                sync.touchGoals()
            } else {
                _ = await sync.deleteEvent(id: id)
            }
            dismiss()
        }
    }

    /// Combine a date's Y/M/D with a time's H/M into one instant (device tz).
    private func combine(_ dayDate: Date, _ time: Date) -> Date {
        let cal = Cal.current
        let d = cal.dateComponents([.year, .month, .day], from: dayDate)
        let t = cal.dateComponents([.hour, .minute], from: time)
        return cal.date(from: DateComponents(year: d.year, month: d.month, day: d.day, hour: t.hour, minute: t.minute)) ?? dayDate
    }

    /// A labeled field card (label top-left, content below) — the web's panel look.
    private func group<V: View>(_ label: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(label).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
            content()
        }
        .padding(14).cardBox()
    }
}

private extension View {
    /// The outer card-group chrome (white box on the tan sheet, hairline border).
    func cardBox() -> some View {
        frame(maxWidth: .infinity, alignment: .leading).wfField()
    }
    /// The inner input chrome (white, hairline border) — sits on the white box.
    func innerField() -> some View {
        frame(maxWidth: .infinity, alignment: .leading).wfField(radius: WF.rSM)
    }
}

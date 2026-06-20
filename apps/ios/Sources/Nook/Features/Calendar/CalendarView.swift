import SwiftUI

/// Calendar tab — an upcoming-agenda list grouped by day, read live from the
/// local mirror. (A month grid can follow; the agenda is the high-value first cut
/// and exercises the same synced data as Today.)
struct CalendarView: View {
    @Environment(SyncManager.self) private var sync
    @State private var editing: EventEditTarget?
    /// Tapping an event opens its full detail (the editor is reached from there).
    @State private var detailEvent: SyncedEvent?
    /// Remembered across tab switches + launches, so your preferred view sticks.
    @AppStorage("nook.calendarMode") private var mode: CalMode = .agenda
    @State private var filterPerson: String?       // nil = Everyone
    @State private var monthAnchor = Date()         // the month the grid shows
    @State private var selectedDay = Agenda.todayKey(TimeZone.current)
    @State private var showCapture = false
    @State private var dictateOnOpen = false

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
            }
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

    // MARK: header (month title + view toggle + add)

    private var header: some View {
        HStack(spacing: 12) {
            switch mode {
            case .agenda:
                Text(monthTitle(Date(), year: false)).font(NK.serif(30)).foregroundStyle(NK.ink)
            case .month:
                Button { stepMonth(-1) } label: { chevron("chevron.left") }
                Text(monthTitle(monthAnchor, year: true)).font(NK.serif(24)).foregroundStyle(NK.ink).lineLimit(1)
                Button { stepMonth(1) } label: { chevron("chevron.right") }
            case .day:
                Button { stepDay(-1) } label: { chevron("chevron.left") }
                Text(dayTitle(selectedDay)).font(NK.serif(22)).foregroundStyle(NK.ink).lineLimit(1)
                Button { stepDay(1) } label: { chevron("chevron.right") }
            }
            Spacer()
            Menu {
                ForEach(CalMode.allCases, id: \.self) { m in
                    Button { withAnimation { mode = m } } label: { Label(m.label, systemImage: m.icon) }
                }
            } label: {
                Image(systemName: mode.icon)
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink2)
                    .frame(width: 38, height: 38).background(NK.card).clipShape(Circle())
                    .overlay(Circle().strokeBorder(NK.hair, lineWidth: 1))
            }
            Button { editing = .new(mode == .agenda ? Date() : (dayKeyToDate(selectedDay) ?? Date())) } label: {
                Image(systemName: "plus").font(.system(size: 18, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 38, height: 38).background(NK.primary).clipShape(Circle())
            }
            .buttonStyle(.plain)
        }
    }

    private func chevron(_ s: String) -> some View {
        Image(systemName: s).font(.system(size: 13, weight: .heavy)).foregroundStyle(NK.ink2)
            .frame(width: 30, height: 30).background(NK.card).clipShape(Circle())
            .overlay(Circle().strokeBorder(NK.hair, lineWidth: 1))
    }

    // MARK: agenda

    @ViewBuilder private var agendaContent: some View {
        AICaptureBar(placeholder: "Add an event…",
                     onTap: { dictateOnOpen = false; showCapture = true },
                     onMic: { dictateOnOpen = true; showCapture = true })
        personFilter
        if groups.isEmpty {
            VStack(spacing: 10) {
                Image(systemName: "calendar").font(.system(size: 34)).foregroundStyle(NK.ink3)
                Text(filterPerson == nil ? "No upcoming events." : "Nothing for them coming up.")
                    .font(.system(size: 14)).foregroundStyle(NK.ink2)
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
                        .foregroundStyle(on ? .white : NK.ink2)
                        .frame(width: 24, height: 24)
                        .background(on ? Color.white.opacity(0.22) : NK.panel).clipShape(Circle())
                }
                Text(label).font(.system(size: 14, weight: .bold))
                    .foregroundStyle(on ? .white : NK.ink2)
            }
            .padding(.leading, 6).padding(.trailing, 14).padding(.vertical, 7)
            .background(on ? NK.ink : NK.card)
            .overlay(Capsule().strokeBorder(on ? Color.clear : NK.hair, lineWidth: 1))
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
                    Text(d).font(.system(size: 11, weight: .heavy)).foregroundStyle(NK.ink3)
                        .frame(maxWidth: .infinity)
                }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 7), spacing: 4) {
                ForEach(cells, id: \.key) { cell in monthCell(cell) }
            }
        }
        .padding(12)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))

        dayHeading(selectedDay).padding(.top, 6)
        let dayItems = Agenda.forDay(filtered, day: selectedDay, tz: tz)
        if dayItems.isEmpty {
            Button { editing = .new(dayKeyToDate(selectedDay) ?? Date()) } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus").font(.system(size: 12, weight: .heavy))
                    Text("Add an event").font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(NK.ink3).padding(.vertical, 10)
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
                    .foregroundStyle(cell.inMonth ? (isToday ? NK.primary : NK.ink) : NK.ink3.opacity(0.5))
                HStack(spacing: 2) {
                    ForEach(Array(dotColors(cell.key).prefix(3).enumerated()), id: \.offset) { _, hex in
                        Circle().fill(Color(hexString: hex) ?? NK.ink3).frame(width: 5, height: 5)
                    }
                }
                .frame(height: 5)
            }
            .frame(maxWidth: .infinity).frame(height: 44)
            .background(isSelected ? NK.primary.opacity(0.12) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(isSelected ? NK.primary : Color.clear, lineWidth: 1.5))
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
                                .foregroundStyle(NK.ink3).frame(width: 48, alignment: .trailing)
                            Rectangle().fill(NK.hair).frame(height: 1)
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
        }
        .padding(.top, 2)
    }

    @ViewBuilder private func dayBlock(_ ev: SyncedEvent) -> some View {
        if let start = ev.startsAt {
            let comps = hourMinute(start)
            let y = (CGFloat(comps.h) + CGFloat(comps.m) / 60) * Self.hourHeight
            let durMin = ev.endsAt.map { max(30, $0.timeIntervalSince(start) / 60) } ?? 60
            let height = max(30, CGFloat(durMin) / 60 * Self.hourHeight - 4)
            let color = Color(hexString: ev.colorHex) ?? NK.ink3
            Button { detailEvent = ev } label: {
                HStack(spacing: 7) {
                    RoundedRectangle(cornerRadius: 99).fill(color).frame(width: 3)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(ev.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                        if height > 40 {
                            Text(EventTime.timeLabel(start, tz)).font(.system(size: 10.5, weight: .medium)).foregroundStyle(NK.ink3)
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
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        let c = cal.dateComponents([.hour, .minute], from: date)
        return (c.hour ?? 0, c.minute ?? 0)
    }
    private func dateAt(hour: Int) -> Date {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
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
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        if let d = dayKeyToDate(selectedDay), let nd = cal.date(byAdding: .day, value: n, to: d) {
            withAnimation { selectedDay = EventTime.dayKey(nd, tz) }
        }
    }
    private func dayTitle(_ key: String) -> String {
        guard let d = dayKeyToDate(key) else { return key }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US"); f.timeZone = tz; f.dateFormat = "EEE · MMM d"
        return f.string(from: d)
    }

    // MARK: helpers

    private func monthTitle(_ date: Date, year: Bool) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US"); f.timeZone = tz
        f.dateFormat = year ? "MMMM yyyy" : "MMMM"
        return f.string(from: date)
    }

    private func stepMonth(_ n: Int) {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        if let d = cal.date(byAdding: .month, value: n, to: monthAnchor) { withAnimation { monthAnchor = d } }
    }

    private func dayKeyToDate(_ key: String) -> Date? {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = tz; f.dateFormat = "yyyy-MM-dd"
        return f.date(from: key)
    }

    struct MonthCell { let key: String; let day: Int; let inMonth: Bool }

    /// 42 day-cells (6 weeks, Sunday-led) covering `anchor`'s month.
    private func monthCells(_ anchor: Date) -> [MonthCell] {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
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
            Text(relativeLabel(key)).font(NK.serif(20)).foregroundStyle(NK.ink)
            Text(dateLabel(key)).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
            Spacer()
        }
    }

    private func relativeLabel(_ key: String) -> String {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        let tomorrow = EventTime.dayKey(cal.date(byAdding: .day, value: 1, to: Date()) ?? Date(), tz)
        if key == Agenda.todayKey(tz) { return "Today" }
        if key == tomorrow { return "Tomorrow" }
        guard let d = dayKeyToDate(key) else { return key }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US"); f.timeZone = tz; f.dateFormat = "EEEE"
        return f.string(from: d)
    }

    private func dateLabel(_ key: String) -> String {
        guard let d = dayKeyToDate(key) else { return "" }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US"); f.timeZone = tz; f.dateFormat = "EEE · MMM d"
        return f.string(from: d)
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
                Text(timeText).font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink2)
                    .frame(width: 72, alignment: .leading)
                RoundedRectangle(cornerRadius: 99).fill(Color(hexString: event.colorHex) ?? NK.ink3)
                    .frame(width: 4, height: 34)
                Text(event.title).font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                Spacer(minLength: 8)
                if let emoji = event.emoji {
                    Avatar(colorHex: event.colorHex, emoji: emoji, size: 30)
                }
            }
            .padding(.horizontal, 15).padding(.vertical, 13)
            .frame(maxWidth: .infinity)
            .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
            .nkShadow1()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var timeText: String {
        if event.allDay { return "All day" }
        if let d = event.startsAt { return EventTime.timeLabel(d, tz) }
        return ""
    }
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
                .foregroundStyle(NK.ink3)
            Text(title).font(NK.serif(26)).foregroundStyle(NK.ink)
            Text(note)
                .font(.system(size: 14)).foregroundStyle(NK.ink2)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(NK.canvas)
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

    @State private var title: String
    @State private var day: Date
    @State private var start: Date
    @State private var durationMin: Int
    @State private var allDay: Bool
    /// Ordered so the first one picked is the "owner" (drives the calendar list).
    @State private var participants: [String]
    @State private var location: String
    @State private var confirmDelete = false
    @State private var loadedParticipants = false
    // Google calendar picker (create only).
    @State private var calendars: [NookAPI.CalendarLink] = []
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
    @State private var eligibleGoals: [NookAPI.Goal] = []
    @State private var goalSteps: [NookAPI.GoalDetail.Step] = []
    @State private var suggestion: NookAPI.GoalSuggestOne?
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
        let cal = Calendar.current
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
        _participants = State(initialValue: prefillParticipantIds ?? (event?.personId.map { [$0] } ?? []))
        _location = State(initialValue: event?.location ?? "")
        _goalId = State(initialValue: prefillGoalId)
        _goalStepId = State(initialValue: prefillGoalStepId)
    }

    private var editing: Bool { event != nil }
    private var canSave: Bool { !title.trimmingCharacters(in: .whitespaces).isEmpty }

    /// The owner (first family member who's a participant) drives the calendar list.
    private var primaryPerson: String? { participants.first }
    /// The owner's own writable calendars that sync (or are their ★ target).
    private var ownerCals: [NookAPI.CalendarLink] {
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
                                        Text(durationLabel(durationMin)).font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink)
                                        Spacer()
                                        Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
                                    }
                                    .padding(.horizontal, 13).padding(.vertical, 11).innerField()
                                }
                            }
                        }
                    }

                    // All day — boxed grouping like the web, with a toggle.
                    Toggle(isOn: $allDay.animation()) {
                        Text("All day").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                    }
                    .tint(FamilyColor.wally.solid)
                    .padding(14).cardBox()

                    group("Who") {
                        ChipFlow(spacing: 8, lineSpacing: 8) {
                            ForEach(sync.members) { m in
                                let on = participants.contains(m.id)
                                let c = Color(hexString: m.colorHex) ?? NK.ink3
                                Button {
                                    if let idx = participants.firstIndex(of: m.id) { participants.remove(at: idx) }
                                    else { participants.append(m.id) }
                                } label: {
                                    HStack(spacing: 7) {
                                        Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 24)
                                        Text(m.name).font(.system(size: 14, weight: .semibold))
                                            .foregroundStyle(on ? NK.ink : NK.ink2)
                                    }
                                    .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 6)
                                    .nkChip(selected: on, tint: c)
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
                                        .font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                                    Spacer()
                                    Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
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
            .background(NK.canvas)
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
        }
        .presentationDetents([.large])
    }

    private var bottomBar: some View {
        HStack(spacing: 14) {
            if editing {
                Button {
                    if confirmDelete { Task { _ = await sync.deleteEvent(id: event!.id) }; dismiss() }
                    else { withAnimation { confirmDelete = true } }
                } label: {
                    Text(confirmDelete ? "Tap again" : "Delete")
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(NK.primary)
                }
                .buttonStyle(.plain)
            }
            Button { save() } label: {
                Text(editing ? "Save" : "Add event")
                    .font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                    .background(canSave ? NK.primary : NK.primary.opacity(0.4))
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain).disabled(!canSave)
        }
    }

    // MARK: goal linking (create only)

    /// Calendar-opted goals whose participants include every chosen attendee.
    /// Empty until ≥1 attendee is picked (web: the picker is participant-gated, and
    /// an empty attendee set must NOT vacuously match every goal).
    private var eligibleGoalsForAttendees: [NookAPI.Goal] {
        guard !participants.isEmpty else { return [] }
        let att = Set(participants)
        return eligibleGoals.filter { g in
            g.autoFromCalendar
            && ["total", "count", "habit", "checklist"].contains(g.goalType)
            && att.isSubset(of: Set(g.participants.map(\.personId)))
        }
    }
    private var selectedGoal: NookAPI.Goal? { eligibleGoals.first { $0.id == goalId } }

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
                            .foregroundStyle(goalId == nil ? NK.ink3 : NK.ink).lineLimit(1)
                        Spacer()
                        Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
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
                                .foregroundStyle(goalStepId == nil ? NK.ink3 : NK.ink).lineLimit(1)
                            Spacer()
                            Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
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
    private var autoLinkedGoal: NookAPI.Goal? {
        guard let id = autoLinkedId, goalId == id, !userTouchedGoal else { return nil }
        return eligibleGoals.first { $0.id == id }
    }

    /// Auto-link note: memory was confident, so the goal is pre-filled below.
    private func autoLinkedHint(_ g: NookAPI.Goal) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ai)
            Text("Auto-linked to \(g.emoji.map { "\($0) " } ?? "")\(g.title) — we've learned this. Change it below if needed.")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 6)
        }
        .padding(12)
        .background(NK.ai.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.ai.opacity(0.25), lineWidth: 1))
    }

    /// The web's "thinking" box, shown while the server matches a goal.
    private var suggestingHint: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ai)
            Text("Looking for a goal this counts toward…")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink2)
            Spacer(minLength: 6)
            ProgressView().controlSize(.small).tint(NK.ai)
        }
        .padding(12)
        .background(NK.ai.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.ai.opacity(0.25), lineWidth: 1))
    }

    private func suggestionHint(_ s: NookAPI.GoalSuggestOne) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ai)
            Text("Looks like this counts toward \(s.goalEmoji.map { "\($0) " } ?? "")\(s.goalTitle)")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink2).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 6)
            Button("Link") { selectGoal(s.goalId) }.font(.system(size: 13, weight: .heavy)).foregroundStyle(NK.ai)
            Button { suggestion = nil } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink3)
            }.buttonStyle(.plain)
        }
        .padding(12)
        .background(NK.ai.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.ai.opacity(0.25), lineWidth: 1))
    }

    private func selectGoal(_ id: String) {
        goalId = id; goalStepId = nil; suggestion = nil; suggesting = false; suggestTask?.cancel()
        Task { await loadSteps(for: id) }
    }

    /// Fetch a goal's checklist steps (empty for non-checklist goals).
    private func loadSteps(for id: String) async {
        goalSteps = (try? await NookAPI().goalDetail(id: id))?.steps ?? []
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
            let s = try? await NookAPI().suggestOne(title: t, participantIds: ids)
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
            let ids = await sync.eventParticipantIds(event!.id)
            // Keep the owner (person_id) first, then any other participants.
            if !ids.isEmpty { participants = (participants + ids.filter { !participants.contains($0) }) }
        }
        if !editing, calendars.isEmpty {
            calendars = (try? await NookAPI().calendarLinks()) ?? []
            recomputeDefaultCalendar()
        }
        // Goals power the "Counts toward" picker on both create and edit.
        if eligibleGoals.isEmpty {
            eligibleGoals = (try? await NookAPI().goalsIn(listId: nil)) ?? []
        }
        if let gid = goalId, goalSteps.isEmpty { await loadSteps(for: gid) }
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

    private func save() {
        let cal = Calendar.current
        let startDate = allDay
            ? (cal.date(bySettingHour: 12, minute: 0, second: 0, of: day) ?? day)
            : combine(day, start)
        let startISO = Self.iso.string(from: startDate)
        let endISO = allDay ? nil : Self.iso.string(from: startDate.addingTimeInterval(Double(durationMin) * 60))
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let loc = location.trimmingCharacters(in: .whitespaces).isEmpty ? nil : location.trimmingCharacters(in: .whitespaces)
        let ids = Array(participants)
        let chosenCal = showCalendarPicker ? calendarId : nil
        Task {
            if let event {
                if goalId != nil || prefillGoalId != nil {
                    // A goal link was set, changed, or removed → PATCH the rich REST
                    // route (the local mirror has no goal columns); PowerSync re-syncs.
                    _ = try? await NookAPI().updateEvent(
                        id: event.id, title: name, startsAtISO: startISO, endsAtISO: endISO,
                        allDay: allDay, location: loc, personIds: ids, goalId: goalId, goalStepId: goalStepId)
                    sync.touchGoals()
                } else {
                    _ = await sync.updateEvent(id: event.id, title: name, startsAtISO: startISO,
                                               endsAtISO: endISO, allDay: allDay, location: loc, personIds: ids)
                }
            } else if let gid = goalId {
                // Goal-linked create goes through the rich REST route (the local
                // events table has no goal columns); PowerSync down-syncs it back.
                _ = try? await NookAPI().createEvent(
                    title: name, startsAtISO: startISO, endsAtISO: endISO, allDay: allDay,
                    location: loc, personIds: ids, goalId: gid, goalStepId: goalStepId,
                    calendarId: chosenCal, timezone: sync.householdTz.identifier)
                sync.touchGoals()
            } else {
                _ = await sync.createCalendarEvent(title: name, startsAtISO: startISO, endsAtISO: endISO,
                                                   allDay: allDay, location: loc, personIds: ids, calendarId: chosenCal)
            }
        }
        dismiss()
    }

    /// Combine a date's Y/M/D with a time's H/M into one instant (device tz).
    private func combine(_ dayDate: Date, _ time: Date) -> Date {
        let cal = Calendar.current
        let d = cal.dateComponents([.year, .month, .day], from: dayDate)
        let t = cal.dateComponents([.hour, .minute], from: time)
        return cal.date(from: DateComponents(year: d.year, month: d.month, day: d.day, hour: t.hour, minute: t.minute)) ?? dayDate
    }

    /// A labeled field card (label top-left, content below) — the web's panel look.
    private func group<V: View>(_ label: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(label).font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink2)
            content()
        }
        .padding(14).cardBox()
    }
}

private extension View {
    /// The outer card-group chrome (white box on the tan sheet, hairline border).
    func cardBox() -> some View {
        frame(maxWidth: .infinity, alignment: .leading).nkField()
    }
    /// The inner input chrome (white, hairline border) — sits on the white box.
    func innerField() -> some View {
        frame(maxWidth: .infinity, alignment: .leading).nkField(radius: NK.rSM)
    }
}

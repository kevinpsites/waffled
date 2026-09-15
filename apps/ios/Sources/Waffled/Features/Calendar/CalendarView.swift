import SwiftUI

/// Calendar tab on iPhone: Month is home, a tapped day pushes Day, and the header's view menu
/// (or a pinch) switches between Month, Week, Day and Agenda — Agenda carries the AI capture
/// bar. Screens live in `PhoneCalendarViews.swift`; see docs/product/ios-calendar-redesign.md.
struct CalendarView: View {
    typealias CalMode = PhoneCalendar.Mode

    @Environment(SyncManager.self) private var sync
    /// A reminder tap routes here with the event id to open (see AppRoot).
    var openEventId: Binding<String?> = .constant(nil)
    @State private var editing: EventEditTarget?
    @State private var detailEvent: SyncedEvent?
    /// Remembered across tab switches + launches, so your preferred view sticks.
    @AppStorage("waffled.calendarMode") private var storedMode: CalMode = .month
    /// The screen under a pushed Day: Month, Week or Agenda.
    @State private var root: CalMode = .month
    @State private var showsDay = false
    @State private var restoredMode = false
    @State private var filterPerson: String?       // nil = Everyone
    @State private var monthAnchor = Date()         // the month the grid shows
    @State private var selectedDay = Agenda.todayKey(TimeZone.current)
    @State private var showCapture = false
    @State private var dictateOnOpen = false
    @State private var countdowns = CountdownsModel()
    @State private var editingCountdown: WaffledAPI.Countdown?

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
    /// The household's first day of the week. Sunday until the setting reaches this device.
    private var firstDay: HouseholdWeekStart { sync.householdWeekStart ?? .sunday }
    private var mode: CalMode { showsDay ? .day : root }
    /// Day → events for the grids: the index `SyncManager` keeps, narrowed by the person filter.
    private var dayIndex: [String: [SyncedEvent]] {
        Agenda.filtered(byDay: sync.eventsByDay, person: filterPerson)
    }
    private var groups: [(day: String, items: [SyncedEvent])] {
        Agenda.upcoming(byDay: dayIndex, from: Agenda.todayKey(tz))
    }
    /// Agenda day keys = event days ∪ countdown days (today forward), so a countdown-only day shows.
    private var agendaDays: [String] {
        let todayKey = Agenda.todayKey(tz)
        var days = Set(groups.map { $0.day })
        for day in countdowns.byDate.keys where day >= todayKey { days.insert(day) }
        return days.sorted()
    }

    var body: some View {
        NavigationStack {
            rootScreen
                .background(WF.canvas)
                .toolbar(.hidden, for: .navigationBar)
                // Read by the pushed Day's system back button ("‹ September").
                .navigationTitle(monthName(selectedDay))
                .navigationDestination(isPresented: $showsDay) { dayScreen }
        }
        .sheet(item: $editing) { target in
            switch target {
            case let .new(date): EventEditSheet(event: nil, initialDate: date)
            case let .edit(event): EventEditSheet(event: event, initialDate: event.startsAt ?? Date())
            }
        }
        .sheet(item: $detailEvent) { ev in EventDetailView(event: ev) }
        .sheet(item: $editingCountdown) { c in
            EditCountdownSheet(countdown: c,
                onSave: { title, date, emoji in
                    try await countdowns.update(c, title: title, date: date, emoji: emoji)
                },
                onRemove: { try await countdowns.remove(c) })
        }
        .sheet(isPresented: $showCapture) {
            CaptureSheet(autoDictate: dictateOnOpen).presentationDragIndicator(.visible)
        }
        .task { restoreMode() }
        .task { openReminderEvent(openEventId.wrappedValue) }
        .task { await countdowns.load() }
        // The root, not `mode`: a Day tapped open from Month is a drill-in, and remembering it
        // would reopen the tab on today's Day (the tab rebuilds this view, resetting the day).
        .onChange(of: root) { _, m in storedMode = m }
        .onChange(of: showsDay) { _, pushed in
            // Back from a Day you paged through lands on that day's month.
            if !pushed, let d = dayKeyToDate(selectedDay) { monthAnchor = d }
        }
        .onChange(of: openEventId.wrappedValue) { _, id in openReminderEvent(id) }
        .onChange(of: sync.events) { _, _ in
            if openEventId.wrappedValue != nil { openReminderEvent(openEventId.wrappedValue) }
        }
    }

    private func openReminderEvent(_ id: String?) {
        guard let id, let ev = sync.events.first(where: { $0.id == id }) else { return }
        detailEvent = ev
        openEventId.wrappedValue = nil
    }

    // MARK: navigation

    private func restoreMode() {
        guard !restoredMode else { return }
        restoredMode = true
        let start = CalMode.restored(stored: storedMode,
                                     override: DemoHooks.kioskCalMode.flatMap(CalMode.init(rawValue:)))
        var t = Transaction()
        t.disablesAnimations = true
        withTransaction(t) { show(start) }
    }

    /// Month pages by `monthAnchor`, Week by `selectedDay`; switching between them carries the
    /// position across so you land on the same stretch of time.
    private func show(_ target: CalMode) {
        if target == .day {
            showsDay = true
            return
        }
        if target == .month, root != .month, let d = dayKeyToDate(selectedDay) {
            monthAnchor = d
        }
        if target == .week, root == .month, !showsDay {
            selectedDay = PhoneCalendar.focusDay(selected: selectedDay, inMonthOf: monthAnchor,
                                                 today: Agenda.todayKey(tz), tz: tz)
        }
        root = target
        showsDay = false
    }

    // MARK: screens

    @ViewBuilder private var rootScreen: some View {
        switch root {
        case .week: weekScreen
        case .agenda: agendaScreen
        case .month, .day: monthScreen
        }
    }

    private var monthScreen: some View {
        VStack(spacing: 0) {
            header {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(DateFmt.string(monthAnchor, "MMMM", tz)).font(WF.serif(25)).foregroundStyle(WF.ink)
                    Text(DateFmt.string(monthAnchor, "yyyy", tz)).font(WF.serif(25, .regular)).foregroundStyle(WF.ink3)
                }
                .lineLimit(1)
            }
            PhoneMonthGrid(rows: PhoneCalendar.monthRows(monthAnchor, tz: tz, firstDay: firstDay),
                           firstDay: firstDay, tz: tz, byDay: dayIndex, countdownsByDay: countdowns.byDate,
                           todayKey: Agenda.todayKey(tz), selectedDay: selectedDay,
                           onPick: { key in selectedDay = key; show(.day) })
                .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { value in
                    if let step = HorizontalSwipe.step(value) { stepMonth(step) }
                })
        }
        .padding(.bottom, WF.fixedBarClearance)
        .calendarPinchZoom { show(mode.zoomed(in: $0)) }
    }

    private var weekScreen: some View {
        let days = PhoneCalendar.weekDays(containing: selectedDay, tz: tz, firstDay: firstDay)
        return VStack(spacing: 0) {
            header {
                Text(PhoneCalendar.weekTitle(days, tz: tz)).font(.system(size: 20, weight: .bold))
                    .foregroundStyle(WF.ink).lineLimit(1)
            }
            PhoneWeekRail(days: days, tz: tz, firstDay: firstDay, byDay: dayIndex, countdownsByDay: countdowns.byDate,
                          todayKey: Agenda.todayKey(tz), selectedDay: $selectedDay,
                          onEditEvent: { editing = .edit($0) },
                          onTapCountdown: openCountdown)
        }
        .padding(.bottom, WF.fixedBarClearance)
        .calendarPinchZoom { show(mode.zoomed(in: $0)) }
    }

    private var dayScreen: some View {
        PhoneDayTimeline(day: selectedDay, tz: tz, events: dayIndex[selectedDay] ?? [],
                         countdowns: countdowns.byDate[selectedDay] ?? [],
                         isToday: selectedDay == Agenda.todayKey(tz),
                         onTapEvent: { detailEvent = $0 },
                         onTapCountdown: openCountdown,
                         onAddAt: { editing = .new($0) },
                         onSwipeDay: stepDay)
            .padding(.bottom, WF.fixedBarClearance)
            .background(WF.canvas)
            .calendarPinchZoom { show(mode.zoomed(in: $0)) }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    optionsMenu
                    addButton
                }
            }
    }

    private var agendaScreen: some View {
        VStack(spacing: 0) {
            header { Text(monthTitle(Date(), year: false)).font(WF.serif(30)).foregroundStyle(WF.ink) }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) { agendaContent }
                    .padding(.horizontal, 18).padding(.bottom, WF.tabBarClearance)
            }
        }
    }

    // MARK: header (title + view/filter menu + add)

    private func header<Title: View>(@ViewBuilder _ title: () -> Title) -> some View {
        HStack(spacing: 8) {
            title()
            Spacer(minLength: 8)
            optionsMenu
            addButton
        }
        .padding(.horizontal, 16)
        .frame(height: 52)
    }

    /// The view switcher: its icon names the current view, and the menu also holds the
    /// per-person filter, marked by a dot while one is on.
    private var optionsMenu: some View {
        Menu {
            Picker("View", selection: Binding(get: { mode }, set: { m in withAnimation { show(m) } })) {
                ForEach(CalMode.allCases, id: \.self) { m in Label(m.label, systemImage: m.icon).tag(m) }
            }
            .pickerStyle(.inline)
            Picker("Show", selection: $filterPerson.animation()) {
                Label("Everyone", systemImage: "person.2").tag(String?.none)
                ForEach(sync.members) { m in Text(m.name).tag(Optional(m.id)) }
            }
            .pickerStyle(.inline)
        } label: {
            Image(systemName: mode.icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(WF.ink2)
                .frame(width: 32, height: 32)
                .background(WF.card, in: Circle())
                .overlay(Circle().strokeBorder(WF.hair, lineWidth: 1))
                .overlay(alignment: .topTrailing) {
                    if filterPerson != nil {
                        Circle().fill(WF.primary).frame(width: 9, height: 9)
                            .overlay(Circle().strokeBorder(WF.canvas, lineWidth: 1.5))
                    }
                }
        }
        .accessibilityLabel("\(mode.label) view")
        .accessibilityValue(filterPerson == nil ? "Everyone" : "Filtered to one person")
    }

    private var addButton: some View {
        Button { editing = .new(mode == .agenda ? Date() : (dayKeyToDate(selectedDay) ?? Date())) } label: {
            Image(systemName: "plus").font(.system(size: 17, weight: .bold)).foregroundStyle(.white)
                .frame(width: 34, height: 34).background(WF.primary, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("New event")
    }

    // MARK: agenda

    @ViewBuilder private var agendaContent: some View {
        AICaptureBar(placeholder: "Add an event…",
                     onTap: { dictateOnOpen = false; showCapture = true },
                     onMic: { dictateOnOpen = true; showCapture = true })
        personFilter
        if agendaDays.isEmpty {
            VStack(spacing: 10) {
                Image(systemName: "calendar").font(.system(size: 34)).foregroundStyle(WF.ink3)
                Text(filterPerson == nil ? "No upcoming events." : "Nothing for them coming up.")
                    .font(.system(size: 14)).foregroundStyle(WF.ink2)
            }
            .frame(maxWidth: .infinity).padding(.top, 56)
        } else {
            let eventsByDay = Dictionary(groups.map { ($0.day, $0.items) }, uniquingKeysWith: { a, _ in a })
            ForEach(agendaDays, id: \.self) { day in
                VStack(alignment: .leading, spacing: 8) {
                    dayHeading(day)
                    ForEach(eventsByDay[day] ?? []) { ev in
                        EventCard(event: ev, tz: tz) { detailEvent = ev }
                    }
                    ForEach(countdownsForDay(day)) { c in
                        CountdownCard(countdown: c, sleeps: countdowns.sleeps) { openCountdown(c) }
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
                    Image(systemName: "person.2.fill").font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(on ? WF.onInk : WF.ink2)
                        .frame(width: 24, height: 24)
                        .background(on ? WF.onInk.opacity(0.22) : WF.panel).clipShape(Circle())
                }
                Text(label).font(.system(size: 14, weight: .bold))
                    .foregroundStyle(on ? WF.onInk : WF.ink2)
            }
            .padding(.leading, 6).padding(.trailing, 14).padding(.vertical, 7)
            .background(on ? WF.ink : WF.card)
            .overlay(Capsule().strokeBorder(on ? Color.clear : WF.hair, lineWidth: 1))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    /// A countdown row: standalone → inline editor; event-source (`id` == event id) → that
    /// event's detail; birthday → no-op.
    private func openCountdown(_ c: WaffledAPI.Countdown) {
        switch c.source {
        case "standalone": editingCountdown = c
        case "event": if let ev = sync.events.first(where: { $0.id == c.id }) { detailEvent = ev }
        default: break
        }
    }

    private func countdownsForDay(_ day: String) -> [WaffledAPI.Countdown] {
        countdowns.byDate[day] ?? []
    }

    // MARK: helpers

    private func stepDay(_ n: Int) {
        withAnimation { selectedDay = PhoneCalendar.shift(selectedDay, byDays: n, tz: tz) }
    }

    private func stepMonth(_ n: Int) {
        let cal = Cal.gregorian(tz)
        if let d = cal.date(byAdding: .month, value: n, to: monthAnchor) { withAnimation { monthAnchor = d } }
    }

    private func monthTitle(_ date: Date, year: Bool) -> String {
        DateFmt.string(date, year ? "MMMM yyyy" : "MMMM", tz)
    }

    private func monthName(_ key: String) -> String {
        dayKeyToDate(key).map { DateFmt.string($0, "MMMM", tz) } ?? "Calendar"
    }

    private func dayKeyToDate(_ key: String) -> Date? {
        DateFmt.date(key, "yyyy-MM-dd", tz)
    }

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

/// One agenda event as a rounded card. The colour bar takes the family colour on a whole-family
/// event; the avatar stays the owner's, because that's identity.
struct EventCard: View {
    @Environment(SyncManager.self) private var sync
    let event: SyncedEvent
    let tz: TimeZone
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                Text(timeText).font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink2)
                    .frame(width: 72, alignment: .leading)
                RoundedRectangle(cornerRadius: 99).fill(sync.eventPalette.color(for: event))
                    .frame(width: 4, height: 34)
                RhythmEventMark(event: event, size: 13)
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
            .opacity(isPast ? 0.5 : 1)
        }
        .buttonStyle(.plain)
    }

    private var timeText: String {
        if event.allDay { return "All day" }
        if let d = event.startsAt { return EventTime.timeLabel(d, tz) }
        return ""
    }

    private var isPast: Bool { Agenda.isPast(event, tz) }
}

/// A countdown drawn as an all-day event row (the same card as `EventCard`).
struct CountdownCard: View {
    let countdown: WaffledAPI.Countdown
    let sleeps: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                Text(CountdownFormat.label(countdown.daysLeft, sleeps: sleeps))
                    .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.warn)
                    .frame(width: 72, alignment: .leading)
                RoundedRectangle(cornerRadius: 99).fill(countdown.color.flatMap { Color(hexString: $0) } ?? WF.warn)
                    .frame(width: 4, height: 34)
                Text(countdown.title).font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                Spacer(minLength: 8)
                Text(countdown.emoji ?? "⏳").font(.system(size: 20))
            }
            .padding(.horizontal, 15).padding(.vertical, 13)
            .frame(maxWidth: .infinity)
            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
            .wfShadow1()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

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

struct RecurringEventSeriesFields: Equatable {
    let allDay: Bool
    let isCountdown: Bool
    let participantIds: [String]
    let goalId: String?
    let goalStepId: String?
    let rrule: String?
    let recurrenceEndAt: Date?
}

enum RecurringEventEditPolicy {
    static func canApplyToSingleOccurrence(
        original: RecurringEventSeriesFields,
        edited: RecurringEventSeriesFields
    ) -> Bool {
        original.allDay == edited.allDay
            && original.isCountdown == edited.isCountdown
            && Set(original.participantIds) == Set(edited.participantIds)
            && original.goalId == edited.goalId
            && original.goalStepId == edited.goalStepId
            && original.rrule == edited.rrule
            && original.recurrenceEndAt == edited.recurrenceEndAt
    }
}

/// Keeps destructive event UI open until the deletion is confirmed, so a rejected request is
/// never mistaken for success because the sheet disappeared.
enum EventDeletionPolicy {
    static func perform(
        isRecurring: Bool,
        deleteRecurring: () async throws -> Void,
        deleteSingle: () async -> Bool
    ) async -> Bool {
        if isRecurring {
            do {
                try await deleteRecurring()
                return true
            } catch {
                return false
            }
        }
        return await deleteSingle()
    }
}

/// Create or edit a calendar event. Writes to the local PowerSync mirror (offline-first).
struct EventEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(SyncManager.self) private var sync
    let event: SyncedEvent?
    let initialDate: Date
    /// Called once, after a successful write, BEFORE the sheet dismisses. "Did they save or
    /// cancel?" is otherwise unanswerable from outside, and Weekly Planning's parked-note handoff
    /// turns on that distinction: a CANCELLED composer must leave the note.
    var onSaved: (() -> Void)?

    /// A recurring occurrence's row id doesn't exist in the `events` table — it lives on the
    /// master — so resolve through `seriesId`. For a single event `seriesId == id`.
    private var editId: String? { event.map { $0.seriesId ?? $0.id } }

    @State private var title: String
    @State private var day: Date
    @State private var start: Date
    @State private var durationMin: Int
    @State private var allDay: Bool
    /// The last day an all-day event covers (inclusive); saved as the exclusive end.
    @State private var lastDay: Date
    @State private var isCountdown: Bool
    /// Ordered so the first one picked is the "owner" (drives the calendar list).
    @State private var participants: [String]
    @State private var location: String
    @State private var confirmDelete = false
    @State private var loadedParticipants = false
    /// Built into an RRULE on save — recurring events go through REST because the local mirror
    /// can't expand a rule.
    @State private var repeatState = RepeatState.none
    @State private var loadedRepeat = false
    /// `never` repeats forever; `on` passes `recurrenceEndAt`; `after` rides a `COUNT=N` in the rule.
    @State private var endMode: RepeatEnd = .never
    @State private var untilDate = Date().addingTimeInterval(60 * 60 * 24 * 90) // ~3 months out
    @State private var occurrenceCount = 10
    enum RepeatEnd { case never, on, after }
    @State private var scopePrompt: ScopePrompt?
    enum ScopePrompt { case save, delete }
    @State private var originalSeriesFields: RecurringEventSeriesFields?
    @State private var saveError: String?
    @State private var deleting = false
    @State private var calendars: [WaffledAPI.CalendarLink] = []
    @State private var calendarId: String?
    @State private var calTouched = false
    // Goal linking, on create AND edit. The PowerSync events table has no goal columns, so a
    // goal-linked save goes through the rich REST route.
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
    // Auto-link: when memory is confident the goal is pre-filled, until the person overrides it.
    @State private var autoLinkedId: String?
    @State private var userTouchedGoal = false
    // Rhythm linking. `originalRhythmId` decides whether a save touches the link at all; see
    // `rhythmLinkChanged`.
    @State private var rhythmId: String?
    @State private var originalRhythmId: String?
    @State private var linkableRhythms: [WaffledAPI.Rhythm] = []
    @FocusState private var titleFocused: Bool

    private static let iso = ISO8601DateFormatter()

    /// `prefillTitle` / `prefillStart` exist for surfaces that already KNOW what the event is.
    /// `prefillStart` is a full `Date`, not an hour: the gap is an instant the server computed in
    /// the household's zone, and re-deriving it here is how the two disagree.
    init(event: SyncedEvent?, initialDate: Date, prefillGoalId: String? = nil,
         prefillGoalStepId: String? = nil, prefillParticipantIds: [String]? = nil,
         prefillTitle: String? = nil, prefillStart: Date? = nil,
         onSaved: (() -> Void)? = nil) {
        self.event = event
        self.initialDate = initialDate
        // Explicit init, so the memberwise one is suppressed: without this parameter a
        // caller can only reach `onSaved` by mutating the value after construction.
        self.onSaved = onSaved
        self.prefillGoalId = prefillGoalId
        self.prefillGoalStepId = prefillGoalStepId
        self.prefillParticipantIds = prefillParticipantIds
        let cal = Cal.current
        // Create defaults to 5pm unless the caller named the instant (a connection slot).
        let startDate = event?.startsAt
            ?? prefillStart
            ?? (cal.date(bySettingHour: 17, minute: 0, second: 0, of: initialDate) ?? initialDate)
        let mins: Int = {
            guard event?.allDay != true, let s = event?.startsAt, let e = event?.endsAt else { return 60 }
            return EventEnd.minutes(from: s, to: e)
        }()
        _title = State(initialValue: event?.title ?? prefillTitle ?? "")
        _day = State(initialValue: startDate)
        _start = State(initialValue: startDate)
        _durationMin = State(initialValue: mins)
        _allDay = State(initialValue: event?.allDay ?? false)
        _lastDay = State(initialValue: EventEnd.allDayLastDay(
            start: startDate, end: event?.allDay == true ? event?.endsAt : nil, cal: cal))
        _isCountdown = State(initialValue: event?.isCountdown ?? false)
        let eventParticipants = event.map {
            !$0.participantIds.isEmpty ? $0.participantIds : ($0.personId.map { [$0] } ?? [])
        } ?? []
        _participants = State(initialValue: prefillParticipantIds ?? eventParticipants)
        _location = State(initialValue: event?.location ?? "")
        _goalId = State(initialValue: prefillGoalId)
        _goalStepId = State(initialValue: prefillGoalStepId)
        _rhythmId = State(initialValue: event?.rhythmId)
        _originalRhythmId = State(initialValue: event?.rhythmId)
    }

    private var editing: Bool { event != nil }
    private var endsBinding: Binding<Date> {
        Binding(get: { resolvedStart.addingTimeInterval(Double(durationMin) * 60) },
                set: { durationMin = EventEnd.minutes(from: resolvedStart, to: $0) })
    }
    private var canSave: Bool {
        !title.trimmingCharacters(in: .whitespaces).isEmpty
        && (!wasRecurring || originalSeriesFields != nil)
        && !deleting
    }
    /// True when editing a materialized occurrence (the mirror sets `occurrenceStart` only there).
    private var wasRecurring: Bool { event?.occurrenceStart != nil }
    private var resolvedStart: Date {
        let cal = Cal.current
        return allDay ? (cal.date(bySettingHour: 12, minute: 0, second: 0, of: day) ?? day) : combine(day, start)
    }

    /// The owner (first family member who's a participant) drives the calendar list.
    private var primaryPerson: String? { participants.first }
    private var ownerCals: [WaffledAPI.CalendarLink] {
        guard let p = primaryPerson else { return [] }
        return calendars.filter { $0.isWritable && $0.personId == p && ($0.selected || $0.isWriteTarget) }
    }
    private var showCalendarPicker: Bool { !editing && ownerCals.count > 1 }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let saveError {
                        Text(saveError)
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.primaryD)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(WF.primary.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    }
                    group("Title") {
                        TextField("Soccer practice", text: $title)
                            .font(.system(size: 16, weight: .semibold)).textInputAutocapitalization(.sentences)
                            .focused($titleFocused)
                            .padding(.horizontal, 13).padding(.vertical, 11).innerField()
                    }

                    HStack(alignment: .top, spacing: 14) {
                        group(allDay ? "Starts" : "Date") {
                            DatePicker("", selection: $day, displayedComponents: .date)
                                .labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if allDay {
                            group("Ends") {
                                DatePicker("", selection: $lastDay, displayedComponents: .date)
                                    .labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                            }
                        } else {
                            group("Starts") {
                                DatePicker("", selection: $start, displayedComponents: .hourAndMinute)
                                    .labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }

                    if !allDay {
                        group("Ends") {
                            DatePicker("", selection: endsBinding, displayedComponents: [.date, .hourAndMinute])
                                .labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }

                    Toggle(isOn: $allDay.animation()) {
                        Text("All day").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                    }
                    .tint(FamilyColor.person3.solid)
                    .padding(14).cardBox()

                    Toggle(isOn: $isCountdown) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("⏳ Show a countdown").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                            Text("Build anticipation with “N days until…”").font(.system(size: 12)).foregroundStyle(WF.ink3)
                        }
                    }
                    .tint(FamilyColor.person3.solid)
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
                    rhythmSection

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
                // Read-only: the fields stay legible but nothing changes. Cancel is in the toolbar.
                .disabled(isReadOnly)
            }
            .background(WF.canvas)
            .navigationTitle(editing ? "Edit event" : "New event")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task { await load() }
            .task {
                if !editing { try? await Task.sleep(for: .milliseconds(350)); titleFocused = true }
            }
            .onChange(of: participants) { _, _ in recomputeDefaultCalendar(); clearOrphanGoal(); scheduleSuggest() }
            .onChange(of: title) { _, _ in scheduleSuggest() }
            // No `in:` range on the Ends pickers — a ranged compact picker renders its date in a
            // different style from Starts — so the floor is kept here (timed: `EventEnd.minutes`).
            .onChange(of: lastDay) { _, picked in
                let floor = Cal.current.startOfDay(for: day)
                if picked < floor { lastDay = floor }
            }
            // Moving the start day carries an all-day span with it.
            .onChange(of: day) { old, new in
                let cal = Cal.current
                let span = cal.dateComponents([.day], from: cal.startOfDay(for: old), to: cal.startOfDay(for: lastDay)).day ?? 0
                lastDay = cal.date(byAdding: .day, value: max(0, span), to: cal.startOfDay(for: new)) ?? new
            }
            .confirmationDialog(
                scopePrompt == .delete ? "Delete repeating event" : "Save repeating event",
                isPresented: Binding(get: { scopePrompt != nil }, set: { if !$0 { scopePrompt = nil } }),
                titleVisibility: .visible
            ) {
                let del = scopePrompt == .delete
                if del || canApplyToSingleOccurrence {
                    Button(del ? "This event" : "Save this event") { applyScope("this") }
                }
                Button(del ? "This and all future events" : "Save this and all future events",
                       role: del ? .destructive : nil) { applyScope("following") }
                // "All events" (incl. past) is offered only for edits — needed to change the
                // recurrence rule — never for delete, so past events can't be wiped.
                if !del { Button("Save all events") { applyScope("all") } }
                Button("Cancel", role: .cancel) { scopePrompt = nil }
            } message: {
                if scopePrompt == .delete {
                    Text("This is part of a repeating series.")
                } else if canApplyToSingleOccurrence {
                    Text("Apply your changes to which occurrences?")
                } else {
                    Text("Changes to all-day, countdown, people, goal, or repeat settings must apply to this and future events, or all events.")
                }
            }
        }
        .modifier(KioskSheetPresentation(kiosk: DeviceExperience.current == .kiosk))
    }

    /// A subscribed feed is a one-way read. Gating the SHEET, not the screens that present it,
    /// covers every route in. See `EventOrigin.blocksEditing`.
    private var isReadOnly: Bool { EventOrigin.blocksEditing(event) }

    @ViewBuilder private var bottomBar: some View {
        if isReadOnly {
            LockNote.subscribedFeedEvent
        } else {
            editControls
        }
    }

    private var editControls: some View {
        HStack(spacing: 14) {
            if editing {
                Button {
                    // Recurring events choose a scope; single events use tap-again confirm.
                    if wasRecurring { scopePrompt = .delete }
                    else if confirmDelete { performDelete(scope: nil) }
                    else { withAnimation { confirmDelete = true } }
                } label: {
                    Text(confirmDelete && !wasRecurring ? "Tap again" : "Delete")
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.primary)
                }
                .buttonStyle(.plain)
                .disabled(deleting)
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

    /// Calendar-opted goals whose participants include every chosen attendee. Empty until ≥1 is
    /// picked: an empty attendee set must NOT vacuously match every goal.
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

    @ViewBuilder private var rhythmSection: some View {
        if !linkableRhythms.isEmpty {
            group("Keeps a rhythm · optional") {
                Menu {
                    Button("No rhythm") { rhythmId = nil }
                    ForEach(linkableRhythms) { r in
                        Button(Self.rhythmLabel(r)) { rhythmId = r.id }
                    }
                } label: {
                    HStack {
                        Text(rhythmMenuLabel).font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(rhythmId == nil ? WF.ink3 : WF.ink).lineLimit(1)
                        Spacer()
                        Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                    }
                    .padding(.horizontal, 13).padding(.vertical, 11).innerField()
                }
            }
        }
    }

    private static func rhythmLabel(_ r: WaffledAPI.Rhythm) -> String {
        if let e = r.emoji, !e.isEmpty { return e + " " + r.title }
        return r.title
    }

    private var rhythmMenuLabel: String {
        guard let id = rhythmId, let r = linkableRhythms.first(where: { $0.id == id }) else { return "No rhythm" }
        return Self.rhythmLabel(r)
    }

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

    private var autoLinkedGoal: WaffledAPI.Goal? {
        guard let id = autoLinkedId, goalId == id, !userTouchedGoal else { return nil }
        return eligibleGoals.first { $0.id == id }
    }

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

    private func loadSteps(for id: String) async {
        goalSteps = (try? await WaffledAPI().goalDetail(id: id))?.steps ?? []
    }

    /// Drop a chosen goal that no longer fits the attendees. Guarded so an async load can't wipe
    /// a prefill.
    private func clearOrphanGoal() {
        guard !eligibleGoals.isEmpty, let gid = goalId else { return }
        if !eligibleGoalsForAttendees.contains(where: { $0.id == gid }) {
            goalId = nil; goalStepId = nil; goalSteps = []; suggestion = nil; autoLinkedId = nil
        }
    }

    /// Debounced live goal match — only once attendees are chosen, so a suggestion never names
    /// people who aren't on the event.
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
            if !ids.isEmpty { participants = (participants + ids.filter { !participants.contains($0) }) }
        }
        if !editing, calendars.isEmpty {
            calendars = (try? await WaffledAPI().calendarLinks()) ?? []
            recomputeDefaultCalendar()
        }
        if eligibleGoals.isEmpty {
            eligibleGoals = (try? await WaffledAPI().goalsIn(listId: nil)) ?? []
        }
        // Scheduling-shape rhythms only: a completion rhythm would settle nothing. A 403 hides it.
        if linkableRhythms.isEmpty {
            linkableRhythms = ((try? await WaffledAPI().rhythms()) ?? [])
                .filter { $0.satisfiedBy == .scheduling && $0.isActive }
        }
        // The local mirror doesn't carry the rule, so load it from the master when editing.
        if wasRecurring, !loadedRepeat, let ev = event {
            loadedRepeat = true
            if let detail = try? await WaffledAPI().eventDetail(id: ev.seriesId ?? ev.id) {
                if prefillGoalId == nil { goalId = detail.goalId }
                if prefillGoalStepId == nil { goalStepId = detail.goalStepId }
                // COUNT rides in the rule; strip it before parsing the cadence, then restore it.
                if let rule = detail.rrule {
                    if let n = Self.extractCount(rule) {
                        endMode = .after
                        occurrenceCount = n
                    } else if let end = EventTime.parse(detail.recurrenceEndAt) {
                        endMode = .on
                        untilDate = end
                    }
                    repeatState = Recurrence.parseRepeat(Self.stripCount(rule))
                }
                originalSeriesFields = RecurringEventSeriesFields(
                    allDay: ev.allDay,
                    isCountdown: ev.isCountdown,
                    participantIds: participants,
                    goalId: detail.goalId,
                    goalStepId: detail.goalStepId,
                    rrule: detail.rrule,
                    recurrenceEndAt: EventTime.parse(detail.recurrenceEndAt))
            } else {
                saveError = "Couldn’t load this repeating series. Check your connection and try again."
            }
        }
        if let gid = goalId, goalSteps.isEmpty { await loadSteps(for: gid) }
    }

    private static func extractCount(_ rule: String) -> Int? {
        guard let r = rule.range(of: "COUNT=\\d+", options: .regularExpression) else { return nil }
        return Int(rule[r].dropFirst("COUNT=".count))
    }
    private static func stripCount(_ rule: String) -> String {
        rule.replacingOccurrences(of: ";?COUNT=\\d+", with: "", options: .regularExpression)
    }

    private func recomputeDefaultCalendar() {
        guard !editing, !calTouched else { return }
        calendarId = (ownerCals.first { $0.isWriteTarget } ?? ownerCals.first)?.id
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
        // byday only applies to the weekly preset + custom-weekly; clear it so the rule stays clean.
        if f != .weekly && f != .custom { repeatState.byday = [] }
    }

    /// An empty `byday` means "the event's own weekday" (what `buildRrule` defaults to).
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
                        .wfChip(selected: on, tint: FamilyColor.person3.solid)
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

    private struct Draft {
        let startISO: String, endISO: String?, name: String, loc: String?
        let ids: [String], chosenCal: String?, rrule: String?, recurrenceEndAt: String?
    }

    private func buildDraft() -> Draft {
        let startDate = resolvedStart
        let startISO = Self.iso.string(from: startDate)
        let endISO = allDay
            ? Self.iso.string(from: EventEnd.allDayExclusiveEnd(lastDay: lastDay, cal: Cal.current))
            : Self.iso.string(from: startDate.addingTimeInterval(Double(durationMin) * 60))
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedLoc = location.trimmingCharacters(in: .whitespaces)
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

    private var currentSeriesFields: RecurringEventSeriesFields {
        let d = buildDraft()
        return RecurringEventSeriesFields(
            allDay: allDay,
            isCountdown: isCountdown,
            participantIds: d.ids,
            goalId: goalId,
            goalStepId: goalStepId,
            rrule: d.rrule,
            recurrenceEndAt: EventTime.parse(d.recurrenceEndAt))
    }

    private var canApplyToSingleOccurrence: Bool {
        guard let originalSeriesFields else { return false }
        return RecurringEventEditPolicy.canApplyToSingleOccurrence(
            original: originalSeriesFields,
            edited: currentSeriesFields)
    }

    private func save() {
        saveError = nil
        if wasRecurring { scopePrompt = .save; return }
        performSave(scope: nil)
        // performSave dismisses once the write lands, so the detail screen's reload sees fresh data.
    }

    private func applyScope(_ scope: String) {
        let mode = scopePrompt
        scopePrompt = nil
        if mode == .save, scope == "this", !canApplyToSingleOccurrence { return }
        if mode == .delete { performDelete(scope: scope) } else { performSave(scope: scope) }
    }

    /// Only when the link changed: every write path treats an absent rhythm_id as "leave it
    /// alone", so an unlink must be an explicit null.
    private var rhythmLinkChanged: Bool { rhythmId != originalRhythmId }

    private func performSave(scope: String?) {
        let d = buildDraft()
        let tz = sync.householdTz.identifier
        Task {
            do {
                if let editId {
                    if wasRecurring {
                        // A single occurrence sends only override-backed fields.
                        let appliesToSeries = scope != "this"
                        try await WaffledAPI().updateEvent(
                            id: editId, title: d.name, startsAtISO: d.startISO, endsAtISO: d.endISO,
                            allDay: allDay, location: d.loc, personIds: d.ids,
                            goalId: goalId, goalStepId: goalStepId,
                            rhythmId: rhythmLinkChanged ? rhythmId : nil,
                            clearRhythmId: rhythmLinkChanged && rhythmId == nil,
                            rrule: appliesToSeries ? d.rrule : nil,
                            clearRrule: appliesToSeries && d.rrule == nil,
                            recurrenceEndAt: appliesToSeries ? d.recurrenceEndAt : nil,
                            clearRecurrenceEndAt: appliesToSeries && d.recurrenceEndAt == nil,
                            scope: scope, occurrenceStart: event?.occurrenceStart, isCountdown: isCountdown)
                        sync.touchGoals()
                    } else if let rrule = d.rrule {
                        // A single event made recurring — promoted in place via REST.
                        try await WaffledAPI().updateEvent(
                            id: editId, title: d.name, startsAtISO: d.startISO, endsAtISO: d.endISO,
                            allDay: allDay, location: d.loc, personIds: d.ids,
                            goalId: goalId, goalStepId: goalStepId,
                            rhythmId: rhythmLinkChanged ? rhythmId : nil,
                            clearRhythmId: rhythmLinkChanged && rhythmId == nil,
                            rrule: rrule,
                            recurrenceEndAt: d.recurrenceEndAt, isCountdown: isCountdown)
                        sync.touchGoals()
                    } else if goalId != nil || prefillGoalId != nil || rhythmLinkChanged {
                        // A goal or rhythm link change → PATCH the rich REST route.
                        try await WaffledAPI().updateEvent(
                            id: editId, title: d.name, startsAtISO: d.startISO, endsAtISO: d.endISO,
                            allDay: allDay, location: d.loc, personIds: d.ids, goalId: goalId, goalStepId: goalStepId,
                            rhythmId: rhythmLinkChanged ? rhythmId : nil,
                            clearRhythmId: rhythmLinkChanged && rhythmId == nil,
                            isCountdown: isCountdown)
                        sync.touchGoals()
                    } else {
                        _ = await sync.updateEvent(id: editId, title: d.name, startsAtISO: d.startISO,
                                                   endsAtISO: d.endISO, allDay: allDay, location: d.loc, personIds: d.ids,
                                                   isCountdown: isCountdown)
                    }
                } else if d.rrule != nil || goalId != nil {
                    // Recurring and/or goal-linked create goes through the rich REST route.
                    _ = try await WaffledAPI().createEvent(
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
            } catch {
                saveError = "Couldn’t save this event. Check your connection and try again."
                return
            }
            onSaved?()  // before the dismiss, so a caller can act on a real save
            dismiss()   // after the write, so the caller's reload picks up fresh data
        }
    }

    private func performDelete(scope: String?) {
        guard let id = editId else { return }
        deleting = true
        saveError = nil
        Task {
            let deleted = await EventDeletionPolicy.perform(
                isRecurring: wasRecurring,
                deleteRecurring: {
                    // 'this' cancels one occurrence, 'following' caps the series, 'all' drops it.
                    try await WaffledAPI().deleteEvent(
                        id: id, scope: scope, occurrenceStart: event?.occurrenceStart
                    )
                },
                deleteSingle: { await sync.deleteEvent(id: id) }
            )
            guard deleted else {
                deleting = false
                saveError = "Couldn’t delete this event. Check your connection and try again."
                return
            }
            if wasRecurring { sync.touchGoals() }
            dismiss() // only after confirmed deletion
        }
    }

    private func combine(_ dayDate: Date, _ time: Date) -> Date {
        let cal = Cal.current
        let d = cal.dateComponents([.year, .month, .day], from: dayDate)
        let t = cal.dateComponents([.hour, .minute], from: time)
        return cal.date(from: DateComponents(year: d.year, month: d.month, day: d.day, hour: t.hour, minute: t.minute)) ?? dayDate
    }

    private func group<V: View>(_ label: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(label).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
            content()
        }
        .padding(14).cardBox()
    }
}

private extension View {
    func cardBox() -> some View {
        frame(maxWidth: .infinity, alignment: .leading).wfField()
    }
    func innerField() -> some View {
        frame(maxWidth: .infinity, alignment: .leading).wfField(radius: WF.rSM)
    }
}

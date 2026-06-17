import SwiftUI

/// Calendar tab — an upcoming-agenda list grouped by day, read live from the
/// local mirror. (A month grid can follow; the agenda is the high-value first cut
/// and exercises the same synced data as Today.)
struct CalendarView: View {
    @Environment(SyncManager.self) private var sync
    @State private var editing: EventEditTarget?

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

    private var groups: [(day: String, items: [SyncedEvent])] {
        Agenda.upcoming(sync.events, from: Agenda.todayKey(sync.householdTz), tz: sync.householdTz)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("Calendar").font(NK.serif(30)).foregroundStyle(NK.ink)
                    Spacer()
                    Button { editing = .new(Date()) } label: {
                        Image(systemName: "plus").font(.system(size: 17, weight: .semibold)).foregroundStyle(NK.primary)
                            .frame(width: 38, height: 38).background(NK.panel).clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.top, 8)

                if groups.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "calendar").font(.system(size: 34)).foregroundStyle(NK.ink3)
                        Text("No upcoming events.").font(.system(size: 14)).foregroundStyle(NK.ink2)
                        Button { editing = .new(Date()) } label: {
                            Text("New event").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.primary)
                        }
                    }
                    .frame(maxWidth: .infinity).padding(.top, 56)
                } else {
                    ForEach(groups, id: \.day) { group in
                        VStack(alignment: .leading, spacing: 7) {
                            SectionLabel(text: dayHeader(group.day))
                            NookCard(padding: 14) {
                                VStack(spacing: 0) {
                                    ForEach(Array(group.items.enumerated()), id: \.element.id) { idx, ev in
                                        Button { editing = .edit(ev) } label: {
                                            HStack(spacing: 8) {
                                                EventRow(event: ev, tz: sync.householdTz)
                                                Image(systemName: "chevron.right")
                                                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
                                            }
                                            .padding(.vertical, 10).contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain)
                                        if idx < group.items.count - 1 {
                                            Rectangle().fill(NK.hair2).frame(height: 1)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 18).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .sheet(item: $editing) { target in
            switch target {
            case let .new(date): EventEditSheet(event: nil, initialDate: date)
            case let .edit(event): EventEditSheet(event: event, initialDate: event.startsAt ?? Date())
            }
        }
    }

    private func dayHeader(_ key: String) -> String {
        let tz = sync.householdTz
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        let tomorrow = EventTime.dayKey(cal.date(byAdding: .day, value: 1, to: Date()) ?? Date(), tz)
        if key == Agenda.todayKey(tz) { return "Today" }
        if key == tomorrow { return "Tomorrow" }
        let inF = DateFormatter()
        inF.locale = Locale(identifier: "en_US_POSIX"); inF.timeZone = tz; inF.dateFormat = "yyyy-MM-dd"
        guard let d = inF.date(from: key) else { return key }
        let outF = DateFormatter()
        outF.locale = Locale(identifier: "en_US"); outF.timeZone = tz; outF.dateFormat = "EEE, MMM d"
        return outF.string(from: d)
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
    @State private var participants: Set<String>
    @State private var location: String
    @State private var confirmDelete = false
    @State private var loadedParticipants = false
    // Google calendar picker (create only).
    @State private var calendars: [NookAPI.CalendarLink] = []
    @State private var calendarId: String?
    @State private var calTouched = false

    private static let iso = ISO8601DateFormatter()
    private static let durations = [15, 30, 45, 60, 90, 120, 180, 240]

    init(event: SyncedEvent?, initialDate: Date) {
        self.event = event
        self.initialDate = initialDate
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
        _participants = State(initialValue: event?.personId.map { Set([$0]) } ?? [])
        _location = State(initialValue: event?.location ?? "")
    }

    private var editing: Bool { event != nil }
    private var canSave: Bool { !title.trimmingCharacters(in: .whitespaces).isEmpty }

    /// The owner (first family member who's a participant) drives the calendar list.
    private var primaryPerson: String? { sync.members.first { participants.contains($0.id) }?.id }
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
                                    if on { participants.remove(m.id) } else { participants.insert(m.id) }
                                } label: {
                                    HStack(spacing: 7) {
                                        Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 24)
                                        Text(m.name).font(.system(size: 14, weight: .semibold))
                                            .foregroundStyle(on ? NK.ink : NK.ink2)
                                    }
                                    .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 6)
                                    .background(on ? c.opacity(0.14) : NK.card)
                                    .overlay(Capsule().strokeBorder(on ? c : NK.hair, lineWidth: on ? 1.5 : 1))
                                    .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

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
            .onChange(of: participants) { _, _ in recomputeDefaultCalendar() }
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

    // MARK: data

    private func load() async {
        if editing, !loadedParticipants {
            loadedParticipants = true
            let ids = await sync.eventParticipantIds(event!.id)
            if !ids.isEmpty { participants = Set(ids) }
        }
        if !editing, calendars.isEmpty {
            calendars = (try? await NookAPI().calendarLinks()) ?? []
            recomputeDefaultCalendar()
        }
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
                _ = await sync.updateEvent(id: event.id, title: name, startsAtISO: startISO,
                                           endsAtISO: endISO, allDay: allDay, location: loc, personIds: ids)
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
    /// The outer card-group chrome (cream panel, hairline border).
    func cardBox() -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
            .background(NK.card2)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }
    /// The inner input chrome (white, hairline border).
    func innerField() -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
            .background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }
}

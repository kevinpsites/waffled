import SwiftUI

/// The iPad Calendar page — web-like Month / Week / Day views. Month is a width-
/// filling grid with event chips + a side day panel; Week and Day are time-grids
/// (hour axis + positioned event blocks). Reuses the shared data, sheets
/// (`EventEditSheet`, `EventDetailView`), and `EventCard`; the phone `CalendarView`
/// is untouched. See `apps/ios/IPAD_ROADMAP.md` (Phase 3 — web-ify pages).
struct KioskCalendarView: View {
    @Environment(SyncManager.self) private var sync

    enum Mode: String, CaseIterable { case month, week, day, people, agenda
        var label: String { rawValue.capitalized }
    }

    @State private var mode: Mode = Mode(rawValue: DemoHooks.kioskCalMode ?? "") ?? .month
    @State private var monthAnchor = Date()
    @State private var miniAnchor = Date()
    @State private var selectedDay = Agenda.todayKey(TimeZone.current)
    @State private var filterPerson: String?
    @State private var editing: CalendarView.EventEditTarget?
    @State private var detailEvent: SyncedEvent?
    @State private var headsUp: WaffledAPI.HeadsUp?
    @State private var countdowns = CountdownsModel()
    @State private var editingCountdown: WaffledAPI.Countdown?

    private var tz: TimeZone { sync.householdTz }
    /// The household's first day of the week — the week columns, the month grid and
    /// both weekday header rows follow it rather than a fixed Sunday.
    private var firstDay: HouseholdWeekStart { sync.householdWeekStart ?? .sunday }

    /// The shared prebuilt day index (`SyncManager.eventsByDay`), person-filtered.
    /// With no filter chip this is the index verbatim (no copy, no scan); with one
    /// it's a single pass — either way no per-cell re-scan of the full event list.
    private var filteredByDay: [String: [SyncedEvent]] {
        guard let p = filterPerson else { return sync.eventsByDay }
        var out: [String: [SyncedEvent]] = [:]
        for (day, items) in sync.eventsByDay {
            let kept = items.filter { $0.personId == p || $0.participantIds.contains(p) }
            if !kept.isEmpty { out[day] = kept }
        }
        return out
    }
    private var selectedItems: [SyncedEvent] { filteredByDay[selectedDay] ?? [] }

    /// Tapping a countdown row (parity with the phone calendar): standalone → inline
    /// rename/move/remove editor; an event-source countdown → that event's detail;
    /// birthday → no-op (managed on the person's profile).
    private func openCountdown(_ c: WaffledAPI.Countdown) {
        switch c.source {
        case "standalone": editingCountdown = c
        case "event": if let ev = sync.events.first(where: { $0.id == c.id }) { detailEvent = ev }
        default: break
        }
    }

    /// Countdowns on a day (today forward), rendered as all-day rows in the day panel + agenda.
    private func countdownsForDay(_ day: String) -> [WaffledAPI.Countdown] { countdowns.byDate[day] ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 28).padding(.top, 18).padding(.bottom, 12)
            content.padding(.horizontal, 28).padding(.bottom, 24)
                // Swipe left/right to step month / week / day (same as the chevrons).
                // Simultaneous so the week/day time grids still scroll vertically.
                .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded(handleSwipe))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(WF.canvas)
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
        .task { await countdowns.load() }
        .task {
            guard DemoHooks.kioskOpenEvent || DemoHooks.kioskOpenEdit else { return }
            for _ in 0..<40 { if !sync.events.isEmpty { break }; try? await Task.sleep(nanoseconds: 150_000_000) }
            let ev = selectedItems.first ?? sync.events.sorted { ($0.startsAt ?? .distantFuture) < ($1.startsAt ?? .distantFuture) }.first
            if DemoHooks.kioskOpenEdit, let ev { editing = .edit(ev) }
            else if detailEvent == nil, let ev { detailEvent = ev }
        }
    }

    @ViewBuilder private var content: some View {
        // Materialize the (possibly person-filtered) index once per render and hand it
        // down, so month cells / day columns / agenda all share the same lookup.
        let byDay = filteredByDay
        switch mode {
        case .month:
            HStack(alignment: .top, spacing: 20) {
                monthGrid(byDay).frame(maxWidth: .infinity, maxHeight: .infinity)
                dayPanel(byDay[selectedDay] ?? []).frame(width: 340)
            }
        case .week:
            CalTimeGrid(days: weekDays(selectedDay), tz: tz, byDay: byDay,
                        headers: .days, selectedDay: selectedDay,
                        onTapEvent: { detailEvent = $0 }, onAddAt: { editing = .new($0) },
                        onPickDay: { day in withAnimation { selectedDay = day; mode = .day } },
                        countdownsByDay: countdowns.byDate,
                        onTapCountdown: { openCountdown($0) })
        case .day:
            CalTimeGrid(days: [selectedDay], tz: tz, byDay: byDay,
                        headers: .none, selectedDay: selectedDay,
                        onTapEvent: { detailEvent = $0 }, onAddAt: { editing = .new($0) },
                        onPickDay: { _ in },
                        countdownsByDay: countdowns.byDate,
                        onTapCountdown: { openCountdown($0) })
        case .people:
            peopleContent
        case .agenda:
            agendaContent(byDay)
        }
    }

    /// Hour to open the People grid on: one before the day's first event, else 7 AM.
    private func peopleScrollHour() -> Int {
        let starts = (sync.eventsByDay[selectedDay] ?? []).filter { !$0.allDay }.compactMap(\.startsAt)
        guard let first = starts.min() else { return 7 }
        return max(0, (Cal.gregorian(tz).dateComponents([.hour], from: first).hour ?? 8) - 1)
    }

    /// One column per family member for the selected day. Reads the UNFILTERED index
    /// on purpose: the columns are the per-person split, so applying the person filter
    /// on top would collapse the view to a single column and defeat the mode.
    @ViewBuilder private var peopleContent: some View {
        let members = sync.members.map {
            PeopleColumns.Member(id: $0.id, name: $0.name, colorHex: $0.colorHex, avatarEmoji: $0.emoji)
        }
        if members.isEmpty {
            Text("Add family members to see per-person columns.")
                .font(.system(size: 15)).foregroundStyle(WF.ink3)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            // The SAME grid Week uses, with people as the columns instead of days —
            // so a person's column reads exactly like Mon/Tue/Wed: strict equal-width
            // columns under a header band, same dividers, same all-day row.
            let columns = PeopleColumns.build(sync.eventsByDay[selectedDay] ?? [], people: members)
            CalTimeGrid(days: columns.map(\.id), tz: tz,
                        byDay: Dictionary(uniqueKeysWithValues: columns.map { ($0.id, $0.events) }),
                        headers: .people(columns.map {
                            PeopleColumns.Member(id: $0.id, name: $0.name,
                                                 colorHex: $0.colorHex, avatarEmoji: $0.avatarEmoji)
                        }),
                        selectedDay: selectedDay,
                        onTapEvent: { detailEvent = $0 },
                        onAddAt: { editing = .new($0) },
                        onPickDay: { _ in },
                        // The column keys are person ids, so the grid's own
                        // "do the visible days include today" test can never match.
                        showsNowLine: selectedDay == Agenda.todayKey(tz),
                        scrollToHour: peopleScrollHour())
        }
    }

    // MARK: header

    private var header: some View {
        VStack(spacing: 12) {
            HStack(spacing: 14) {
                // Priority over the segmented picker beside it — without this the
                // five-segment control squeezes the date down to "T…".
                Text(navTitle).font(WF.serif(34)).foregroundStyle(WF.ink).lineLimit(1)
                    .layoutPriority(1)
                if mode != .agenda {
                    Button { step(-1) } label: { chevron("chevron.left") }
                    Button { step(1) } label: { chevron("chevron.right") }
                    Button { withAnimation { monthAnchor = Date(); selectedDay = Agenda.todayKey(tz) } } label: {
                        Text("Today").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink2)
                            .fixedSize()   // never wrap to "Toda / y" when the row is tight
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(WF.card).clipShape(Capsule())
                            .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
                Picker("", selection: $mode.animation()) {
                    ForEach(Mode.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                // Wide enough for five segments once People was added.
                .pickerStyle(.segmented).labelsHidden().frame(width: 320)
                Button { editing = .new(dayKeyToDate(selectedDay) ?? Date()) } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "plus").font(.system(size: 15, weight: .bold))
                        Text("Add event").font(.system(size: 15, weight: .bold))
                    }
                    .foregroundStyle(.white).padding(.horizontal, 16).padding(.vertical, 11)
                    // Never let the row's squeeze wrap this label into "Ad d eve nt"
                    // — the fifth view segment made the header tight enough to try.
                    .fixedSize(horizontal: true, vertical: false)
                    .background(WF.primary).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            // Hidden in People mode: the columns already ARE the per-person split, so
            // a "show me one person" filter on top of them is redundant (and People
            // reads the unfiltered index anyway, so the chips would look inert).
            if mode != .people { personFilter }
        }
    }

    private var navTitle: String {
        switch mode {
        case .month: return DateFmt.string(monthAnchor, "MMMM yyyy", tz)
        case .week:
            let days = weekDays(selectedDay)
            guard let first = days.first.flatMap(dayKeyToDate), let last = days.last.flatMap(dayKeyToDate) else { return "" }
            return "\(DateFmt.string(first, "MMM d", tz)) – \(DateFmt.string(last, "MMM d", tz))"
        case .day, .people:
            guard let d = dayKeyToDate(selectedDay) else { return selectedDay }
            return DateFmt.string(d, "EEEE, MMM d", tz)
        case .agenda:
            return DateFmt.string(Date(), "EEE, MMMM d", tz)
        }
    }

    private func step(_ n: Int) {
        switch mode {
        case .month:
            let cal = Cal.gregorian(tz)
            if let d = cal.date(byAdding: .month, value: n, to: monthAnchor) { withAnimation { monthAnchor = d } }
        case .week: shiftDay(n * 7)
        case .day, .people: shiftDay(n)
        case .agenda: break   // no month/week stepping in agenda
        }
    }

    private func shiftDay(_ n: Int) {
        let cal = Cal.gregorian(tz)
        if let d = dayKeyToDate(selectedDay), let nd = cal.date(byAdding: .day, value: n, to: d) {
            withAnimation { selectedDay = EventTime.dayKey(nd, tz) }
        }
    }

    /// Horizontal flick → step month / week / day (mirrors the header chevrons). Ignores
    /// agenda mode and predominantly-vertical drags so the time grids still scroll.
    private func handleSwipe(_ value: DragGesture.Value) {
        guard mode != .agenda, let dir = HorizontalSwipe.step(value) else { return }
        step(dir)
    }

    private func chevron(_ s: String) -> some View {
        Image(systemName: s).font(.system(size: 14, weight: .heavy)).foregroundStyle(WF.ink2)
            .frame(width: 36, height: 36).background(WF.card).clipShape(Circle())
            .overlay(Circle().strokeBorder(WF.hair, lineWidth: 1))
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
                        .foregroundStyle(on ? WF.onInk : WF.ink2)
                        .frame(width: 22, height: 22)
                        .background(on ? WF.onInk.opacity(0.22) : WF.panel).clipShape(Circle())
                }
                Text(label).font(.system(size: 13, weight: .bold)).foregroundStyle(on ? WF.onInk : WF.ink2)
            }
            .padding(.leading, 6).padding(.trailing, 13).padding(.vertical, 6)
            .background(on ? WF.ink : WF.card)
            .overlay(Capsule().strokeBorder(on ? Color.clear : WF.hair, lineWidth: 1))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: month grid

    private func monthGrid(_ byDay: [String: [SyncedEvent]]) -> some View {
        let cells = monthCells(monthAnchor)
        let today = Agenda.todayKey(tz)
        return VStack(spacing: 6) {
            HStack(spacing: 6) {
                ForEach(Array(Cal.rotated(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], from: firstDay).enumerated()), id: \.offset) { _, d in
                    Text(d).font(.system(size: 12, weight: .heavy)).foregroundStyle(WF.ink3).frame(maxWidth: .infinity)
                }
            }
            ForEach(0..<6, id: \.self) { row in
                HStack(spacing: 6) {
                    ForEach(0..<7, id: \.self) { col in
                        let idx = row * 7 + col
                        if idx < cells.count {
                            monthCell(cells[idx], items: byDay[cells[idx].key] ?? [], today: today)
                        } else { Color.clear }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxHeight: .infinity)
    }

    private func monthCell(_ cell: CalendarView.MonthCell, items: [SyncedEvent], today: String) -> some View {
        let isSelected = cell.key == selectedDay
        let isToday = cell.key == today
        return Button { withAnimation { selectedDay = cell.key } } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Text("\(cell.day)")
                        .font(.system(size: 14, weight: isToday ? .heavy : .semibold))
                        .foregroundStyle(cell.inMonth ? (isToday ? .white : WF.ink) : WF.ink3.opacity(0.5))
                        .frame(width: 24, height: 24)
                        .background(isToday ? WF.primary : Color.clear).clipShape(Circle())
                    Spacer(minLength: 0)
                    if let cds = countdowns.byDate[cell.key], let first = cds.first {
                        HStack(spacing: 2) {
                            Text(first.emoji ?? "⏳").font(.system(size: 9))
                            Text(CountdownFormat.short(first.daysLeft)).font(.system(size: 9, weight: .heavy)).foregroundStyle(WF.warn)
                        }
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(WF.warnT).clipShape(Capsule())
                    }
                }
                ForEach(items.prefix(3)) { ev in eventChip(ev) }
                if items.count > 3 {
                    Text("+\(items.count - 3) more").font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 0)
            }
            .padding(7)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(isSelected ? WF.primary.opacity(0.08) : (cell.inMonth ? WF.card : WF.panel.opacity(0.4)))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(isSelected ? WF.primary : WF.hair, lineWidth: isSelected ? 1.5 : 1))
        }
        .buttonStyle(.plain)
    }

    private func eventChip(_ ev: SyncedEvent) -> some View {
        let paint = sync.eventPalette.chip(for: ev)
        return HStack(spacing: 5) {
            RoundedRectangle(cornerRadius: 99).fill(paint.color).frame(width: 3, height: 13)
            Text(chipLabel(ev)).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(paint.foreground).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 5).padding(.vertical, 2)
        .background(paint.background).clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    /// Month-cell chips show the title only — in a narrow cell a leading time pushes the
    /// title out of view, which is the useful part. Tap the day (panel + Day view) for
    /// the times.
    private func chipLabel(_ ev: SyncedEvent) -> String { ev.title }

    // MARK: day panel (month mode)

    private func dayPanel(_ selectedItems: [SyncedEvent]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(relativeLabel(selectedDay)).font(WF.serif(24)).foregroundStyle(WF.ink)
                Text(dateLabel(selectedDay)).font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
                Spacer()
            }
            .padding(.bottom, 14)
            let dayCountdowns = countdownsForDay(selectedDay)
            if selectedItems.isEmpty && dayCountdowns.isEmpty {
                Button { editing = .new(dayKeyToDate(selectedDay) ?? Date()) } label: {
                    VStack(spacing: 10) {
                        Image(systemName: "calendar.badge.plus").font(.system(size: 30)).foregroundStyle(WF.ink3)
                        Text("Nothing scheduled").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink2)
                        Text("Tap to add an event").font(.system(size: 13)).foregroundStyle(WF.ink3)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 40)
                }
                .buttonStyle(.plain)
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 10) {
                        // Countdowns sit at the top as all-day rows (like the phone calendar).
                        ForEach(dayCountdowns) { c in
                            CountdownCard(countdown: c, sleeps: countdowns.sleeps) { openCountdown(c) }
                        }
                        ForEach(selectedItems) { ev in EventCard(event: ev, tz: tz) { detailEvent = ev } }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .padding(18)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    // MARK: agenda (upcoming list + mini-month + heads-up + busy bars)

    private func agendaContent(_ byDay: [String: [SyncedEvent]]) -> some View {
        HStack(alignment: .top, spacing: 20) {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    Text("What's coming up").font(WF.serif(28)).foregroundStyle(WF.ink)
                    // Merge event days with countdown days (today forward) so a day that has
                    // only a countdown still shows up — parity with the phone agenda.
                    let today = Agenda.todayKey(tz)
                    let eventsByDay = Dictionary(uniqueKeysWithValues:
                        Agenda.upcoming(byDay: byDay, from: today).map { ($0.day, $0.items) })
                    let cdDays = countdowns.byDate.filter { $0.key >= today && !$0.value.isEmpty }.keys
                    let days = Set(eventsByDay.keys).union(cdDays).sorted()
                    if days.isEmpty {
                        Text("Nothing upcoming.").font(.system(size: 16)).foregroundStyle(WF.ink3).padding(.vertical, 14)
                    } else {
                        ForEach(days, id: \.self) { day in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(spacing: 8) {
                                    Text(relativeLabel(day)).font(WF.serif(20)).foregroundStyle(WF.ink)
                                    Text(agendaDateLabel(day)).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                                }
                                ForEach(countdownsForDay(day)) { c in
                                    CountdownCard(countdown: c, sleeps: countdowns.sleeps) { openCountdown(c) }
                                }
                                ForEach(eventsByDay[day] ?? []) { ev in EventCard(event: ev, tz: tz) { detailEvent = ev } }
                            }
                        }
                    }
                }
                .padding(.bottom, 20)
            }
            .frame(maxWidth: .infinity)

            ScrollView(showsIndicators: false) {
                VStack(spacing: 16) { miniMonth(byDay); headsUpCard; busyCard(byDay) }
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

    private func miniMonth(_ byDay: [String: [SyncedEvent]]) -> some View {
        let cells = monthCells(miniAnchor)
        let today = Agenda.todayKey(tz)
        return VStack(spacing: 8) {
            HStack {
                Text(DateFmt.string(miniAnchor, "MMMM", tz)).font(WF.serif(20)).foregroundStyle(WF.ink)
                Spacer()
                Button { stepMini(-1) } label: { miniChevron("chevron.left") }
                Button { stepMini(1) } label: { miniChevron("chevron.right") }
            }
            HStack(spacing: 0) {
                ForEach(Array(Cal.rotated(["S", "M", "T", "W", "T", "F", "S"], from: firstDay).enumerated()), id: \.offset) { _, d in
                    Text(d).font(.system(size: 11, weight: .heavy)).foregroundStyle(WF.ink3).frame(maxWidth: .infinity)
                }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 7), spacing: 4) {
                ForEach(cells, id: \.key) { cell in
                    miniCell(cell, events: byDay[cell.key] ?? [], today: today)
                }
            }
        }
        .padding(16)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private func miniCell(_ cell: CalendarView.MonthCell, events: [SyncedEvent], today: String) -> some View {
        let isToday = cell.key == today
        let colors = dotColors(events)
        return Button { withAnimation { selectedDay = cell.key; mode = .day } } label: {
            VStack(spacing: 2) {
                Text("\(cell.day)")
                    .font(.system(size: 13, weight: isToday ? .heavy : .semibold))
                    .foregroundStyle(cell.inMonth ? (isToday ? .white : WF.ink) : WF.ink3.opacity(0.5))
                    .frame(width: 26, height: 26)
                    .background(isToday ? WF.primary : Color.clear).clipShape(Circle())
                HStack(spacing: 2) {
                    ForEach(Array(colors.prefix(3).enumerated()), id: \.offset) { _, hex in
                        Circle().fill(Color(hexString: hex) ?? WF.ink3).frame(width: 4, height: 4)
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
            Image(systemName: "sparkles").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ai)
                .frame(width: 32, height: 32).background(WF.ai.opacity(0.12)).clipShape(Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(headsUp?.headline ?? "Heads up this week").font(.system(size: 15, weight: .heavy)).foregroundStyle(WF.ink)
                if let h = headsUp {
                    Text(h.body).font(.system(size: 13)).foregroundStyle(WF.ink2).fixedSize(horizontal: false, vertical: true)
                } else {
                    HStack(spacing: 6) {
                        Text("Thinking…").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                        ProgressView().controlSize(.small).tint(WF.ai)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WF.ai.opacity(0.06)).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.ai.opacity(0.2), lineWidth: 1))
    }

    @ViewBuilder private func busyCard(_ byDay: [String: [SyncedEvent]]) -> some View {
        let rows = busyRows(byDay)
        if !rows.isEmpty {
            let maxCount = rows.map(\.count).max() ?? 1
            VStack(alignment: .leading, spacing: 12) {
                Text("Whose week is busy?").font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.ink)
                ForEach(rows, id: \.member.id) { row in
                    HStack(spacing: 10) {
                        Avatar(colorHex: row.member.colorHex, emoji: row.member.emoji ?? "🙂", size: 28)
                        Text(row.member.name).font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                            .frame(width: 66, alignment: .leading).lineLimit(1)
                        GeometryReader { g in
                            let tint = Color(hexString: row.member.colorHex) ?? WF.ink3
                            ZStack(alignment: .leading) {
                                Capsule().fill(tint.opacity(0.18))
                                Capsule().fill(tint).frame(width: g.size.width * CGFloat(row.count) / CGFloat(maxCount))
                            }
                        }
                        .frame(height: 10)
                        Text("\(row.count)").font(.system(size: 14, weight: .heavy)).foregroundStyle(WF.ink2)
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
        }
    }

    private func busyRows(_ byDay: [String: [SyncedEvent]]) -> [(member: SyncedMember, count: Int)] {
        var counts: [String: Int] = [:]
        for day in weekDays(Agenda.todayKey(tz)) {
            for e in byDay[day] ?? [] {
                var ids = Set(e.participantIds)
                if let p = e.personId { ids.insert(p) }
                for id in ids { counts[id, default: 0] += 1 }
            }
        }
        return sync.members.compactMap { m in counts[m.id].map { (member: m, count: $0) } }
            .filter { $0.count > 0 }
            .sorted { $0.count > $1.count }
    }

    /// Distinct event colors for the mini-month dots — a whole-family event contributes
    /// the family color, not each attendee's.
    private func dotColors(_ events: [SyncedEvent]) -> [String] {
        var seen = Set<String>(); var colors: [String] = []
        let palette = sync.eventPalette
        for e in events {
            let hex = palette.hex(for: e) ?? "#A6A29B"
            if seen.insert(hex).inserted { colors.append(hex) }
        }
        return colors
    }

    private func stepMini(_ n: Int) {
        let cal = Cal.gregorian(tz)
        if let d = cal.date(byAdding: .month, value: n, to: miniAnchor) { withAnimation { miniAnchor = d } }
    }

    private func miniChevron(_ s: String) -> some View {
        Image(systemName: s).font(.system(size: 11, weight: .heavy)).foregroundStyle(WF.ink2)
            .frame(width: 28, height: 28).background(WF.panel).clipShape(Circle())
    }

    private func loadHeadsUp() async {
        let week = weekDays(Agenda.todayKey(tz))
        guard let from = week.first, let to = week.last else { return }
        headsUp = try? await WaffledAPI().headsUp(from: from, to: to)
    }

    // MARK: helpers

    private func dayKeyToDate(_ key: String) -> Date? { DateFmt.date(key, "yyyy-MM-dd", tz) }

    /// The 7 day keys of the week containing `key`, cut on the household's first day.
    private func weekDays(_ key: String) -> [String] {
        let cal = Cal.gregorian(tz)
        guard let d = dayKeyToDate(key) else { return [] }
        let start = Cal.weekStart(d, tz, firstDay)
        return (0..<7).compactMap { cal.date(byAdding: .day, value: $0, to: start).map { EventTime.dayKey($0, tz) } }
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
        return DateFmt.string(d, "MMM d", tz)
    }

    private func monthCells(_ anchor: Date) -> [CalendarView.MonthCell] {
        let cal = Cal.gregorian(tz)
        let comps = cal.dateComponents([.year, .month], from: anchor)
        guard let first = cal.date(from: comps) else { return [] }
        let anchorMonth = cal.component(.month, from: first)
        let start = Cal.weekStart(first, tz, firstDay)
        return (0..<42).compactMap { i in
            guard let d = cal.date(byAdding: .day, value: i, to: start) else { return nil }
            return CalendarView.MonthCell(key: EventTime.dayKey(d, tz), day: cal.component(.day, from: d),
                                          inMonth: cal.component(.month, from: d) == anchorMonth)
        }
    }
}

/// A web-like time grid: an hour axis with one positioned-event-block column per
/// column key. Used by the Week (7 day columns), Day (1 day column) and People
/// (one column per family member) calendar modes — People is deliberately the SAME
/// grid as Week rather than a lookalike, so a person's column reads exactly like a
/// day's: strict equal-width columns, the same dividers, the same header band.
struct CalTimeGrid: View {
    /// What the column headers show. `.days` = weekday + date (Week); `.none` = no
    /// header band (Day); `.people` = avatar + name per column, in the same order as
    /// `days`, for the People mode where a column is a person rather than a date.
    enum ColumnHeaders: Equatable {
        case none
        case days
        case people([PeopleColumns.Member])
    }

    /// For the family-aware event color + the household's chip style.
    @Environment(SyncManager.self) private var sync
    let days: [String]
    let tz: TimeZone
    /// Prebuilt day → ordered events index (`SyncManager.eventsByDay`, possibly
    /// person-filtered) — each column reads only its own day instead of re-scanning
    /// and re-bucketing the full event list per render.
    let byDay: [String: [SyncedEvent]]
    let headers: ColumnHeaders
    let selectedDay: String
    let onTapEvent: (SyncedEvent) -> Void
    let onAddAt: (Date) -> Void
    let onPickDay: (String) -> Void
    /// Countdowns keyed by day — rendered as chips in the all-day row (Week/Day parity
    /// with the month badge + day panel). Defaulted so non-countdown callers are unaffected.
    var countdownsByDay: [String: [WaffledAPI.Countdown]] = [:]
    var onTapCountdown: (WaffledAPI.Countdown) -> Void = { _ in }
    /// Whether to draw the red "now" rule. Defaults to "the visible days include
    /// today"; People mode passes it explicitly because its column keys are person
    /// ids, not dates, so that test can never match.
    var showsNowLine: Bool? = nil
    /// Hour the grid opens on.
    var scrollToHour: Int = 7

    private let hourHeight: CGFloat = 56
    private let gutter: CGFloat = 56

    private func timed(_ key: String) -> [SyncedEvent] {
        (byDay[key] ?? []).filter { !$0.allDay && $0.startsAt != nil }
            .sorted { ($0.startsAt ?? .distantPast) < ($1.startsAt ?? .distantPast) }
    }
    private func countdowns(_ key: String) -> [WaffledAPI.Countdown] { countdownsByDay[key] ?? [] }
    private func allDay(_ key: String) -> [SyncedEvent] {
        (byDay[key] ?? []).filter(\.allDay)
    }
    private var hasAllDay: Bool { days.contains { !allDay($0).isEmpty || !countdowns($0).isEmpty } }

    var body: some View {
        VStack(spacing: 0) {
            if headers != .none { columnHeaders }
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
                        // Equal-width day columns; overlapping events split into lanes. In
                        // week view each column (after the first) carries a faint leading
                        // divider so the day boundaries read and events align to a day.
                        HStack(spacing: 4) {
                            Color.clear.frame(width: gutter)
                            ForEach(Array(days.enumerated()), id: \.element) { idx, key in
                                GeometryReader { colGeo in
                                    ZStack(alignment: .topLeading) {
                                        // A faint day boundary at each column's leading edge
                                        // (week view), drawn as a sibling of the event blocks
                                        // so it shares their resolved column height.
                                        if days.count > 1 && idx > 0 {
                                            Rectangle().fill(WF.ink.opacity(0.12))
                                                .frame(width: 1, height: 24 * hourHeight)
                                                .offset(x: -2)   // centered in the 4pt column gap
                                                .allowsHitTesting(false)
                                        }
                                        ForEach(placedEvents(key), id: \.event.id) { placed in
                                            block(placed, colWidth: colGeo.size.width)
                                        }
                                    }
                                }
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                            }
                        }
                        .frame(height: 24 * hourHeight, alignment: .topLeading)
                        // The "now" line — a red rule across the grid at the current time,
                        // shown only when the visible range includes today.
                        if showsNowLine ?? days.contains(Agenda.todayKey(tz)) { nowLine }
                    }
                    .frame(height: 24 * hourHeight)
                }
                .background(WF.card)
                .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                // Deliberately NOT `.task(id:)`. This positions the grid when it first
                // appears and then leaves it alone: each `mode` is its own branch of
                // the switch in `content`, so entering People builds a fresh grid and
                // gets its `scrollToHour`, while paging to the next week or day keeps
                // the same grid — and whatever offset you had scrolled to. Keying on
                // `days` would snap you back to the top on every chevron tap, and
                // keying on `scrollToHour` would let any synced event on the visible
                // day yank the grid out from under you mid-read.
                .task {
                    try? await Task.sleep(for: .milliseconds(150))
                    proxy.scrollTo(scrollToHour, anchor: .top)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    /// The header band above the columns. spacing 4 + the leading dividers match the
    /// time grid below, so each header sits over its own column and the separators
    /// line up top-to-bottom.
    private var columnHeaders: some View {
        HStack(spacing: 4) {
            Color.clear.frame(width: gutter, height: 1)
            ForEach(Array(days.enumerated()), id: \.element) { idx, key in
                Group {
                    switch headers {
                    case .people(let members):
                        personHeader(members.indices.contains(idx) ? members[idx] : nil)
                    default:
                        dayHeader(key)
                    }
                }
                .frame(maxWidth: .infinity)
                .overlay(alignment: .leading) {
                    if days.count > 1 && idx > 0 {
                        Rectangle().fill(WF.ink.opacity(0.12)).frame(width: 1, height: 40)
                            .offset(x: -2).allowsHitTesting(false)
                    }
                }
            }
        }
        .frame(height: 48)
        .padding(.bottom, 10)
    }

    private func dayHeader(_ key: String) -> some View {
        let isToday = key == Agenda.todayKey(tz)
        return Button { onPickDay(key) } label: {
            VStack(spacing: 2) {
                Text(weekdayShort(key)).font(.system(size: 12, weight: .heavy)).foregroundStyle(WF.ink3)
                Text(dayNumber(key))
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(isToday ? .white : WF.ink)
                    .frame(width: 30, height: 30)
                    .background(isToday ? WF.primary : Color.clear).clipShape(Circle())
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }

    /// A person as a column header — the same two-line shape as a day header
    /// (avatar where the date circle goes, name where the weekday goes).
    @ViewBuilder private func personHeader(_ member: PeopleColumns.Member?) -> some View {
        VStack(spacing: 3) {
            Text(member?.name ?? "Everyone")
                .font(.system(size: 12, weight: .heavy))
                .foregroundStyle(WF.ink3)
                .lineLimit(1)
            if let member, member.id != PeopleColumns.unassignedId {
                Avatar(colorHex: member.colorHex, emoji: member.avatarEmoji ?? "🙂", size: 30)
            } else {
                Image(systemName: "person.2.fill")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                    .frame(width: 30, height: 30).background(WF.panel).clipShape(Circle())
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var allDayRow: some View {
        HStack(alignment: .top, spacing: 4) {
            Text("all-day").font(.system(size: 10, weight: .heavy)).foregroundStyle(WF.ink3)
                .frame(width: gutter, alignment: .trailing).padding(.trailing, 6)
            ForEach(Array(days.enumerated()), id: \.element) { idx, key in
                VStack(spacing: 3) {
                    // Countdowns first, then all-day events — same order as the day panel.
                    ForEach(countdowns(key)) { c in
                        Button { onTapCountdown(c) } label: { countdownChip(c) }.buttonStyle(.plain)
                    }
                    ForEach(allDay(key)) { ev in
                        Button { onTapEvent(ev) } label: { miniChip(ev) }.buttonStyle(.plain)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .top)
                .overlay(alignment: .topLeading) {
                    if days.count > 1 && idx > 0 {
                        Rectangle().fill(WF.ink.opacity(0.12))
                            .frame(width: 1, height: allDayContentHeight)
                            .offset(x: -2).allowsHitTesting(false)
                    }
                }
            }
        }
        .padding(.vertical, 6).padding(.bottom, 4)
    }

    /// Uniform height for the all-day separators — the tallest day's chip stack (countdowns + all-day events).
    private var allDayContentHeight: CGFloat {
        let n = max(1, days.map { allDay($0).count + countdowns($0).count }.max() ?? 1)
        return CGFloat(n) * 24 + CGFloat(n - 1) * 3
    }

    /// A countdown as an all-day chip (warm-tinted, emoji + title + days-left).
    private func countdownChip(_ c: WaffledAPI.Countdown) -> some View {
        HStack(spacing: 4) {
            Text(c.emoji ?? "⏳").font(.system(size: 10))
            Text(c.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
            Spacer(minLength: 0)
            Text(CountdownFormat.short(c.daysLeft)).font(.system(size: 10, weight: .heavy)).foregroundStyle(WF.warn)
        }
        .padding(.horizontal, 6).padding(.vertical, 3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WF.warnT).clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    /// The all-day pill above the week/day grid — a chip with a background, so the
    /// household's event style applies.
    private func miniChip(_ ev: SyncedEvent) -> some View {
        let paint = sync.eventPalette.chip(for: ev)
        return Text(ev.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(paint.foreground).lineLimit(1)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(paint.background).clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    /// Live red current-time indicator: a dot at the gutter edge + a rule across the
    /// day columns, repositioned every minute.
    private var nowLine: some View {
        TimelineView(.periodic(from: .now, by: 60)) { ctx in
            ZStack(alignment: .leading) {
                Rectangle().fill(Self.nowRed).frame(height: 2).padding(.leading, gutter)
                Circle().fill(Self.nowRed).frame(width: 9, height: 9).offset(x: gutter - 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .offset(y: nowY(ctx.date) - 1)
            .allowsHitTesting(false)
        }
    }

    static let nowRed = Color(red: 0.89, green: 0.22, blue: 0.20)

    private func nowY(_ date: Date) -> CGFloat {
        let cal = Cal.gregorian(tz)
        let c = cal.dateComponents([.hour, .minute], from: date)
        return (CGFloat(c.hour ?? 0) + CGFloat(c.minute ?? 0) / 60) * hourHeight
    }

    private func hourRow(_ h: Int) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(hourLabel(h)).font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                .frame(width: gutter - 8, alignment: .trailing)
            Rectangle().fill(WF.hair).frame(height: 1)
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
            let paint = sync.eventPalette.chip(for: ev)
            Button { onTapEvent(ev) } label: {
                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 99).fill(paint.color).frame(width: 3)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(ev.title).font(.system(size: placed.lanes > 1 ? 12 : 13, weight: .bold))
                            .foregroundStyle(paint.foreground).lineLimit(placed.lanes > 2 ? 1 : 2)
                        if height > 38, placed.lanes < 3 {
                            Text(EventTime.timeLabel(start, tz)).font(.system(size: 11, weight: .medium))
                                .foregroundStyle(paint.foreground.opacity(0.75))
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 6).padding(.vertical, 4)
                .frame(width: max(0, laneW - 3), height: height, alignment: .topLeading)
                .background(paint.background)
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(WF.card, lineWidth: 1))
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
        let cal = Cal.gregorian(tz)
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

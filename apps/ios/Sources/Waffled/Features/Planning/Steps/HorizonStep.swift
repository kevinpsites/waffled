import SwiftUI

/// Weekly Planning · step 3 "Horizon scan" — the month view plus one bar that parks a
/// NOTE (never a calendar entry) tagged for a step still ahead of you. Ported from
/// `apps/web/src/kiosk/planning/steps/HorizonStep.tsx`; nothing here is a second calendar.
///
/// Three rules: the ＋ writes a real event while the bar only parks a note; NOTHING
/// NAVIGATES (the shell owns where the session is); and `props.weekStart` decides which
/// month opens. Content-sized — the SHELL owns the scroll view.
struct HorizonStepView: View {
    let props: PlanningStepProps

    @Environment(SyncManager.self) private var sync
    @State private var model = PlanningHorizonModel()
    @State private var countdowns = CountdownsModel()
    @State private var ahead = 0
    @State private var selectedDay = ""
    @State private var note = ""
    @State private var editing: String?
    @FocusState private var noteFocused: Bool
    @State private var composer: HorizonComposer?
    @State private var pending: PendingComposer?
    @State private var saved = false

    private var tz: TimeZone { sync.householdTz }
    /// Cuts the grid the way THIS HOUSEHOLD cuts a week — the three-argument overload,
    /// never the device-region one.
    private var firstDay: HouseholdWeekStart { sync.householdWeekStart ?? .sunday }
    private var disabled: Bool { props.busy || model.parking }
    private var trimmedNote: String { note.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var floorMonth: (year: Int, month: Int) {
        if let m = PlanningMonth.month(of: props.weekStart) { return m }
        let c = Cal.gregorian(tz).dateComponents([.year, .month], from: Date())
        return (c.year ?? 2026, c.month ?? 1)
    }

    private var anchor: (year: Int, month: Int) {
        PlanningMonth.advance(year: floorMonth.year, month: floorMonth.month, by: ahead)
    }

    var body: some View {
        // Resolved ONCE per render rather than per cell, via the day-indexed
        // `SyncManager.eventsByDay`.
        let cells = PlanningMonth.cells(
            year: anchor.year, month: anchor.month, tz: tz, firstDay: firstDay,
            eventsByDay: sync.eventsByDay, countdownsByDate: countdowns.byDate,
            palette: sync.eventPalette)

        VStack(alignment: .leading, spacing: 14) {
            header

            PlanningMonthGrid(
                cells: cells, firstDay: firstDay, selectedDay: selectedDay,
                todayKey: Agenda.todayKey(tz), onSelect: { selectedDay = $0 })

            dayPanel

            parkBar

            // BELOW the pill, not inside it: five-to-seven chips plus a button make the
            // capture line a cramped scroll, and the sentence under them needs room.
            if !trimmedNote.isEmpty {
                tagRow
                saysLine
            }

            // Not while a board row is open: the editor already shows the refusal, and the
            // same sentence twice reads as two failures.
            if let message = model.errorMessage, editing == nil {
                DismissibleErrorBanner(message: message) { model.clearError() }
            }

            explainer

            board
        }
        .task(id: props.sessionId) {
            await model.load(sessionId: props.sessionId)
            if DemoHooks.focusPark {
                try? await Task.sleep(for: .seconds(1))
                noteFocused = true
            }
        }
        .task { await countdowns.load() }
        .onAppear {
            if selectedDay.isEmpty { selectedDay = props.weekStart }
            props.lendVerb(PlanningHandoffVerb(label: "Make an event") { text, done in
                openComposer(
                    event: nil, day: dayDate(selectedDay), prefillTitle: text, done: done)
            })
        }
        .onDisappear { props.lendVerb(nil) }
        .onChange(of: ahead) { _, _ in selectedDay = focusDay }
        .onChange(of: props.weekStart) { _, _ in
            ahead = 0
            selectedDay = props.weekStart
        }
        .onChange(of: model.revision) { _, _ in props.setDecisionData(model.decisionData) }
        .sheet(item: $composer, onDismiss: composerDismissed) { c in
            // The app's own event sheet, NOT a second event form. `prefillTitle` carries
            // the note somebody already wrote.
            EventEditSheet(event: c.event, initialDate: c.day, prefillTitle: c.prefillTitle,
                           onSaved: { saved = true })
        }
    }

    // MARK: - Month header

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                ahead = max(0, ahead - 1)
            } label: {
                Image(systemName: "chevron.left").font(.system(size: 14, weight: .heavy))
            }
            .buttonStyle(.plain)
            .foregroundStyle(ahead == 0 ? WF.ink3.opacity(0.4) : WF.ink2)
            .disabled(ahead == 0 || props.busy)
            .accessibilityLabel("Previous month")

            Text(PlanningMonth.label(year: anchor.year, month: anchor.month))
                .font(WF.serif(20)).foregroundStyle(WF.ink)

            Button {
                ahead += 1
            } label: {
                Image(systemName: "chevron.right").font(.system(size: 14, weight: .heavy))
            }
            .buttonStyle(.plain)
            .foregroundStyle(WF.ink2)
            .disabled(props.busy)
            .accessibilityLabel("Next month")

            Spacer(minLength: 0)
        }
    }

    // MARK: - The selected day

    @ViewBuilder private var dayPanel: some View {
        let items = sync.eventsByDay[selectedDay] ?? []
        let dayCountdowns = countdowns.byDate[selectedDay] ?? []

        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(relativeLabel(selectedDay)).font(WF.serif(18)).foregroundStyle(WF.ink)
                Text(dateLabel(selectedDay))
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3)
                Spacer(minLength: 0)
            }
            ForEach(items) { event in
                EventCard(event: event, tz: tz) {
                    openComposer(event: event, day: event.startsAt ?? dayDate(selectedDay))
                }
            }
            ForEach(dayCountdowns) { c in
                CountdownCard(countdown: c, sleeps: countdowns.sleeps) {
                    // An event-backed countdown opens its event in place; a standalone or
                    // birthday one is managed where it lives, and the session never
                    // navigates away from itself.
                    if c.source == "event", let ev = sync.events.first(where: { $0.id == c.id }) {
                        openComposer(event: ev, day: ev.startsAt ?? dayDate(selectedDay))
                    }
                }
            }
            Button {
                openComposer(event: nil, day: dayDate(selectedDay))
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus").font(.system(size: 12, weight: .heavy))
                    Text("Add an event on this day").font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(WF.ai).padding(.vertical, 8)
            }
            .buttonStyle(.plain)
            .disabled(props.busy)
        }
    }

    // MARK: - The one thing the session adds

    private var parkBar: some View {
        HStack(spacing: 8) {
            Text("📌").font(.system(size: 15))
            // NOT disabled while the write is in flight: focus on a disabled field is a
            // silent no-op, and this bar puts the cursor back after every note.
            TextField("Park a note — “we’re going camping, we need to pack”", text: $note)
                .font(.system(size: 15))
                .focused($noteFocused)
                .submitLabel(.done)
                .onSubmit { park() }
                // The server's own cap (`parkItem`'s MAX_NOTE), so a long note is stopped
                // here rather than by a 400.
                .onChange(of: note) { _, next in
                    if next.count > 500 { note = String(next.prefix(500)) }
                }
            if trimmedNote.isEmpty {
                Text("a note, not a calendar entry")
                    .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(WF.ink3)
            } else {
                Button("Park it") { park() }
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(disabled ? WF.ink3 : WF.primary)
                    .buttonStyle(.plain)
                    .disabled(disabled)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .wfField()
        // NO `.wfKeyboardDoneToolbar` here, deliberately — see PlanningShellView.sessionScreen.
    }

    /// The tags, plus "No tag" — the ABSENCE of a tag, so never a row the server sends.
    /// The server has already filtered to the steps still ahead.
    private var tagRow: some View {
        ChipFlow(spacing: 6, lineSpacing: 6) {
            ForEach(model.tags, id: \.stepKey) { tag in
                tagChip(
                    label: tag.label,
                    selected: model.chosenStepKey == tag.stepKey,
                    hint: tag.hint) { model.tagChoice = .step(tag.stepKey) }
            }
            tagChip(label: "No tag", selected: model.chosenStepKey == nil, hint: nil) {
                model.tagChoice = .noTag
            }
        }
        .accessibilityLabel("Which step should look at this?")
    }

    /// `.buttonStyle(.plain)` and an explicit foreground on purpose: the default style dims
    /// and re-tints its label while pressed, which reads as the chip unselecting itself.
    private func tagChip(
        label: String, selected: Bool, hint: String?, action: @escaping () -> Void
    ) -> some View {
        // `PlanningTagChip` is lifted out so the note editor's tag row and this one cannot
        // drift — re-tagging and tagging are the same choice.
        PlanningTagChip(
            label: label, selected: selected, hint: hint, disabled: disabled, action: action)
    }

    /// States both outcomes: a tag is a DESTINATION, so that step's handoff banner raises
    /// the note when the session gets there; with no tag it simply stays on the board.
    @ViewBuilder private var saysLine: some View {
        if let label = model.chosenLabel {
            (Text("Comes back at ") + Text(label).bold() + Text(", later in this session."))
                .font(.system(size: 12.5)).foregroundStyle(WF.ink2)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            (Text("No step will raise it.").bold()
                + Text(" It stays on the board — in tonight’s recap, and waiting at Loose ends next session."))
                .font(.system(size: 12.5)).foregroundStyle(WF.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var explainer: some View {
        (Text("Know the day it lands?").bold()
            + Text(" Tap that day on the month above and add it — you get a real calendar event. ")
            + Text("Only know it’s coming?").bold()
            + Text(" Park it in the bar: it stays off the calendar, and comes back at whichever step you tag it for — all of them still ahead of you tonight."))
            .font(.system(size: 12)).foregroundStyle(WF.ink3)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Named, because the read returns every note parked this session whichever bar wrote
    /// it — an unlabelled step-1 note would look like something the month put here.
    @ViewBuilder private var board: some View {
        if !model.parked.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Parked in this session")
                ForEach(model.parked) { n in
                    Group {
                        if editing == n.id {
                            PlanningParkedNoteEditor(
                                note: n.note,
                                stepKey: n.stepKey,
                                tags: model.tags.map {
                                    PlanningParkedTag(stepKey: $0.stepKey, label: $0.label, hint: $0.hint)
                                },
                                busy: props.busy,
                                errorMessage: model.errorMessage,
                                onCancel: {
                                    editing = nil
                                    model.clearError()
                                },
                                onSave: { note, stepKey in
                                    let took = await model.update(
                                        id: n.id, note: note, stepKey: stepKey,
                                        sessionId: props.sessionId)
                                    if took { props.refresh() }
                                    return took
                                })
                        } else {
                            HStack(alignment: .top, spacing: 8) {
                                Text(n.note).font(.system(size: 13.5)).foregroundStyle(WF.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 6)
                                if let label = n.stepLabel {
                                    WaffledStatusBadge(text: label, color: WF.ai)
                                } else {
                                    WaffledStatusBadge(text: "No tag", color: WF.ink3)
                                }
                                Button("Edit") {
                                    model.clearError()
                                    editing = n.id
                                }
                                .font(.system(size: 11.5, weight: .bold))
                                .foregroundStyle(disabled ? WF.ink3 : WF.ai)
                                .buttonStyle(.plain)
                                .disabled(disabled)
                                .accessibilityLabel("Edit “\(n.note)”")
                            }
                        }
                    }
                    .padding(11)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .wfField(fill: WF.panel)
                }
            }
        }
    }

    // MARK: - Actions

    private func park() {
        guard !trimmedNote.isEmpty, !disabled else { return }
        let text = trimmedNote
        Task {
            if await model.park(text, sessionId: props.sessionId) {
                note = ""
                // Parking is a BURST, so the cursor goes back rather than making you re-aim.
                noteFocused = true
                props.refresh()
            }
        }
    }

    private func openComposer(
        event: SyncedEvent?, day: Date, prefillTitle: String? = nil, done: ((Bool) -> Void)? = nil
    ) {
        saved = false
        pending = PendingComposer(isCreate: event == nil, done: done)
        composer = HorizonComposer(event: event, day: day, prefillTitle: prefillTitle)
    }

    /// Did the composer actually create something? `EventEditSheet` reports its own save
    /// through `onSaved`, which fires after the write and before the dismiss, so this is a
    /// flag rather than a guess — and A CANCELLED COMPOSER MUST REPORT FALSE, or a parked
    /// note is settled on the strength of a box opened and closed again.
    private func composerDismissed() {
        guard let p = pending else { return }
        pending = nil
        let created = saved && p.isCreate
        saved = false
        if created {
            model.recordEventAdded()
            props.refresh()
        }
        p.done?(created)
    }

    // MARK: - Small formatting

    private var focusDay: String {
        ahead == 0 ? props.weekStart : String(format: "%04d-%02d-01", anchor.year, anchor.month)
    }

    private func dayDate(_ key: String) -> Date {
        DateFmt.date(key, "yyyy-MM-dd", tz) ?? Date()
    }

    private func relativeLabel(_ key: String) -> String {
        let today = Agenda.todayKey(tz)
        if key == today { return "Today" }
        let cal = Cal.gregorian(tz)
        let tomorrow = EventTime.dayKey(cal.date(byAdding: .day, value: 1, to: Date()) ?? Date(), tz)
        if key == tomorrow { return "Tomorrow" }
        guard let d = DateFmt.date(key, "yyyy-MM-dd", tz) else { return key }
        return DateFmt.string(d, "EEEE", tz)
    }

    private func dateLabel(_ key: String) -> String {
        guard let d = DateFmt.date(key, "yyyy-MM-dd", tz) else { return "" }
        return DateFmt.string(d, "EEE · MMM d", tz)
    }
}

private struct HorizonComposer: Identifiable {
    let id = UUID().uuidString
    let event: SyncedEvent?
    let day: Date
    let prefillTitle: String?
}

/// Remembered ACROSS the sheet's lifetime, so it survives the item being cleared on
/// dismissal.
private struct PendingComposer {
    /// Editing reports `false`: the banner verb only offers to MAKE an event.
    let isCreate: Bool
    let done: ((Bool) -> Void)?
}

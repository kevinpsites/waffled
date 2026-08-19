import SwiftUI

/// Create or edit a rhythm.
///
/// The first thing it asks is the only thing that really matters: **what closes out a
/// period?** Everything below the shape picker follows from that answer, which is why the
/// two branches ask for different anchors (a first due date vs. a period start).
///
/// When editing, the shape and the period anchor are shown but not editable — re-anchoring
/// a live rhythm would silently re-interpret its existing skips (keyed on the period start)
/// and point its bookings at periods that no longer exist. The server refuses those fields
/// for the same reason; retire it and make a new one.
struct RhythmEditorSheet: View {
    let model: RhythmsModel
    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss
    @State private var form: RhythmForm
    @State private var saving = false
    @State private var error: String?

    init(model: RhythmsModel, editing: WaffledAPI.Rhythm? = nil) {
        self.model = model
        _form = State(initialValue: editing.map { RhythmForm(editing: $0) } ?? RhythmForm())
    }

    private var isNew: Bool { form.editingId == nil }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if isNew { shapePicker } else { shapeNote }

                    WaffledFieldCard(title: "What") {
                        HStack(spacing: 10) {
                            TextField("Temple visit", text: $form.title)
                                .font(.system(size: 15))
                                .padding(.horizontal, 12).padding(.vertical, 11)
                                .wfField(radius: WF.rSM, fill: WF.panel)
                            TextField("🛕", text: $form.emoji)
                                .font(.system(size: 15))
                                .multilineTextAlignment(.center)
                                .frame(width: 64)
                                .padding(.vertical, 11)
                                .wfField(radius: WF.rSM, fill: WF.panel)
                        }
                    }

                    WaffledFieldCard(title: "How often") {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(spacing: 10) {
                                Stepper("Every \(form.count)", value: $form.count, in: 1...52)
                                    .font(.system(size: 15, weight: .semibold))
                                Menu {
                                    ForEach(RhythmForm.Unit.allCases) { u in
                                        Button(u.label) { form.unit = u }
                                    }
                                } label: { WaffledMenuPill(text: form.unit.label) }
                            }
                            Text(RhythmFormat.sentence(RhythmFormat.cadenceLabel(form.every)))
                                .font(.system(size: 13)).foregroundStyle(WF.ink3)
                        }
                    }

                    WaffledFieldCard(title: "Who it's for") {
                        Menu {
                            Button("Whole household") { form.personId = nil }
                            ForEach(sync.members) { m in Button(m.name) { form.personId = m.id } }
                        } label: {
                            WaffledMenuPill(text: sync.members.first { $0.id == form.personId }?.name ?? "Whole household")
                        }
                    }

                    if form.shape == .completion { completionFields } else { schedulingFields }

                    WaffledFieldCard(title: form.shape == .completion
                                     ? "Warn me this many days ahead"
                                     : "Start nudging me this many days before the period ends") {
                        VStack(alignment: .leading, spacing: 6) {
                            Stepper("\(form.leadDays) days", value: $form.leadDays, in: 0...365)
                                .font(.system(size: 15, weight: .semibold))
                            Text("Capped at half the cadence — a runway longer than the cycle never closes, so it would never go quiet.")
                                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    WaffledFieldCard(title: "Notes") {
                        TextField("Furnace, 20x25x1", text: $form.notes, axis: .vertical)
                            .lineLimit(2...4)
                            .font(.system(size: 15))
                            .padding(.horizontal, 12).padding(.vertical, 11)
                            .wfField(radius: WF.rSM, fill: WF.panel)
                    }

                    if let error {
                        Text(error).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    WaffledPrimaryCTA(label: isNew ? "Create rhythm" : "Save changes",
                                      isBusy: saving, isDisabled: !form.isValid) {
                        Task { await save() }
                    }
                }
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle(isNew ? "New rhythm" : "Edit rhythm")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    // MARK: the load-bearing choice

    private var shapePicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "What closes out a period")
            shapeOption(.scheduling, title: "It gets scheduled",
                        detail: "Done when it's on the calendar. We never ask whether it happened.")
            shapeOption(.completion, title: "You do it",
                        detail: "The clock restarts from when you actually did it.")
        }
    }

    private func shapeOption(_ shape: WaffledAPI.RhythmShape, title: String, detail: String) -> some View {
        Button { form.shape = shape } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: form.shape == shape ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 18)).foregroundStyle(form.shape == shape ? WF.primary : WF.ink3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    Text(detail).font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .wfField(radius: WF.rMD, fill: form.shape == shape ? WF.primaryT : WF.card)
        }
        .buttonStyle(.plain)
    }

    private var shapeNote: some View {
        LockNote(form.shape == .scheduling
                 ? "This one is closed out by a calendar event existing for the period. That can't be changed — make a new rhythm instead."
                 : "This one is closed out by you doing it. That can't be changed — make a new rhythm instead.")
    }

    // MARK: per-shape anchors

    private var completionFields: some View {
        WaffledFieldCard(title: "First due") {
            DatePicker("First due", selection: $form.nextDue, displayedComponents: [.date])
                .datePickerStyle(.compact)
                .labelsHidden()
                .disabled(!isNew)
                .opacity(isNew ? 1 : 0.5)
        }
    }

    @ViewBuilder private var schedulingFields: some View {
        WaffledFieldCard(title: "Periods start") {
            VStack(alignment: .leading, spacing: 10) {
                DatePicker("Periods start", selection: $form.startsOn, displayedComponents: [.date])
                    .datePickerStyle(.compact)
                    .labelsHidden()
                    .disabled(!isNew)
                    .opacity(isNew ? 1 : 0.5)

                if isNew {
                    Toggle("Put it on the calendar automatically", isOn: $form.autoSchedule)
                        .font(.system(size: 15, weight: .semibold))
                        .tint(WF.primary)
                    if form.autoSchedule {
                        Text("\(Recurrence.describeRrule(form.rrule(), start: form.startsOn)) — booked once, then it just stays there.")
                            .font(.system(size: 12)).foregroundStyle(WF.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                        if form.unit == .months {
                            Menu {
                                Button("The same date") { form.monthlyMode = .dayOfMonth }
                                Button("The same weekday (e.g. the third Saturday)") { form.monthlyMode = .nthWeekday }
                            } label: {
                                WaffledMenuPill(text: form.monthlyMode == .dayOfMonth ? "The same date" : "The same weekday")
                            }
                        }
                    } else {
                        Text("When it happens is an open decision every period, so it'll ask you to pick a time.")
                            .font(.system(size: 12)).foregroundStyle(WF.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private func save() async {
        guard !saving, form.isValid else { return }
        saving = true
        error = nil
        do {
            try await model.save(form)
            dismiss()
        } catch {
            self.error = APIErrorText.message(for: error, fallback: "Couldn’t save that — check the cadence and try again.")
            saving = false
        }
    }
}

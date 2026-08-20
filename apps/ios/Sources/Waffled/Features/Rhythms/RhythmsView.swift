import SwiftUI

/// The rhythms register — the whole list, what state each one is in, and where new ones get
/// made. Mirrors the web `Rhythms.tsx`, and is deliberately split by shape because the two
/// answer different questions: a maintenance rhythm asks "did you do it?", a booking rhythm
/// asks "is it on the calendar?" and never asks the first.
///
/// A `List` (not a hand-rolled stack) so edit / pause / delete ride native `.swipeActions`
/// and `.refreshable`, per the reuse rule in apps/ios/CLAUDE.md.
struct RhythmsView: View {
    @Environment(SyncManager.self) private var sync
    @State private var model = RhythmsModel()
    @State private var creating = false
    @State private var editing: WaffledAPI.Rhythm?
    @State private var booking: WaffledAPI.RhythmAttentionItem?
    @State private var confirmingDelete: WaffledAPI.Rhythm?
    @State private var busyId: String?
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if !model.listLoaded {
                WaffledLoading()
            } else if model.rhythms.isEmpty {
                WaffledEmptyState(
                    emoji: "🔁",
                    title: model.listFailed ? "Couldn’t load your rhythms" : "Nothing here yet",
                    message: model.listFailed
                        ? "Check your connection and pull to refresh."
                        : "A rhythm is a standing intention with a cadence — trash weekly, the air filter every three months, a temple visit each quarter.")
            } else {
                list
            }
        }
        .background(WF.canvas)
        .navigationTitle("Rhythms")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New rhythm")
            }
        }
        .task(id: sync.refreshRev) {
            await model.loadAll()
            await model.loadAttention()
        }
        .sheet(isPresented: $creating) { RhythmEditorSheet(model: model) }
        .sheet(item: $editing) { r in RhythmEditorSheet(model: model, editing: r) }
        .sheet(item: $booking) { item in BookRhythmSheet(item: item, model: model) }
        .confirmationDialog("Delete this rhythm?", isPresented: deletePresented, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let r = confirmingDelete { run(r.id) { try await model.delete(id: r.id) } }
            }
            Button("Cancel", role: .cancel) { confirmingDelete = nil }
        } message: {
            Text("It stops surfacing everywhere. Pausing is the reversible option.")
        }
        .alert("Rhythm unchanged", isPresented: errorPresented) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "That didn’t stick — check your connection and try again.")
        }
    }

    private var deletePresented: Binding<Bool> {
        Binding(get: { confirmingDelete != nil }, set: { if !$0 { confirmingDelete = nil } })
    }

    private var errorPresented: Binding<Bool> {
        Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
    }

    private var list: some View {
        List {
            if !model.scheduling.isEmpty {
                Section {
                    ForEach(model.scheduling) { row($0) }
                } header: {
                    header("It gets scheduled",
                           "A period is closed by a calendar event existing for it. Whether it happened is deliberately not tracked — getting the opportunity onto the calendar is the outcome.")
                }
            }
            if !model.completion.isEmpty {
                Section {
                    ForEach(model.completion) { row($0) }
                } header: {
                    header("You do it",
                           "The clock restarts from when you actually did it, so being late shifts the next one instead of stacking misses.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(WF.canvas)
        .refreshable {
            // The module flags too, so a register left open after someone turned Rhythms
            // off elsewhere finds out on the next pull rather than only when its requests
            // start coming back 403. `reloadModules` rather than `refreshRestSurfaces`:
            // this screen reloads itself on the next two lines, and bumping the shared
            // signal here would make its own `.task(id:)` fire a second, identical load.
            await sync.reloadModules()
            await model.loadAll()
            await model.loadAttention()
        }
    }

    private func header(_ title: String, _ blurb: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: title)
            Text(blurb).font(.system(size: 12)).foregroundStyle(WF.ink3)
                .textCase(nil)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 4)
    }

    @ViewBuilder private func row(_ r: WaffledAPI.Rhythm) -> some View {
        let item = model.attentionItem(for: r.id)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                RhythmGlyph(r)
                VStack(alignment: .leading, spacing: 2) {
                    Text(r.title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    Text(RhythmFormat.cadenceLabel(r.every)).font(.system(size: 12)).foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 6)
                if !r.isActive {
                    WaffledStatusBadge(text: "Paused", color: WF.ink3)
                } else if item != nil {
                    WaffledStatusBadge(text: "Needs attention", color: WF.warn)
                }
            }

            // Precomputed on load (`detailLines`) — no date math per render.
            Text(model.detailLines[r.id] ?? "")
                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)

            if let notes = r.notes, !notes.isEmpty {
                Text(notes).font(.system(size: 12)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 8) {
                if r.satisfiedBy == .completion {
                    // Available whether or not it's due — "I did the filter today" resets
                    // the clock. Once it IS done today the button says so instead of
                    // offering the same action again: the detail line above recomputes to
                    // the identical string, so this label is the only place the tap can be
                    // seen to have landed.
                    let doneToday = RhythmFormat.wasCompletedToday(r.lastCompletedAt)
                    RhythmActionButton(label: RhythmFormat.completionAction(doneToday: doneToday, due: item != nil),
                                       tint: doneToday ? WF.successT : WF.primary,
                                       labelColor: doneToday ? WF.success : .white,
                                       busy: busyId == r.id,
                                       disabled: doneToday) {
                        run(r.id) { try await model.markDone(r.id) }
                    }
                }
                if let item, item.kind == .unscheduled {
                    RhythmActionButton(label: r.autoSchedule ? "Put it back" : "Book a time") { booking = item }
                    Button("Skip this period") { run(r.id) { try await model.skipPeriod(item) } }
                        .font(.system(size: 12, weight: .semibold))
                        .buttonStyle(.plain)
                        .foregroundStyle(WF.ink3)
                        .disabled(busyId == r.id)
                }
                Spacer(minLength: 0)
                Text("\(r.satisfiedBy == .completion ? "nudges" : "starts nudging") \(RhythmFormat.formatInterval(r.leadTime)) ahead")
                    .font(.system(size: 11)).foregroundStyle(WF.ink3)
            }
        }
        .padding(.vertical, 4)
        .listRowBackground(WF.card)
        // Native swipe actions rather than a bespoke control — the rule the pantry's
        // hand-rolled swipe had to be reworked to follow.
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { confirmingDelete = r } label: { Label("Delete", systemImage: "trash") }
            Button { editing = r } label: { Label("Edit", systemImage: "pencil") }.tint(WF.primary)
        }
        .swipeActions(edge: .leading) {
            Button { run(r.id) { try await model.setActive(id: r.id, isActive: !r.isActive) } } label: {
                Label(r.isActive ? "Pause" : "Resume", systemImage: r.isActive ? "pause.circle" : "play.circle")
            }
            .tint(WF.warn)
        }
    }

    private func run(_ id: String, _ work: @escaping () async throws -> Void) {
        guard busyId == nil else { return }
        busyId = id
        confirmingDelete = nil
        Task {
            defer { busyId = nil }
            do { try await work() } catch {
                errorMessage = APIErrorText.message(
                    for: error, fallback: "That didn’t stick — check your connection and try again.")
            }
        }
    }
}

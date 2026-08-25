import SwiftUI

/// The rhythms register — the whole list, what state each one is in, and where new ones get
/// made. Mirrors the web `Rhythms.tsx`, including its grouping: **by when, not by kind**.
///
/// It used to be two sections named after the two shapes, which sorts a household's rhythms
/// by a distinction only the schema cares about. Asked "what do I owe this week", you had to
/// read both and merge them yourself. The shapes don't disappear — they survive in each
/// row's own words ("last done Aug 19" versus "not on the calendar yet") and in its verb,
/// which is where the difference actually bears on what you'd do next.
///
/// "Needs you now" is the server's own `/attention` list and nothing else, so this screen
/// and the Today card can never disagree about a single rhythm.
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
    @State private var backdating: WaffledAPI.Rhythm?
    @State private var busyId: String?
    @State private var errorMessage: String?
    @State private var showPaused = false

    var body: some View {
        // Every state lives inside the one List rather than swapping the List out for a
        // bare view. Two things were wrong with swapping:
        //
        //  • The empty state sized itself to its own content, so `.background(WF.canvas)`
        //    painted a beige band across the middle of an otherwise white screen instead
        //    of the page.
        //  • `.refreshable` was attached to the list, so the state whose message read
        //    "pull to refresh" was the one state that had no pull-to-refresh.
        list
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
        .sheet(item: $backdating) { r in BackdateCompletionSheet(rhythm: r, model: model) }
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
            if !model.listLoaded {
                WaffledLoading().plainRow()
            } else if model.rhythms.isEmpty {
                // A failed load and an empty household are NOT the same statement, so they
                // don't share a message. "Nothing here yet" is a claim about the household;
                // a request that didn't come back is no evidence for it.
                WaffledEmptyState(
                    emoji: model.listFailed ? "😕" : "🔁",
                    title: model.listFailed ? "Couldn’t load your rhythms" : "Nothing here yet",
                    message: model.listFailed
                        ? "Check your connection and pull to refresh. If Rhythms was just switched off in Settings → Modules, that would do it too."
                        : "A rhythm is a standing intention with a cadence — trash weekly, the air filter every three months, a temple visit each quarter.")
                    .plainRow()
            } else if model.listFailed {
                // Rows we already had, plus an honest note that they may now be stale —
                // rather than silently presenting old data as current.
                Text("Showing what loaded last — the latest fetch didn’t come back.")
                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
                    .padding(.horizontal, 20).padding(.vertical, 6)
                    .plainRow()
            }
            ForEach(model.bands) { band in
                Section {
                    ForEach(band.rhythms) { row($0) }
                } header: {
                    header(band.title, band.hint)
                }
            }
            if !model.paused.isEmpty {
                Section {
                    // Named, not counted: "2 paused" alone makes you open it to find out
                    // which, every single time. So the summary says which, and opening it
                    // is for acting on them rather than for identifying them.
                    Button { showPaused.toggle() } label: {
                        HStack(spacing: 8) {
                            Image(systemName: showPaused ? "chevron.down" : "chevron.right")
                                .font(.system(size: 12, weight: .bold))
                            Text("\(model.paused.count) paused — \(model.paused.map(\.title).joined(separator: ", "))")
                                .font(.system(size: 13, weight: .semibold))
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(WF.ink3)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(WF.card)
                    if showPaused {
                        ForEach(model.paused) { row($0) }
                    }
                }
            }
            // AppRoot stacks the tab bar OVER the content, so SwiftUI reserves nothing for
            // it and the last row sits underneath, unreachable however far you scroll —
            // which is what made the bottom of this register impossible to get to. The
            // same trap that once left the pantry item's Edit button untappable.
            // `bottomBarClearance`, not `tabBarClearance`: the iPad kiosk has no bottom bar
            // and shouldn't get 110pt of dead space.
            Color.clear
                .frame(height: WF.bottomBarClearance)
                .plainRow()
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(WF.canvas)
        // Bounce even when the list is short or empty, so pull-to-refresh still triggers —
        // otherwise the failed state can't reach the gesture its own message asks for.
        .scrollBounceBehavior(.always)
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
        let item = model.attentionItem(for: r)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                RhythmGlyph(r)
                VStack(alignment: .leading, spacing: 2) {
                    Text(r.title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    // Precomputed on load (`detailLines`) — no date math per render.
                    Text(model.detailLines[r.id] ?? "")
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                    // How much of the current cycle is already spent. Absent rather than
                    // guessed when there is no window to measure.
                    if let pct = model.progress[r.id] {
                        RhythmProgressBar(percent: pct, late: model.countdowns[r.id]?.unit.contains("late") == true)
                            .padding(.top, 4)
                    }
                }
                Spacer(minLength: 6)
                // The anchor of the row: the one thing worth reading from across a
                // kitchen. It replaces the "Needs attention" badge — a badge said THAT
                // something wanted you, this says how much.
                if let cd = model.countdowns[r.id] {
                    RhythmCountdownLabel(countdown: cd, muted: !r.isActive)
                } else if !r.isActive {
                    WaffledStatusBadge(text: "Paused", color: WF.ink3)
                }
            }

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
                rowMenu(r)
                Spacer(minLength: 0)
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

    /// Edit / pause / retire, as a visible control.
    ///
    /// These existed only as swipe actions, which is why they were reported as not existing
    /// at all: a swipe is invisible until you try it, and the web register draws the same
    /// three as ordinary buttons. The swipes stay — they're the faster path once you know
    /// they're there — but they're no longer the only path.
    ///
    /// Retire sits behind the same confirmation the swipe uses, and says which of the two
    /// is reversible: pausing is, retiring isn't.
    @ViewBuilder private func rowMenu(_ r: WaffledAPI.Rhythm) -> some View {
        Menu {
            if r.satisfiedBy == .completion {
                Button { backdating = r } label: {
                    Label("Log it for another day", systemImage: "calendar.badge.clock")
                }
            }
            // Booking a period whose runway has NOT opened yet. `/attention` structurally
            // cannot report this — it answers "what needs attention by today?" — so
            // without this, a quarterly rhythm you happen to be thinking about in month
            // one simply has no way to be booked from this screen. The row's own button
            // covers the nudged case; this covers the early one, which is the good habit.
            if let early = earlyBooking(r) {
                Button { booking = early } label: {
                    Label(r.autoSchedule ? "Put it back on the calendar" : "Book a time",
                          systemImage: "calendar.badge.plus")
                }
                Button { run(r.id) { try await model.skipPeriod(early) } } label: {
                    Label("Skip this period", systemImage: "forward.end")
                }
            }
            Button { editing = r } label: { Label("Edit", systemImage: "pencil") }
            Button {
                run(r.id) { try await model.setActive(id: r.id, isActive: !r.isActive) }
            } label: {
                Label(r.isActive ? "Pause" : "Resume",
                      systemImage: r.isActive ? "pause.circle" : "play.circle")
            }
            Button(role: .destructive) { confirmingDelete = r } label: {
                Label("Retire", systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(WF.ink3)
        }
        .accessibilityLabel("More options for \(r.title)")
        .disabled(busyId == r.id)
    }

    /// A synthetic attention row for a period that is unbooked but not yet being nudged
    /// about, so the booking sheet can be opened from the menu with the same period bounds
    /// the server would have sent. Nil whenever the row's own button already offers it, or
    /// the period is settled, or the rhythm is paused — offering to book a paused rhythm
    /// would be offering something the server will happily accept and nobody wants.
    private func earlyBooking(_ r: WaffledAPI.Rhythm) -> WaffledAPI.RhythmAttentionItem? {
        guard r.satisfiedBy == .scheduling, r.isActive, r.satisfied != true,
              model.attentionItem(for: r) == nil,
              let start = r.currentPeriodStart, let end = r.currentPeriodEnd else { return nil }
        return WaffledAPI.RhythmAttentionItem(kind: .unscheduled, rhythm: r, dueAt: nil,
                                              overdue: nil, periodStart: start, periodEnd: end)
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

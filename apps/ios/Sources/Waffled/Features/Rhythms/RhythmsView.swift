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
        // Whose rhythm it is, for the row's subtitle. Keyed on the member list and not
        // only on `refreshRev`: members arrive over sync on their own schedule, and taking
        // one snapshot when the screen appears meant a register opened before they landed
        // dropped every name until something unrelated bumped the revision. Observed on a
        // cold open straight to this screen, where the names never came back at all.
        .task(id: sync.members.map(\.id)) { syncNames() }
        .task(id: sync.refreshRev) {
            syncNames()
            await model.loadAll()
            await model.loadAttention()
            // Headless verification of the editor, which is otherwise behind a toolbar
            // button and so unreachable — the simulator has no tap API.
            switch DemoHooks.rhythmEditor {
            case nil: break
            case "new": creating = true
            case let title?: editing = model.rhythms.first { $0.title == title }
            }
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
                    ForEach(band.rhythms) { row($0, urgency: band.urgency) }
                } header: {
                    header(band.title, band.hint, band.rhythms.count)
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
                        ForEach(model.paused) { row($0, urgency: .paused) }
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

    private func header(_ title: String, _ blurb: String, _ count: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                SectionLabel(text: title)
                // How many, next to the name of the band. "Needs you now" answers whether
                // anything does; the number answers how much of your evening it is.
                Text("\(count)")
                    .font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                    .textCase(nil)
                    .monospacedDigit()
            }
            Text(blurb).font(.system(size: 12)).foregroundStyle(WF.ink3)
                .textCase(nil)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 4)
    }

    @ViewBuilder private func row(_ r: WaffledAPI.Rhythm, urgency: RhythmFormat.Urgency) -> some View {
        let doneToday = r.satisfiedBy == .completion && RhythmFormat.wasCompletedToday(r.lastCompletedAt)
        // Only Needs-you-now and Coming-up carry a verb. Most of a healthy register is
        // Steady, and a page of buttons for things with nothing to do reads as a page of
        // chores — which is the opposite of what a rhythm is.
        //
        // `doneToday` is the exception and it earns it: completing something already done
        // today recomputes the row to the identical string, so the button looked dead and
        // got pressed again — the demo household ended up with four rows for one air
        // filter. Finishing it also drops the row into Steady, so without this the
        // acknowledgement would vanish in the same tick the tap landed.
        let showAction = urgency == .now || urgency == .soon || doneToday
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
                        RhythmProgressBar(percent: pct, late: model.countdowns[r.id]?.tone == .late)
                            .padding(.top, 4)
                    }
                }
                // No Spacer here: an expanding frame and an expanding Spacer split the free
                // width between them, so the subtitle wrapped onto a second line with a
                // hundred points of nothing sitting next to it. Same trap that once
                // collapsed the Today card's row title to "T…". The frame does the pushing.
                .frame(maxWidth: .infinity, alignment: .leading)
                // The anchor of the row: the one thing worth reading from across a
                // kitchen. It replaces the "Needs attention" badge — a badge said THAT
                // something wanted you, this says how much.
                if let cd = model.countdowns[r.id] {
                    RhythmCountdownLabel(countdown: cd, muted: !r.isActive)
                } else if !r.isActive {
                    WaffledStatusBadge(text: "Paused", color: WF.ink3)
                }
                // In the top line rather than on one of its own: a row with nothing to do
                // was still spending a whole line on a lone ··· button, which made a quiet
                // register look like a busy one.
                rowMenu(r, urgency: urgency)
            }

            if showAction {
                // One verb, full width. At phone widths there is no room for a title, a
                // countdown and a verb across one line, and the verb is the half that
                // cannot be truncated.
                verb(r, doneToday: doneToday, primary: urgency == .now)
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
            // The design puts this on the swipe, which is the faster path once you know
            // it is there. It is in the ··· menu too, for the same reason edit/pause/retire
            // are: a swipe is invisible until you try it.
            if canPush(r, urgency: urgency) {
                Button { run(r.id) { try await model.pushOut(r) } } label: {
                    Label("Push a week", systemImage: "clock.arrow.circlepath")
                }
                .tint(WF.info)
            }
        }
    }

    /// The row's one verb. Filled when this is late or out of time, quiet when it is
    /// merely coming up — a filled button on every row makes none of them mean anything.
    @ViewBuilder private func verb(_ r: WaffledAPI.Rhythm, doneToday: Bool, primary: Bool) -> some View {
        if r.satisfiedBy == .completion {
            // Available whether or not it's due — "I did the filter today" resets the
            // clock. Once it IS done today the button says so instead of offering the
            // same action again: the subtitle recomputes to the identical string, so this
            // label is the only place the tap can be seen to have landed.
            RhythmActionButton(label: RhythmFormat.completionAction(doneToday: doneToday, due: primary),
                               tint: doneToday ? WF.successT : (primary ? WF.primary : WF.panel),
                               labelColor: doneToday ? WF.success : (primary ? .white : WF.ink),
                               busy: busyId == r.id,
                               disabled: doneToday,
                               fullWidth: true) {
                run(r.id) { try await model.markDone(r.id) }
            }
        } else if let item = period(r) {
            RhythmActionButton(label: needsSeriesBack(r) ? "Put it back" : "Book a time",
                               tint: primary ? WF.primary : WF.panel,
                               labelColor: primary ? .white : WF.ink,
                               fullWidth: true) { booking = item }
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
    /// Whether "push it out" has anything to push away from.
    ///
    /// Only while the rhythm is actually asking: there is nothing to defer on a Steady
    /// row, and a control that does nothing you can feel is one that teaches people the
    /// menu is noise. Completion shape only — a booking rhythm's periods ARE its anchor,
    /// the server refuses the field outright, and Skip is that shape's version of this.
    private func canPush(_ r: WaffledAPI.Rhythm, urgency: RhythmFormat.Urgency) -> Bool {
        r.satisfiedBy == .completion && r.isActive && r.nextDueAt != nil
            && (urgency == .now || urgency == .soon)
    }

    /// The register endpoint carries a person id and no name, so the names are joined on
    /// here from the household the app already has.
    private func syncNames() {
        model.personNames = Dictionary(sync.members.map { ($0.id, $0.name) },
                                       uniquingKeysWith: { a, _ in a })
    }

    @ViewBuilder private func rowMenu(_ r: WaffledAPI.Rhythm, urgency: RhythmFormat.Urgency) -> some View {
        Menu {
            if r.satisfiedBy == .completion {
                Button { backdating = r } label: {
                    Label("Log it for another day", systemImage: "calendar.badge.clock")
                }
                if canPush(r, urgency: urgency) {
                    Button { run(r.id) { try await model.pushOut(r) } } label: {
                        Label("Push it out a week", systemImage: "clock.arrow.circlepath")
                    }
                }
            }
            if let item = period(r) {
                // Booking a period whose runway has NOT opened yet. `/attention`
                // structurally cannot report this — it answers "what needs attention by
                // today?" — so without this, a quarterly rhythm you happen to be thinking
                // about in month one has no way to be booked from this screen at all.
                // The row's own verb covers the nudged case; this covers the early one,
                // which is the good habit.
                if model.attentionItem(for: r) == nil {
                    Button { booking = item } label: {
                        Label(needsSeriesBack(r) ? "Put it back on the calendar" : "Book a time",
                              systemImage: "calendar.badge.plus")
                    }
                }
                // Always here, never beside the verb. Skipping a period is the rarer of
                // the two answers and the one you can't take back, so it doesn't get to
                // sit at thumb height next to the one you meant to press.
                Button { run(r.id) { try await model.skipPeriod(item) } } label: {
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

    /// This rhythm's open period, as the row the booking sheet expects — carrying the
    /// same bounds the server would have sent. Nil when the period is already settled, or
    /// the rhythm is paused: offering to book a paused rhythm would be offering something
    /// the server will happily accept and nobody wants.
    ///
    /// Deliberately NOT `model.attentionItem(for:)`. A period can be booked long before
    /// its runway opens, and that is precisely the case `/attention` cannot report.
    /// Whether booking this rhythm restores a recurrence rather than filling one period.
    /// Only when there is no recurrence left: offering it while the series is alive built
    /// a SECOND series beside the first and doubled every future occurrence.
    private func needsSeriesBack(_ r: WaffledAPI.Rhythm) -> Bool {
        r.autoSchedule && r.hasSeries != true
    }

    private func period(_ r: WaffledAPI.Rhythm) -> WaffledAPI.RhythmAttentionItem? {
        guard r.satisfiedBy == .scheduling, r.isActive, r.satisfied != true,
              let start = r.currentPeriodStart, let end = r.currentPeriodEnd else { return nil }
        return WaffledAPI.RhythmAttentionItem(kind: .unscheduled, rhythm: r, dueAt: nil,
                                              overdue: nil, periodStart: start, periodEnd: end,
                                              hasSeries: r.hasSeries)
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

import SwiftUI

/// Weekly Planning · step 10 "Recap" — "Here's the week you just decided." Ported from
/// `apps/web/src/kiosk/planning/steps/RecapStep.tsx`.
///
/// THE BODY COMPUTES NOTHING. Every headline, sentence and tally arrives resolved from the
/// one read — "every line is a pointer rather than a copy" — so re-adding a count or
/// rewording a decision here would be a second reading of the week, free to drift. The
/// only thing this file decides is layout, and it is SEVEN ROWS: a phone cannot afford the
/// web's strip.
///
/// It deliberately builds no saved frame (the shell owns the finished record and renders
/// this body in it; the TENSE comes off the payload's `savedAt`). Its only writes answer a
/// parked note: drop it, or turn it into a task or an event through the app's own editors,
/// settling the note only if one was saved. Saving the week is the shell's affirmative.
struct RecapStepView: View {
    let props: PlanningStepProps

    @Environment(SyncManager.self) private var sync
    @State private var model = PlanningRecapModel()

    var body: some View {
        // NO OUTER ScrollView: the shell owns the chrome and the scrolling around a step.
        VStack(alignment: .leading, spacing: 14) {
            if let message = model.errorMessage {
                DismissibleErrorBanner(message: message) { model.dismissError() }
            }

            if !model.loaded && model.view == nil {
                WaffledLoading()
            } else if model.view == nil {
                WaffledEmptyState(
                    emoji: "🗒️",
                    title: "Couldn’t read the week back",
                    message: "The week itself is unaffected — saving still records it.")
            } else {
                week
                changed
                targetsCard
                lastCall
                leftAlone
                footNote
            }
        }
        // Keyed on the session: a different session is a different week read back.
        .task(id: props.sessionId) {
            await model.load(sessionId: props.sessionId, weekStart: props.weekStart)
        }
        // The receipt's integers, after the read lands. NEVER straight through: this crumb
        // is a MIRROR the affirmative overwrites, so handing the shell a nil (a fetch that
        // failed offline) is not "no news" — it is the wipe, because `decideStep` writes
        // `data = excluded.data`.
        .onChange(of: model.rev) {
            if let crumb = model.crumb { props.setDecisionData(crumb) }
        }
        // THIS STEP LENDS THE BANNER NOTHING — it is a read with no composer to open.
        // Withdrawn explicitly, because the verb is the SHELL's state and would otherwise
        // still be step 9's.
        .onAppear { props.lendVerb(nil) }
        .sheet(item: composerBinding) { composer in noteEditor(composer) }
    }

    /// `.sheet(item:)` hands nil back for a cancel and a save alike; the model knows which.
    private var composerBinding: Binding<PlanningRecapModel.NoteComposer?> {
        Binding(
            get: { model.composer },
            set: { new in
                guard new == nil else { return }
                Task { await model.composerDismissed(sessionId: props.sessionId) }
            })
    }

    @ViewBuilder
    private func noteEditor(_ composer: PlanningRecapModel.NoteComposer) -> some View {
        // Never a day already past: planning mid-week, or reading a saved week back later,
        // puts the week's start behind today.
        let day = max(DateFmt.date(props.weekStart, "yyyy-MM-dd", .current) ?? Date(),
                      Calendar.current.startOfDay(for: Date()))
        switch composer {
        case let .task(_, note):
            ChoreEditSheet(
                assignableMembers: sync.can("chore.manage")
                    ? sync.members : sync.members.filter { $0.id == sync.currentPersonId },
                currencies: sync.currencies,
                target: .new(personId: nil),
                initialDate: day,
                prefillTitle: note,
                canDelete: false,
                onSave: { _, body in await model.saveChoreFromNote(body) },
                onDelete: { _, _ in "Deleting isn’t part of planning a week." })
        case let .event(_, note):
            eventEditor(day: day, note: note)
        }
    }

    private func eventEditor(day: Date, note: String) -> EventEditSheet {
        var sheet = EventEditSheet(event: nil, initialDate: day, prefillTitle: note)
        sheet.onSaved = { model.eventSaved() }
        return sheet
    }

    // MARK: - The week, one last time

    private var week: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "The week, one last time")
            VStack(spacing: 8) {
                ForEach(model.days) { day($0) }
            }
        }
    }

    /// Busy days opened in place, showing the events the server held back.
    @State private var openDays: Set<String> = []

    private func day(_ row: PlanningRecapDayRow) -> some View {
        WaffledCard(padding: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(spacing: 1) {
                    Text(row.dayName)
                        .font(.system(size: 11.5, weight: .heavy)).tracking(0.4)
                        .foregroundStyle(WF.ink3)
                    Text(row.dayNumber)
                        .font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                }
                .frame(width: 34)

                VStack(alignment: .leading, spacing: 5) {
                    if let meal = row.mealLine {
                        Text(meal)
                            .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(WF.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    let open = openDays.contains(row.date)
                    ForEach(open ? row.events + row.hidden : row.events) { event in
                        eventChip(event)
                    }
                    if row.more > 0 && !open {
                        if row.hidden.isEmpty {
                            Text("+\(row.more) more")
                                .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                        } else {
                            Button { withAnimation { _ = openDays.insert(row.date) } } label: {
                                Text("+\(row.more) more")
                                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    if row.mealLine == nil && row.events.isEmpty && row.more == 0 {
                        Text("Nothing on")
                            .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    /// Painted by THE EVENT'S OWNER through `sync.eventPalette`, which is why the payload
    /// carries `participantIds` rather than a resolved colour. The strip has to agree with
    /// the calendar it is describing, so it follows the household's solid-vs-tinted style
    /// the way the web's `ev-tint` does.
    private func eventChip(_ event: PlanningRecapEventRow) -> some View {
        let paint = sync.eventPalette.chip(for: event.synced)
        return Text(event.title)
            .font(.system(size: 12.5, weight: .semibold))
            .foregroundStyle(paint.foreground)
            .lineLimit(1)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(paint.background)
            .clipShape(Capsule())
            .accessibilityLabel("\(event.title), \(event.when)")
    }

    // MARK: - What tonight changed

    private var changed: some View {
        WaffledCard(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text(PlanningRecapText.changedTitle(saved: model.saved))
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    Spacer(minLength: 6)
                    WaffledStatusBadge(
                        text: PlanningRecapText.decisionsLabel(model.counts.decisions),
                        color: WF.primary)
                }

                ForEach(model.groups) { group in
                    // A row that names a step IS the door to it. `goToStep` shows the step
                    // without moving the session's `currentStep`, so following a recap
                    // line does not tell the kiosk in the kitchen that the family went
                    // back to step 4.
                    if let key = group.stepKey {
                        Button { props.goToStep(key) } label: {
                            groupRow(group, tappable: true)
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens \(group.label)")
                    } else {
                        groupRow(group, tappable: false)
                    }
                }

                if model.nothingDecided {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Nothing was decided in this session")
                            .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(WF.ink)
                        Text(PlanningRecapText.nothingDecidedDetail(saved: model.saved))
                            .font(.system(size: 12)).foregroundStyle(WF.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if !model.groups.isEmpty {
                    Text("Every line is live in the module it names — tap one to go there.")
                        .font(.system(size: 11.5)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: - Still on the board (the last call)

    /// HONESTY 1 — the notes nobody routed anywhere. Two answers, and the quiet one writes
    /// nothing: a note kept parked is still open next Sunday.
    @ViewBuilder private var lastCall: some View {
        let open = model.openLastCall
        if !open.isEmpty || (model.view?.lastCallMore ?? 0) > 0 {
            WaffledCard(padding: 14) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        Text("Still on the board")
                            .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                        Spacer(minLength: 6)
                        WaffledStatusBadge(text: "last call", color: WF.warn)
                    }

                    ForEach(open) { note in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(note.note)
                                .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(WF.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            if let detail = note.detail, !detail.isEmpty {
                                Text(detail)
                                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            HStack(spacing: 12) {
                                if sync.module(.chores) {
                                    Button("Make a task") { model.makeTask(from: note) }
                                        .font(.system(size: 12.5, weight: .bold))
                                        .foregroundStyle(WF.primary)
                                        .buttonStyle(.plain)
                                        .disabled(props.busy || model.working != nil)
                                }
                                Button("Make an event") { model.makeEvent(from: note) }
                                    .font(.system(size: 12.5, weight: .bold))
                                    .foregroundStyle(WF.primary)
                                    .buttonStyle(.plain)
                                    .disabled(props.busy || model.working != nil)
                                Spacer(minLength: 0)
                            }
                            HStack(spacing: 8) {
                                Button("Keep it parked") { model.keepParked(note.id) }
                                    .font(.system(size: 12.5, weight: .bold))
                                    .foregroundStyle(WF.ink2)
                                    .buttonStyle(.plain)
                                    .disabled(props.busy || model.working != nil)
                                Button("Drop it") {
                                    Task { await model.drop(note.id, sessionId: props.sessionId) }
                                }
                                .font(.system(size: 12.5, weight: .bold))
                                .foregroundStyle(WF.danger)
                                .buttonStyle(.plain)
                                .disabled(props.busy || model.working != nil)
                                if model.working == note.id {
                                    ProgressView().controlSize(.small).tint(WF.ink3)
                                }
                                Spacer(minLength: 0)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if let more = model.view?.lastCallMore, more > 0 {
                        Text(PlanningRecapText.lastCallMoreLabel(more))
                            .font(.system(size: 12)).foregroundStyle(WF.ink3)
                    }
                }
            }
        }
    }

    // MARK: - Left alone on purpose

    /// HONESTY 2 — a step that was skipped is a decision, and "nothing this week" is an
    /// answer. These are outcomes, so they are rows of their own rather than gaps in the
    /// card above. `tappable` only adds the affordance — a row that looks tappable and
    /// isn't is worse.
    @ViewBuilder private func groupRow(
        _ group: WaffledAPI.PlanningRecapGroup, tappable: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                // The group names the MODULE the decisions live in — a line names the
                // place you would go to change it.
                Text(group.label)
                    .font(.system(size: 11.5, weight: .heavy)).tracking(0.4)
                    .foregroundStyle(WF.ink3)
                Spacer(minLength: 6)
                WaffledStatusBadge(text: "\(group.count)", color: WF.ink2, weight: .heavy)
                // `isOpen: false` is the plain right-chevron — the shared component, not a
                // raw Image, so it tracks the app's chevron if that ever changes.
                if tappable { DisclosureChevron(isOpen: false) }
            }
            Text(group.headline)
                .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(WF.ink)
                .fixedSize(horizontal: false, vertical: true)
            if !group.detail.isEmpty {
                Text(group.detail)
                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// The targets last week's session set, against what was logged that week.
    @ViewBuilder private var targetsCard: some View {
        if !model.lastWeekTargets.isEmpty {
            WaffledCard(padding: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Last week’s targets")
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    ForEach(model.lastWeekTargets) { t in
                        HStack(alignment: .top, spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(t.emoji.map { "\($0) " } ?? "")\(t.title)")
                                    .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(WF.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(PlanningRecapText.targetLine(t))
                                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
                            }
                            Spacer(minLength: 6)
                            WaffledStatusBadge(
                                text: t.done >= t.target ? "met" : "short",
                                color: t.done >= t.target ? WF.success : WF.ink3)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private var leftAlone: some View {
        if !model.leftAlone.isEmpty {
            WaffledCard(padding: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Left alone on purpose")
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    ForEach(model.leftAlone) { row in
                        HStack(alignment: .top, spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.label)
                                    .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(WF.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(row.detail)
                                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 6)
                            WaffledStatusBadge(text: row.badge, color: Self.badgeColor(row.badge))
                        }
                    }
                }
            }
        }
    }

    /// Three badges, three meanings — and an unrecognised one reads NEUTRAL rather than
    /// alarming, because the catalog is server-owned and a newer server may name a fourth.
    static func badgeColor(_ badge: String) -> Color {
        switch badge {
        case "skipped": return WF.ink2
        case "none": return WF.info
        case "parked": return WF.warn
        default: return WF.ink3
        }
    }

    private var footNote: some View {
        Text(PlanningRecapText.footNote(saved: model.saved))
            .font(.system(size: 12)).foregroundStyle(WF.ink3)
            .fixedSize(horizontal: false, vertical: true)
    }
}

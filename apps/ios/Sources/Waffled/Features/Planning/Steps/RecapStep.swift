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
/// this body above its own tick-list; the TENSE comes off the payload's `savedAt`), no
/// second way to answer a note, and no write of any kind — saving the week is the shell's
/// affirmative.
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
                    ForEach(row.events) { event in
                        eventChip(event)
                    }
                    if row.more > 0 {
                        Text("+\(row.more) more")
                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
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

    /// Tinted by THE EVENT'S OWNER — through `sync.eventPalette`, which is why the payload
    /// carries `participantIds` rather than a resolved colour. The strip has to agree with
    /// the calendar it is describing.
    ///
    /// Always the TINTED treatment, matching the web's `ev-tint`: this is an agenda
    /// surface, not a calendar grid, and a row of solid blocks would shout over the week's
    /// dinners.
    private func eventChip(_ event: PlanningRecapEventRow) -> some View {
        let paint = EventChipPaint(
            sync.eventPalette.color(for: event.synced, fallback: WF.ink3), style: .tinted)
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

import SwiftUI

// Weekly Planning — the session shell: the chrome, the lobby, the "left for now" screen,
// the agenda sheet and the saved record. Every step's BODY lives in its own file behind
// `planningStepBody(_:)`, and the step catalog comes from the server so this screen and
// the web cannot drift.
//
// Ported from `apps/web/src/kiosk/WeeklyPlanning.tsx`; the web keeps "which step" in the
// URL, this keeps it in `PlanningModel.askedStep`.

struct PlanningShellView: View {
    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    @State private var model = PlanningModel()
    @State private var sheet = false
    @State private var confirmDiscard = false
    /// The verb the step on screen has lent the parked-note banner, paired with the step
    /// that lent it, so a verb whose owner is off screen is simply not READ. Do NOT swap
    /// this for an `.onChange(of: current?.key)` that nils it — SwiftUI does not order a
    /// parent's change handler against the child's `.task`, and the banner sticks.
    @State private var handoffVerb: PlanningHandoffVerb?
    @State private var handoffVerbStepKey: String?
    /// A write the STEP owns is in flight (see PlanningStepProps.reportBusy); the footer
    /// goes cold so "Looks right" cannot answer a step mid-write.
    @State private var stepBusy = false

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    var body: some View {
        content
            .background(WF.canvas)
            // Hidden deliberately: `sessionHeader` carries the back chevron itself, and
            // swipe-back still works.
            .toolbar(.hidden, for: .navigationBar)
            // Keyed on the refresh signal, not a bare `.task`: SwiftUI runs a bare one
            // once per appearance, so this screen would sit on launch-time data.
            .task(id: sync.refreshRev) { await model.load() }
            .sheet(isPresented: $sheet) { agendaSheet }
    }

    @ViewBuilder private var content: some View {
        if !sync.module(.weeklyPlanning) {
            WaffledEmptyState(
                emoji: "🗓️",
                title: "Weekly Planning is off",
                message: "Turn it on in Settings → Modules to run a guided session for the week ahead.")
        } else if model.view == nil {
            if model.loaded {
                WaffledEmptyState(
                    emoji: "😕",
                    title: "Couldn’t load the session",
                    message: "Pull to refresh, or check that you’re still signed in.")
            } else {
                WaffledLoading()
            }
        } else if model.hasNoRunnableSteps {
            WaffledEmptyState(
                emoji: "🧩",
                title: "Nothing to run",
                message: "Every step of the session reads a module that’s turned off. Turn one back on in Settings → Modules, or turn individual steps on under Weekly Planning.")
        } else if model.showsRecord {
            recordScreen
        } else if model.isPaused {
            pausedScreen
        } else if model.session == nil {
            lobbyScreen
        } else {
            sessionScreen
        }
    }

    // MARK: - Lobby (no session yet)

    private var lobbyScreen: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                errorBanner
                Text("\(model.sessionDayName)’s session")
                    .font(WF.serif(26, .bold)).foregroundStyle(WF.ink)
                Text("\(model.runnable.count) steps. Jump anywhere, leave whenever the week is decided.")
                    .font(.system(size: 14)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                weekStepper
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(model.actGroups) { group in
                        VStack(alignment: .leading, spacing: 4) {
                            SectionLabel(text: group.act)
                            Text(group.steps.map(\.title).joined(separator: " · "))
                                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.vertical, 2)
                WaffledPrimaryCTA(label: "Start the session", isBusy: model.busy) {
                    Task { await model.start() }
                }
                .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16).padding(.bottom, WF.bottomBarClearance)
        }
    }

    // MARK: - Left for now

    /// Where "Leave for now" puts you: the lobby's job with a session in hand — the week
    /// you were planning is offered rather than forced, and the week stepper is here.
    private var pausedScreen: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                errorBanner
                Text("Left for now").font(WF.serif(26, .bold)).foregroundStyle(WF.ink)
                Text("\(model.weekLabel) is part-planned — \(model.settledCount) of \(model.runnable.count) steps decided. Nothing was lost; pick it up whenever.")
                    .font(.system(size: 14)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                WaffledPrimaryCTA(label: "Resume the session", isBusy: model.busy) { model.resume() }
                planAnotherWeek
                discardBlock
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16).padding(.bottom, WF.bottomBarClearance)
        }
    }

    // MARK: - The record

    private var recordScreen: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                errorBanner
                VStack(alignment: .leading, spacing: 4) {
                    Text("The week is decided").font(WF.serif(26, .bold)).foregroundStyle(WF.ink)
                    Text(model.savedAtLabel.map { "\(model.weekLabel) · saved \($0)" } ?? model.weekLabel)
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                // The recap step's body already reads the week back, so the record renders
                // that rather than a second summary — reached through the seam so a renamed
                // step body can't leave this screen behind.
                if let recap = model.steps.first(where: { $0.key == "recap" }),
                   let sessionId = model.session?.id,
                   let week = model.view?.weekStart {
                    planningStepBody(stepProps(recap, sessionId: sessionId, weekStart: week))
                        .id("record-recap")
                }

                // The tick-list is demoted, not deleted: it carries the one thing the
                // recap can't — which steps were skipped on purpose.
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(text: "What each step decided")
                    WaffledCard(padding: 4) {
                        VStack(spacing: 0) {
                            if model.decidedSteps.isEmpty {
                                Text("Nothing was decided in this session.")
                                    .font(.system(size: 14)).foregroundStyle(WF.ink3)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 11).padding(.vertical, 14)
                            } else {
                                ForEach(Array(model.decidedSteps.enumerated()), id: \.element.key) { i, step in
                                    if i > 0 { Divider().background(WF.hair) }
                                    recordRow(step)
                                }
                            }
                        }
                    }
                }
                Button {
                    Task { await model.reopen() }
                } label: {
                    Text("Reopen the session")
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .wfField()
                }
                .buttonStyle(.plain).disabled(model.busy || stepBusy)
                planAnotherWeek
                discardBlock
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16).padding(.bottom, WF.bottomBarClearance)
        }
    }

    private func recordRow(_ step: WaffledAPI.PlanningStep) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Text(step.isDone ? "✓" : "–")
                .font(.system(size: 15, weight: .heavy))
                .foregroundStyle(step.isDone ? WF.success : WF.ink3)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(step.title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                Text(step.isDone ? step.primary : "Skipped — a real answer")
                    .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
        }
        .padding(.horizontal, 11).padding(.vertical, 12)
    }

    // MARK: - In session

    private var sessionScreen: some View {
        VStack(spacing: 0) {
            sessionHeader
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    errorBanner
                    if let step = model.current, let sessionId = model.session?.id, let week = model.view?.weekStart {
                        let props = stepProps(step, sessionId: sessionId, weekStart: week)
                        PlanningHandoffBanner(
                            step: step,
                            routes: props.routes,
                            busy: model.busy,
                            // A verb belongs to the step that lent it, or a banner two
                            // steps later opens the wrong composer.
                            verb: handoffVerbStepKey == step.key ? handoffVerb : nil,
                            resolve: { id, action in await model.resolveParked(id: id, action: action) })
                            // Per-note "hidden" state is local to the banner and also
                            // remembers which routed rows were acted on this sitting: a
                            // same-step refetch keeps it, a step change clears it.
                            .id(step.key)
                        // Keyed on the step AND THE WEEK: without the week, two sessions
                        // on the same step share one step model and week B keeps week A's
                        // answers (see ConnectionStepModel.seedLinks).
                        planningStepBody(props).id("\(step.key)|\(props.weekStart)")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .padding(.bottom, 12)
            }
            // Why no step body declares `.wfKeyboardDoneToolbar`: that accessory docks on
            // top of this screen's already-pinned footer, and every field here has a return
            // key anyway. Sheets presented FROM a step keep their toolbars.
            .scrollDismissesKeyboard(.interactively)
            sessionFooter
        }
    }

    private var sessionHeader: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 10) {
                if !isKiosk {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink2)
                            .frame(width: 36, height: 36).background(WF.panel).clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Back")
                }

                Text(model.current?.title ?? "")
                    .font(WF.serif(22, .bold)).foregroundStyle(WF.ink)
                    .lineLimit(1).minimumScaleFactor(0.8)

                Spacer(minLength: 6)

                Text(model.weekLabel)
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                    .lineLimit(1)
            }
            HStack(spacing: 10) {
                Button { sheet = true } label: {
                    WaffledMenuPill(text: "\(model.position) of \(model.runnable.count)")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Step \(model.position) of \(model.runnable.count). Open the agenda")

                Spacer(minLength: 6)

                // A SEPARATE control from the chevron above: back pops the screen and
                // leaves the session current (re-opening Planning resumes it), while this
                // parks the session.
                Button { model.leave() } label: {
                    Text("Leave for now")
                        .font(.system(size: 13.5, weight: .bold)).foregroundStyle(WF.ink3)
                }
                .buttonStyle(.plain)
            }
            Text(model.current?.ask ?? "")
                .font(.system(size: 13.5)).foregroundStyle(WF.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 10)
        .overlay(alignment: .bottom) {
            ProgressBar(value: model.progress, tint: WF.primary, track: WF.hair, height: 2)
        }
    }

    private var sessionFooter: some View {
        HStack(spacing: 10) {
            Button {
                Task { await model.answer("skipped") }
            } label: {
                Text("Skip this step")
                    .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink3)
            }
            .buttonStyle(.plain).disabled(model.busy || stepBusy)

            if let step = model.current, let sessionId = model.session?.id, let week = model.view?.weekStart {
                planningStepFooterExtra(stepProps(step, sessionId: sessionId, weekStart: week))
            }

            Spacer(minLength: 8)
            primaryAnswerButton
        }
        .padding(.horizontal, 16).padding(.top, 10)
        // `fixedBarClearance`, NOT `bottomBarClearance`: this footer is pinned, so it sits
        // flush on top of the tab bar. And no clearance at all while a keyboard is docked —
        // `AppRoot` has taken the bar away by then (KeyboardState.hidesBottomBar).
        .padding(.bottom, 10 + (KeyboardState.shared.hidesBottomBar ? 0 : WF.fixedBarClearance))
        .background(WF.card)
        .overlay(alignment: .top) { Rectangle().fill(WF.hair).frame(height: 1) }
    }

    /// Hand-rolled rather than `WaffledPrimaryCTA`: that takes one `label: String` and
    /// fills the width, and this carries two weights beside a Skip control.
    private var primaryAnswerButton: some View {
        Button {
            Task { await model.answer("done") }
        } label: {
            HStack(spacing: 6) {
                if model.busy || stepBusy { ProgressView().controlSize(.small).tint(.white) }
                Text(model.current?.primary ?? "Done")
                    .font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                    .lineLimit(1)
                // "· next: <title>" is a KIOSK affordance: on a phone the two never fit,
                // and the agenda pill one row up already answers "what's next".
                if isKiosk, let next = model.next {
                    Text("· next: \(next.title)")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.75))
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 11)
            .background(model.busy || stepBusy ? WF.ink3 : WF.primary)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
        .buttonStyle(.plain).disabled(model.busy || stepBusy)
    }

    // MARK: - The agenda sheet

    private var agendaSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(model.sessionDayName)’s session")
                            .font(WF.serif(22, .bold)).foregroundStyle(WF.ink)
                        Text("\(model.runnable.count) steps. Jump anywhere, leave whenever the week is decided.")
                            .font(.system(size: 13)).foregroundStyle(WF.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    weekStepper
                    ForEach(model.actGroups) { group in
                        VStack(alignment: .leading, spacing: 8) {
                            SectionLabel(text: group.act)
                            ForEach(group.steps) { step in agendaRow(step) }
                        }
                    }
                    Button {
                        sheet = false
                        model.leave()
                    } label: {
                        Text("Leave for now")
                            .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink2)
                            .frame(maxWidth: .infinity).padding(.vertical, 12)
                            .wfField()
                    }
                    .buttonStyle(.plain)
                    discardBlock
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle("The agenda").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { closeSheet() }
                }
            }
        }
        .modifier(KioskSheetPresentation(kiosk: isKiosk))
    }

    private func agendaRow(_ step: WaffledAPI.PlanningStep) -> some View {
        let here = step.key == model.current?.key
        return Button {
            sheet = false
            Task { await model.jump(to: step.key) }
        } label: {
            HStack(spacing: 11) {
                Text(step.isDone ? "✓" : "\(model.stepNumbers[step.key] ?? 0)")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundStyle(step.isDone ? WF.success : (here ? WF.primary : WF.ink3))
                    .frame(width: 24, height: 24)
                    .background(here ? WF.primary.opacity(0.12) : WF.panel)
                    .clipShape(Circle())
                Text(step.title)
                    .font(.system(size: 15, weight: here ? .heavy : .semibold))
                    .foregroundStyle(step.isSettled && !here ? WF.ink2 : WF.ink)
                Spacer(minLength: 6)
                if here {
                    WaffledStatusBadge(text: "you’re here", color: WF.primary)
                } else if step.isDone {
                    WaffledStatusBadge(text: "decided", color: WF.success)
                } else if step.isSkipped {
                    WaffledStatusBadge(text: "skipped", color: WF.ink3)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .wfField(radius: WF.rSM, fill: here ? WF.primary.opacity(0.06) : WF.card)
        }
        .buttonStyle(.plain).disabled(model.busy || stepBusy)
    }

    private func closeSheet() {
        sheet = false
        confirmDiscard = false
    }

    // MARK: - Shared bits

    /// The week stepper, offered in all four places you'd look for "a different week".
    /// The back arrow floors at the household's CURRENT week — a finished week cannot be
    /// planned.
    private var weekStepper: some View {
        HStack(spacing: 12) {
            Button { Task { await model.goPreviousWeek() } } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundStyle(model.canGoBack ? WF.ink2 : WF.ink3.opacity(0.4))
                    .frame(width: 34, height: 34)
                    .background(WF.panel).clipShape(Circle())
            }
            .buttonStyle(.plain).disabled(!model.canGoBack || model.busy)
            .accessibilityLabel("Plan the previous week")

            Text(model.weekLabel)
                .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                .frame(maxWidth: .infinity)

            Button { Task { await model.goNextWeek() } } label: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .heavy)).foregroundStyle(WF.ink2)
                    .frame(width: 34, height: 34)
                    .background(WF.panel).clipShape(Circle())
            }
            .buttonStyle(.plain).disabled(model.busy || stepBusy)
            .accessibilityLabel("Plan the next week")
        }
    }

    private var planAnotherWeek: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Plan another week")
            weekStepper
        }
    }

    /// Start the week over. The lobby is otherwise unreachable once a session exists, so
    /// without this a week started by mistake could never be undone. Two-tap: no undo.
    @ViewBuilder private var discardBlock: some View {
        if confirmDiscard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Throw this session away and start the week over? What it already decided — events added, chores handed out — stays put; only the session is discarded.")
                    .font(.system(size: 12.5)).foregroundStyle(WF.ink2)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Button { confirmDiscard = false } label: {
                        Text("Keep it").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink2)
                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                            .background(WF.panel).clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    Button {
                        confirmDiscard = false
                        sheet = false
                        Task { await model.discard() }
                    } label: {
                        Text("Start over").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                            .background(WF.danger).clipShape(Capsule())
                    }
                    .buttonStyle(.plain).disabled(model.busy || stepBusy)
                }
            }
            .padding(12)
            .background(WF.dangerT)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        } else if model.session != nil {
            Button { confirmDiscard = true } label: {
                Text("Start this week over")
                    .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.danger)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 2)
        }
    }

    @ViewBuilder private var errorBanner: some View {
        if let message = model.errorMessage {
            DismissibleErrorBanner(message: message) { model.dismissError() }
        }
    }

    private func stepProps(
        _ step: WaffledAPI.PlanningStep, sessionId: String, weekStart: String
    ) -> PlanningStepProps {
        PlanningStepProps(
            step: step,
            sessionId: sessionId,
            weekStart: weekStart,
            setDecisionData: { model.setDecisionData($0) },
            refresh: { Task { await model.load() } },
            busy: model.busy,
            // Off the looseEnds step's OWN row — see `PlanningStepProps.routes`. A step
            // that hasn't run yet has no `routes` key, hence `?? []`.
            routes: PlanningRouteSeed.decode(model.steps.first { $0.key == "looseEnds" }?.data["routes"]),
            goToStep: { model.show($0) },
            lendVerb: { verb in
                handoffVerb = verb
                handoffVerbStepKey = verb == nil ? nil : step.key
            },
            reportBusy: { stepBusy = $0 })
    }
}

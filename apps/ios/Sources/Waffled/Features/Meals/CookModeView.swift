import SwiftUI
import AVFoundation
import UserNotifications

/// One concurrent cook-mode timer. Counts down off an absolute `fireAt` `Date` (set
/// from the step's total seconds) so it stays accurate across backgrounding — the
/// on-screen ticker only *reads* `remaining`, it never owns the source of truth.
/// `firing` flips when `fireAt` passes (live or on foreground), driving the alarm.
struct CookTimer: Identifiable, Equatable {
    let id = UUID()
    /// Notification identifier so we can cancel/replace the matching local alarm.
    let notifId: String
    let label: String          // "Step N"
    let stepIndex: Int         // where "Jump to step" lands
    let total: Int             // seconds, for +1:00 / restart math
    var fireAt: Date           // absolute instant it hits zero
    var running: Bool          // false = paused
    var firing: Bool           // true = ringing, shows the alarm overlay
    /// Remaining when paused — so resume re-anchors `fireAt` from this, not the clock.
    var pausedRemaining: Int

    /// Live seconds remaining (clamped ≥ 0). Reads the wall clock for running timers,
    /// the frozen value for paused ones.
    var remaining: Int {
        if !running { return max(0, pausedRemaining) }
        return max(0, Int(fireAt.timeIntervalSinceNow.rounded()))
    }

    static func mmss(_ secs: Int) -> String {
        let s = max(0, secs)
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    /// A self-describing name combining the step and this timer's duration —
    /// e.g. "Step 5 · 3-minute timer". Several timers can ring at once
    /// (`firingTimer = timers.first { $0.firing }`), so both the in-app alarm and
    /// the background notification use this to say *which* timer is up.
    var displayName: String {
        let m = total / 60, s = total % 60
        let duration: String
        if m > 0 && s == 0 { duration = "\(m)-minute" }
        else if m == 0 { duration = "\(s)-second" }
        else { duration = CookTimer.mmss(total) }
        return "\(label) · \(duration) timer"
    }
}

/// Full-screen, step-by-step cook mode — big type for across-the-kitchen reading,
/// a progress bar, the current step's ingredients, and a finish button that marks
/// the recipe cooked. Keeps the screen awake while you cook. Mirrors the kiosk
/// `CookMode`.
///
/// Per-step timers live here (not on the step subview) so they survive step
/// navigation: starting a 10-min timer on step 2 keeps counting while you read
/// step 3. A single ticker re-renders all of them; each timer counts off an
/// absolute fire `Date` so it stays correct even if the app is backgrounded, and
/// it also schedules a local notification so the alarm reaches you outside the app.
struct CookModeView: View {
    let title: String
    let steps: [WaffledAPI.RecipeStepDTO]
    let ingredients: [WaffledAPI.RecipeIngredientDTO]
    /// Called when the cook taps "Finish & mark cooked" on the last step.
    let onFinish: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var index = 0
    @State private var showOverview = false

    // Timer state — owned by the screen so it outlives step navigation.
    @State private var timers: [CookTimer] = []
    @State private var alarm = TimerAlarm()
    /// One ticker drives every timer's countdown + fire detection.
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var step: WaffledAPI.RecipeStepDTO? { steps.indices.contains(index) ? steps[index] : nil }
    private var isLast: Bool { index >= steps.count - 1 }
    private var progress: Double { steps.isEmpty ? 0 : Double(index + 1) / Double(steps.count) }
    private var isKiosk: Bool { DeviceExperience.current == .kiosk }
    /// Big across-the-kitchen type — larger on the iPad wall display than the phone.
    private var instructionSize: CGFloat { isKiosk ? 56 : 38 }
    private var firingTimer: CookTimer? { timers.first { $0.firing } }
    private var dockTimers: [CookTimer] { timers.filter { !$0.firing } }

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                topBar
                ProgressView(value: progress).tint(WF.primary).padding(.horizontal, 20)

                // The current step, centered in the available space — but scrollable so a
                // long step is never clipped (short steps sit dead-center; long ones scroll).
                // On the iPad wall display (kiosk) the step's ingredients move into a fixed
                // LEFT sidebar so they stay visible while the big instruction fills the rest;
                // on the phone we keep the single scrolling column with ingredients inline.
                GeometryReader { geo in
                    if isKiosk {
                        HStack(alignment: .top, spacing: 0) {
                            if stepHasIngredients {
                                ingredientsSidebar
                            }
                            stepScroll(geo)
                        }
                    } else {
                        stepScroll(geo)
                    }
                }

                navBar
            }
            .background(WF.canvas)

            if !dockTimers.isEmpty && firingTimer == nil {
                // Pinned bottom-right and width-capped, so it occupies one side instead of
                // spanning the whole screen.
                HStack {
                    Spacer(minLength: 0)
                    VStack { Spacer(); timerDock }.frame(maxWidth: 360)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 92)
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }

            if let firing = firingTimer {
                alarmOverlay(firing)
                    .transition(.opacity)
            }
        }
        .onAppear {
            UIApplication.shared.isIdleTimerDisabled = true
            Task { await alarm.prepare() }
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            alarm.stop()
            for t in timers { alarm.cancelNotification(t.notifId) }
        }
        .onReceive(tick) { _ in refreshFiring() }
        .onChange(of: scenePhase) { _, phase in
            // A timer can hit zero while backgrounded — re-evaluate on return.
            if phase == .active { refreshFiring() }
        }
        .sheet(isPresented: $showOverview) { allIngredientsSheet }
    }

    // MARK: step content

    private var stepHasIngredients: Bool { !(step?.ingredients.isEmpty ?? true) }

    /// The scrolling step column — STEP label, the big instruction, the timer control,
    /// and the optional note. On the phone the step's ingredients render inline
    /// underneath; on the iPad they live in `ingredientsSidebar` instead.
    private func stepScroll(_ geo: GeometryProxy) -> some View {
        ScrollView {
            // Left-aligned and using the full width (with margins) so the big
            // type fills the screen instead of wrapping into a narrow center
            // column — long steps fit without scrolling.
            stepColumn
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, isKiosk ? 56 : 28).padding(.vertical, 24)
            // Leave room so the floating dock never hides content.
            .padding(.bottom, dockTimers.isEmpty ? 0 : 96)
            // Center vertically when the step is short; grow (and scroll) when long.
            .frame(minHeight: geo.size.height, alignment: .center)
        }
    }

    /// STEP label + instruction + timer control + note. On the phone the step's
    /// ingredient chips render inline between the timer and the note (the original
    /// single-column order); on the iPad they're pulled out into `ingredientsSidebar`.
    private var stepColumn: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("STEP \(step?.stepNumber ?? index + 1) OF \(steps.count)")
                .font(.system(size: 14, weight: .heavy)).tracking(1.4)
                .foregroundStyle(Color(hex: 0x167A4A))
            Text(step?.instruction ?? "")
                .font(WF.serif(instructionSize, .semibold)).foregroundStyle(WF.ink)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let secs = step?.timerSeconds, secs > 0 {
                startTimerButton(secs: secs)
            } else {
                // Step has no built-in timer — let the cook add one on the
                // fly, tied to this step via the same runtime timer path.
                // `id(index)` resets the control when navigating steps.
                AddTimerControl { secs in
                    startTimer(secs: secs, stepIndex: index, stepNumber: step?.stepNumber ?? index + 1)
                }
                .id(index)
            }
            // Phone: ingredients inline here (between the timer and the note) — the
            // original single-column order. On iPad they live in the left sidebar instead.
            if !isKiosk, let igs = step?.ingredients, !igs.isEmpty {
                ingredientChips(igs)
            }
            if let note = step?.note {
                Text("📝 \(note)").font(.system(size: isKiosk ? 19 : 16)).foregroundStyle(WF.ink2)
                    .multilineTextAlignment(.leading)
                    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            }
        }
    }

    /// iPad-only: the current step's ingredients in a fixed-width, scrollable LEFT
    /// sidebar (with an "INGREDIENTS" header) so they stay put while cooking. On the
    /// phone the chips render inline inside `stepColumn` instead.
    @ViewBuilder private var ingredientsSidebar: some View {
        if let igs = step?.ingredients, !igs.isEmpty {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("INGREDIENTS")
                        .font(.system(size: 13, weight: .heavy)).tracking(1.2)
                        .foregroundStyle(WF.ink3)
                    ingredientChips(igs)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 24).padding(.vertical, 28)
            }
            .frame(width: 300)
            .background(WF.panel)
        }
    }

    private func ingredientChips(_ igs: [String]) -> some View {
        ChipFlow(spacing: 8, lineSpacing: 8, alignment: .leading) {
            ForEach(igs, id: \.self) { ig in
                Text(ig).font(.system(size: isKiosk ? 18 : 15, weight: .medium))
                    .foregroundStyle(Color(hex: 0x167A4A))
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(Color(hex: 0x167A4A).opacity(0.12))
                    .clipShape(Capsule())
            }
        }
    }

    // MARK: timer UI

    private func startTimerButton(secs: Int) -> some View {
        Button {
            startTimer(secs: secs, stepIndex: index, stepNumber: step?.stepNumber ?? index + 1)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "timer").font(.system(size: 16, weight: .bold))
                Text("Start \(CookTimer.mmss(secs))").font(.system(size: 17, weight: .bold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 18).padding(.vertical, 12)
            .background(WF.primary).clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    /// Floating dock of running/paused timers — stays put across step navigation.
    /// Wrapped in a TimelineView so each timer's remaining ticks live every second
    /// (the parent's per-second pass alone didn't reliably refresh the dock — e.g. a
    /// timer froze at its new value right after "+1:00" until you paused/resumed it).
    private var timerDock: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            VStack(spacing: 8) {
                ForEach(dockTimers) { t in
                    HStack(spacing: 12) {
                        // Tap the timer to jump to its step (the timer keeps running).
                        Button { goToStep(t) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "timer").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.primaryD)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(t.label).font(.system(size: 11, weight: .heavy)).tracking(0.6).foregroundStyle(WF.ink2)
                                    Text(CookTimer.mmss(t.remaining))
                                        .font(.system(size: 22, weight: .heavy, design: .rounded))
                                        .monospacedDigit().foregroundStyle(WF.ink)
                                }
                            }
                            .contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        Spacer(minLength: 8)
                        Button { togglePause(t) } label: {
                            Image(systemName: t.running ? "pause.fill" : "play.fill")
                                .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                                .frame(width: 34, height: 34).background(WF.panel).clipShape(Circle())
                        }.buttonStyle(.plain)
                        Button { dismissTimer(t) } label: {
                            Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                                .frame(width: 34, height: 34).background(WF.panel).clipShape(Circle())
                        }.buttonStyle(.plain)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(WF.card)
                    .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).stroke(WF.hair, lineWidth: 1))
                    .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
                }
            }
        }
    }

    /// Full-screen "Timer done" alarm — Jump to step / +1:00 / Dismiss.
    private func alarmOverlay(_ t: CookTimer) -> some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea()
            VStack(spacing: 18) {
                Image(systemName: "timer").font(.system(size: 44, weight: .bold)).foregroundStyle(WF.primary)
                Text("Timer done").font(WF.serif(28, .bold)).foregroundStyle(WF.ink)
                Text(t.displayName).font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink2)

                VStack(spacing: 10) {
                    Button { jumpTo(t) } label: {
                        Text("Jump to \(t.label)").font(.system(size: 17, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(WF.ink).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    }.buttonStyle(.plain)

                    HStack(spacing: 10) {
                        Button { addMinute(t) } label: {
                            Text("+1:00").font(.system(size: 17, weight: .bold)).foregroundStyle(WF.primaryD)
                                .frame(maxWidth: .infinity).padding(.vertical, 14)
                                .background(WF.primary.opacity(0.14)).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                        }.buttonStyle(.plain)
                        Button { dismissTimer(t) } label: {
                            Text("Dismiss").font(.system(size: 17, weight: .bold)).foregroundStyle(WF.ink2)
                                .frame(maxWidth: .infinity).padding(.vertical, 14)
                                .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                        }.buttonStyle(.plain)
                    }
                }
            }
            .padding(26)
            .frame(maxWidth: 360)
            .background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
            .shadow(color: .black.opacity(0.25), radius: 30, y: 10)
            .padding(28)
        }
    }

    // MARK: timer actions

    private func startTimer(secs: Int, stepIndex: Int, stepNumber: Int) {
        let notifId = "waffled.cook.\(UUID().uuidString)"
        let fireAt = Date().addingTimeInterval(TimeInterval(secs))
        let t = CookTimer(notifId: notifId, label: "Step \(stepNumber)", stepIndex: stepIndex,
                          total: secs, fireAt: fireAt, running: true, firing: false, pausedRemaining: secs)
        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { timers.append(t) }
        alarm.scheduleNotification(id: notifId, fireAt: fireAt, name: t.displayName)
    }

    private func togglePause(_ t: CookTimer) {
        guard let i = timers.firstIndex(where: { $0.id == t.id }) else { return }
        if timers[i].running {
            // Pause: freeze remaining, drop the pending notification.
            timers[i].pausedRemaining = timers[i].remaining
            timers[i].running = false
            alarm.cancelNotification(timers[i].notifId)
        } else {
            // Resume: re-anchor fireAt from the frozen remaining, reschedule the alarm.
            let rem = max(1, timers[i].pausedRemaining)
            timers[i].fireAt = Date().addingTimeInterval(TimeInterval(rem))
            timers[i].running = true
            alarm.scheduleNotification(id: timers[i].notifId, fireAt: timers[i].fireAt, name: timers[i].displayName)
        }
    }

    private func dismissTimer(_ t: CookTimer) {
        alarm.cancelNotification(t.notifId)
        withAnimation { timers.removeAll { $0.id == t.id } }
        if timers.allSatisfy({ !$0.firing }) { alarm.stop() }
    }

    private func jumpTo(_ t: CookTimer) {
        if steps.indices.contains(t.stepIndex) { withAnimation { index = t.stepIndex } }
        dismissTimer(t)
    }

    /// Tap a running dock timer → jump to its step, keeping the timer counting (unlike
    /// the alarm's "Jump to step", which clears the finished timer).
    private func goToStep(_ t: CookTimer) {
        if steps.indices.contains(t.stepIndex) { withAnimation { index = t.stepIndex } }
    }

    private func addMinute(_ t: CookTimer) {
        guard let i = timers.firstIndex(where: { $0.id == t.id }) else { return }
        timers[i].firing = false
        timers[i].running = true
        timers[i].fireAt = Date().addingTimeInterval(60)
        timers[i].pausedRemaining = 60
        alarm.scheduleNotification(id: timers[i].notifId, fireAt: timers[i].fireAt, name: timers[i].displayName)
        if timers.allSatisfy({ !$0.firing }) { alarm.stop() }
    }

    /// Flip any running timer whose fire instant has passed into `firing`; start/stop
    /// the alarm so it follows whether anything is ringing. Called every tick and on
    /// foreground (a timer can reach zero while the app is backgrounded).
    private func refreshFiring() {
        var becameFiring = false
        for i in timers.indices where timers[i].running && !timers[i].firing {
            if timers[i].remaining <= 0 {
                timers[i].firing = true
                timers[i].running = false
                becameFiring = true
            }
        }
        let anyFiring = timers.contains { $0.firing }
        if anyFiring { alarm.start() } else { alarm.stop() }
        if becameFiring {
            // The in-app alarm already covers the firing timer; drop its pending notif.
            for t in timers where t.firing { alarm.cancelNotification(t.notifId) }
        }
    }

    // MARK: chrome

    private var topBar: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink2)
            }
            Spacer()
            Text(title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink).lineLimit(1)
            Spacer()
            Button { showOverview = true } label: {
                Image(systemName: "list.bullet").font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink2)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
    }

    private var navBar: some View {
        HStack(spacing: 12) {
            Button { withAnimation { index = max(0, index - 1) } } label: {
                Text("Back").font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink2)
                    .frame(maxWidth: .infinity).padding(.vertical, 15)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            }
            .buttonStyle(.plain).opacity(index == 0 ? 0.4 : 1).disabled(index == 0)

            if isLast {
                Button { onFinish(); dismiss() } label: {
                    Text("✓ Finish & mark cooked").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 15)
                        .background(WF.primary).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }
                .buttonStyle(.plain)
            } else {
                Button { withAnimation { index = min(steps.count - 1, index + 1) } } label: {
                    Text("Next").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 15)
                        .background(WF.ink).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 16)
    }

    /// The recipe overview: every step (tap to jump to it) and the full ingredient
    /// list, in one large sheet — so the list button is "see the whole recipe", not
    /// just ingredients.
    private var allIngredientsSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 10) {
                        sectionLabel("STEPS")
                        ForEach(Array(steps.enumerated()), id: \.element.id) { i, st in
                            Button {
                                withAnimation { index = i }
                                showOverview = false
                            } label: { overviewStepRow(i, st) }
                            .buttonStyle(.plain)
                            if st.id != steps.last?.id { Divider().background(WF.hair) }
                        }
                    }
                    if !ingredients.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            sectionLabel("INGREDIENTS")
                            ForEach(ingredients) { ing in
                                HStack(alignment: .top, spacing: 12) {
                                    Text(amountText(ing)).font(.system(size: 15, weight: .semibold, design: .rounded))
                                        .foregroundStyle(WF.ink2).frame(width: 70, alignment: .trailing)
                                    Text(ing.sub ?? ing.name).font(.system(size: 16)).foregroundStyle(WF.ink)
                                    Spacer(minLength: 0)
                                }
                                .padding(.vertical, 8)
                                if ing.id != ingredients.last?.id { Divider().background(WF.hair) }
                            }
                        }
                    }
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showOverview = false } } }
        }
        .presentationDetents([.large])
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text).font(.system(size: 12, weight: .heavy)).tracking(1.2).foregroundStyle(WF.ink3)
    }

    /// A tappable step row in the overview — number badge, the (current-highlighted)
    /// instruction, and a chevron. Tapping jumps Cook Mode to that step.
    private func overviewStepRow(_ i: Int, _ st: WaffledAPI.RecipeStepDTO) -> some View {
        let isCurrent = i == index
        return HStack(alignment: .top, spacing: 12) {
            Text("\(st.stepNumber)")
                .font(.system(size: 14, weight: .heavy)).foregroundStyle(isCurrent ? .white : Color(hex: 0x167A4A))
                .frame(width: 28, height: 28)
                .background(isCurrent ? Color(hex: 0x167A4A) : Color(hex: 0x167A4A).opacity(0.12)).clipShape(Circle())
            Text(st.instruction).font(.system(size: 16, weight: isCurrent ? .semibold : .regular))
                .foregroundStyle(WF.ink).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                .padding(.top, 5)
        }
        .padding(.vertical, 8).contentShape(Rectangle())
    }

    private func amountText(_ ing: WaffledAPI.RecipeIngredientDTO) -> String {
        guard let amt = ing.amount else { return "" }
        return RecipeAmount.format(amt) + (ing.unit.map { " \($0)" } ?? "")
    }
}

/// On-the-spot timer for a step the author never gave one. Collapsed to a dashed
/// "⏱ Add timer" pill; expands to minute + second steppers and starts an ephemeral
/// (runtime-only) timer via the parent's `startTimer` path — so it lives in the dock,
/// chimes, and stays tied to its step. Nothing is persisted to `step.timerSeconds`.
/// Mirrors the web kiosk `AddTimer`.
private struct AddTimerControl: View {
    /// Called with the chosen total seconds when the cook taps Start.
    let onStart: (Int) -> Void

    @State private var open = false
    @State private var minutes = 0
    @State private var seconds = 0

    private var total: Int { max(0, minutes) * 60 + max(0, min(59, seconds)) }

    var body: some View {
        if open {
            form
        } else {
            Button {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { open = true }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "timer").font(.system(size: 16, weight: .bold))
                    Text("Add timer").font(.system(size: 17, weight: .bold))
                }
                .foregroundStyle(WF.primaryD)
                .padding(.horizontal, 18).padding(.vertical, 12)
                .background(
                    Capsule().stroke(style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                        .foregroundStyle(WF.primary.opacity(0.6))
                )
            }
            .buttonStyle(.plain)
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 18) {
                field("MINUTES", value: $minutes, range: 0...600)
                field("SECONDS", value: $seconds, range: 0...59)
            }
            HStack(spacing: 10) {
                Button {
                    guard total > 0 else { return }
                    onStart(total)
                    reset()
                } label: {
                    Text("Start \(CookTimer.mmss(total))").font(.system(size: 17, weight: .bold)).foregroundStyle(.white)
                        .padding(.horizontal, 18).padding(.vertical, 12)
                        .background(total > 0 ? WF.primary : WF.ink3).clipShape(Capsule())
                }
                .buttonStyle(.plain).disabled(total <= 0)

                Button { reset() } label: {
                    Text("Cancel").font(.system(size: 17, weight: .semibold)).foregroundStyle(WF.ink2)
                        .padding(.horizontal, 18).padding(.vertical, 12)
                        .background(WF.panel).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(16)
        .background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).stroke(WF.hair, lineWidth: 1))
    }

    /// A labeled wheel picker — flick straight to any value (a stepper would take
    /// forever to reach, say, 45 seconds), big enough to poke across the kitchen.
    private func field(_ label: String, value: Binding<Int>, range: ClosedRange<Int>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.system(size: 11, weight: .heavy)).tracking(0.8).foregroundStyle(WF.ink3)
            Picker(label, selection: value) {
                ForEach(Array(range), id: \.self) { n in
                    Text(String(format: "%02d", n))
                        .font(.system(size: 24, weight: .heavy, design: .rounded)).monospacedDigit()
                        .foregroundStyle(WF.ink)
                        .tag(n)
                }
            }
            .pickerStyle(.wheel)
            .frame(width: 92, height: 116)
            .clipped()
        }
    }

    private func reset() {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
            open = false
            minutes = 0
            seconds = 0
        }
    }
}

/// Drives cook-mode timer alerts: an in-app repeating chime while any timer is ringing
/// (AVAudioPlayer looping a system sound, configured to mix with the silent switch so
/// it's reliably audible across the kitchen), plus a one-shot local notification per
/// timer so the alarm still reaches the cook if they've left the app. The notification
/// is cancelled the moment its timer fires in-app (or is paused/dismissed) to avoid a
/// double alert.
@MainActor
final class TimerAlarm {
    private var player: AVAudioPlayer?
    private let center = UNUserNotificationCenter.current()

    /// Ask once for permission and pre-load the looping chime so `start()` is instant.
    func prepare() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
        // A short bundled system sound, looped. Falls back silently if unavailable —
        // the local notification still alerts.
        if let url = systemSoundURL() {
            player = try? AVAudioPlayer(contentsOf: url)
            player?.numberOfLoops = -1
            player?.prepareToPlay()
        }
    }

    /// Begin (or keep) the looping chime while a timer is ringing.
    func start() {
        guard let player else { return }
        if !player.isPlaying {
            try? AVAudioSession.sharedInstance().setActive(true)
            player.currentTime = 0
            player.play()
        }
    }

    /// Stop the chime once nothing is ringing.
    func stop() {
        player?.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    /// Schedule the out-of-app fallback alert at this timer's absolute fire instant.
    /// Re-adding with the same id replaces, so pause→resume / +1:00 stay idempotent.
    /// `name` names *which* timer fired (step + duration) so overlapping timers are
    /// distinguishable on the lock screen. The interruption level is `.timeSensitive`
    /// so it behaves like a kitchen alarm — breaking through Focus and the scheduled
    /// notification summary — without needing the Critical Alerts entitlement.
    func scheduleNotification(id: String, fireAt: Date, name: String) {
        let interval = fireAt.timeIntervalSinceNow
        guard interval > 0.5 else { return }
        let c = UNMutableNotificationContent()
        c.title = "Timer done"
        c.body = "\(name) — your cook timer is up."
        c.sound = .default
        c.interruptionLevel = .timeSensitive
        c.threadIdentifier = "waffled-cook-timers"
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
        center.add(UNNotificationRequest(identifier: id, content: c, trigger: trigger))
    }

    func cancelNotification(_ id: String) {
        center.removePendingNotificationRequests(withIdentifiers: [id])
        center.removeDeliveredNotifications(withIdentifiers: [id])
    }

    /// A short, looping-friendly system sound shipped with iOS.
    private func systemSoundURL() -> URL? {
        URL(fileURLWithPath: "/System/Library/Audio/UISounds/alarm.caf")
    }
}

import SwiftUI

/// Weekly Planning · step 9 "Kids". Ported from
/// `apps/web/src/kiosk/planning/steps/KidsStep.tsx`.
///
/// Every card is up at once on the iPad; the phone has no room, so a segmented row puts
/// one kid on screen at a time. Both answers come from things that already exist, and
/// "＋ Something else" sits LAST. Everything on screen is composed by the server except
/// the goal's number, which goes through `GoalDisplay` so a habit reads as this period's
/// count and not a lifetime total.
///
/// Once every card has both answers the step becomes the read-back frame; "Change
/// something" puts the picker back.
///
/// The answers are a REAL write, never `setDecisionData` — the crumb only reaches the
/// server when the step is ANSWERED.
struct KidsStepView: View {
    let props: PlanningStepProps

    @State private var model = PlanningKidsStepModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !model.loaded {
                WaffledLoading()
            } else if model.view == nil {
                WaffledEmptyState(
                    emoji: "🧒",
                    title: "Couldn’t read their week",
                    message: "Reload, or skip this step — skipping is a real answer.")
            } else if model.kids.isEmpty {
                WaffledEmptyState(
                    emoji: "🧒",
                    title: "No cards to read out",
                    message: "No one in this household is set up as a child yet. Add them in Settings → Family & People (member type “kid”) and this step will have something to ask. Skipping is a real answer in the meantime.")
            } else {
                Text(model.heading)
                    .font(WF.serif(20, .bold))
                    .foregroundStyle(WF.ink)

                if showsKidTabs { kidTabs }

                if let message = model.errorMessage {
                    DismissibleErrorBanner(message: message) { model.dismissError() }
                }

                cards
                extraControl
            }
        }
        // Keyed on session AND week: stepping to another week must not leave the previous
        // week's answers on screen.
        .task(id: "\(props.sessionId)|\(props.weekStart)") { await reload() }
        // Mirror the session's own answers onto the crumb after EVERY read and write, not
        // just after a tap: the shell resets the crumb on step change and REPLACES the
        // step's data when the affirmative is pressed. And never pass `model.crumb`
        // straight through — a nil after a failed fetch is the wipe, not "no news".
        .onChange(of: model.rev) {
            if let crumb = model.crumb { props.setDecisionData(crumb) }
        }
        // THIS STEP LENDS THE BANNER NOTHING: it creates nothing in any module. Withdrawn
        // explicitly, because the verb is the SHELL's state and would otherwise still be
        // the previous step's.
        .onAppear { props.lendVerb(nil) }
    }

    // MARK: - Which cards are on screen

    private var showsKidTabs: Bool {
        DeviceExperience.current == .planner && model.kids.count > 1
    }

    @ViewBuilder private var cards: some View {
        if showsKidTabs {
            if let card = model.activeCard { kidCard(card) }
        } else {
            VStack(spacing: 12) {
                ForEach(model.kids) { kidCard($0) }
            }
        }
    }

    private var kidTabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.kids) { k in
                    let on = k.personId == model.activeCard?.personId
                    Button { model.select(personId: k.personId) } label: {
                        HStack(spacing: 6) {
                            Avatar(colorHex: k.colorHex, emoji: k.avatarEmoji ?? "🙂", size: 22)
                            Text(k.name)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(on ? WF.ink : WF.ink2)
                            if k.settled {
                                Text("★").font(.system(size: 12, weight: .bold))
                                    .foregroundStyle(WF.gold)
                            }
                        }
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .wfChip(selected: on)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? [.isSelected] : [])
                }
            }
            .padding(.horizontal, 2).padding(.vertical, 2)
        }
    }

    // MARK: - One card

    private func kidCard(_ card: WaffledAPI.PlanningKidCard) -> some View {
        let frozen = model.isFrozen(shellBusy: props.busy)
        return WaffledCard(padding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                cardHeader(card)
                theirWeek(card)

                if model.isReadBack {
                    readBack(card)
                } else {
                    question(
                        card,
                        which: .focus,
                        label: "One thing to focus on",
                        frozen: frozen,
                        options: {
                            VStack(spacing: 8) {
                                ForEach(card.focusOptions, id: \.key) {
                                    focusOption($0, card: card, frozen: frozen)
                                }
                                focusHatch(card, frozen: frozen)
                            }
                        })

                    question(
                        card,
                        which: .forward,
                        label: "Something to look forward to",
                        frozen: frozen,
                        options: {
                            ChipFlow(spacing: 8, lineSpacing: 8) {
                                ForEach(card.forwardOptions, id: \.key) {
                                    forwardOption($0, card: card, frozen: frozen)
                                }
                                forwardHatch(card, frozen: frozen)
                            }
                        })
                }
            }
        }
    }

    private func cardHeader(_ card: WaffledAPI.PlanningKidCard) -> some View {
        HStack(spacing: 10) {
            Avatar(colorHex: card.colorHex, emoji: card.avatarEmoji ?? "🙂", size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.name).font(.system(size: 17, weight: .heavy)).foregroundStyle(WF.ink)
                if let age = card.age {
                    Text("age \(age)").font(.system(size: 12)).foregroundStyle(WF.ink3)
                }
            }
            Spacer(minLength: 6)
            // An economy that is off isn't drawn — NEVER a zero, which reads as "you've
            // earned nothing".
            if let stars = card.stars {
                WaffledStatusBadge(
                    text: "\(card.starsSymbol ?? "⭐") \(stars)", color: WF.gold, size: 13, weight: .heavy)
            }
        }
    }

    private func theirWeek(_ card: WaffledAPI.PlanningKidCard) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            SectionLabel(text: "Your week")
            if card.week.isEmpty && card.chores.isEmpty {
                Text("Nothing on it yet").font(.system(size: 13)).foregroundStyle(WF.ink3)
            } else {
                ChipFlow(spacing: 6, lineSpacing: 6) {
                    ForEach(card.week) { weekChip(when: $0.when, title: $0.title, late: false) }
                    ForEach(card.chores) { weekChip(when: $0.when, title: $0.title, late: $0.late) }
                }
            }
        }
    }

    private func weekChip(when: String, title: String, late: Bool) -> some View {
        HStack(spacing: 5) {
            Text(when)
                .font(.system(size: 11, weight: .heavy))
                .foregroundStyle(late ? WF.warn : WF.ink3)
            Text(title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(late ? WF.warnT : WF.panel)
        .clipShape(Capsule())
    }

    // MARK: - The two questions

    private func question<Options: View>(
        _ card: WaffledAPI.PlanningKidCard,
        which: PlanningKidsStepModel.Question,
        label: String,
        frozen: Bool,
        @ViewBuilder options: () -> Options
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: label)
            options()
            if model.isTyping(personId: card.personId, which: which) {
                PlanningKidTypeIn(
                    placeholder: which == .focus ? "In their own words" : "Something on their week",
                    accessibilityLabel: which == .focus
                        ? "Something else for \(card.name)"
                        : "Something else for \(card.name) to look forward to",
                    initial: model.typeInSeed(card, which),
                    disabled: frozen,
                    onCancel: { model.cancelTyping() },
                    onSave: { text in
                        if which == .focus {
                            answer(card.personId, focus: .text(text))
                        } else {
                            answer(card.personId, forward: .text(text))
                        }
                    },
                    onDraft: { text in
                        model.recordDraft(personId: card.personId, which: which, text: text)
                    })
                // A new box per person AND per question, so switching kid never inherits
                // the other's half-typed words.
                .id("\(card.personId):\(which.rawValue)")
            }
        }
    }

    private func focusOption(
        _ o: WaffledAPI.PlanningKidFocusOption,
        card: WaffledAPI.PlanningKidCard,
        frozen: Bool
    ) -> some View {
        let checked = PlanningKidsChoice.focusChosen(card, o)
        var progress: Double?
        var target: Double?
        if let g = o.goal {
            progress = GoalDisplay.progress(g)
            target = GoalDisplay.target(g)
        }

        return Button { answer(card.personId, focus: .key(o.key)) } label: {
            HStack(alignment: .top, spacing: 10) {
                Text(o.emoji).font(.system(size: 20)).frame(width: 26)
                VStack(alignment: .leading, spacing: 3) {
                    Text(o.label)
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = o.detail {
                        Text(detail).font(.system(size: 12)).foregroundStyle(WF.ink3)
                    }
                    if o.routed {
                        Text("sent here in step 1")
                            .font(.system(size: 10.5, weight: .heavy))
                            .foregroundStyle(WF.ai)
                    }
                }
                Spacer(minLength: 6)
                if let progress {
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(goalFmt(progress))
                            .font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.ink)
                        if let target {
                            Text("/ \(goalFmt(target))")
                                .font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                    }
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .planningOptionChrome(selected: checked)
        }
        .buttonStyle(.plain)
        .disabled(frozen)
        .opacity(frozen ? 0.6 : 1)
        .accessibilityAddTraits(checked ? [.isSelected] : [])
    }

    private func focusHatch(_ card: WaffledAPI.PlanningKidCard, frozen: Bool) -> some View {
        let chosen = PlanningKidsChoice.focusIsCustom(card)
        return Button { model.beginTyping(personId: card.personId, which: .focus) } label: {
            HStack(spacing: 10) {
                Text(chosen ? (card.focus?.emoji ?? "✨") : "＋")
                    .font(.system(size: 18)).frame(width: 26)
                Text(chosen ? (card.focus?.label ?? "") : "Something else")
                    .font(.system(size: 15, weight: chosen ? .semibold : .regular))
                    .foregroundStyle(chosen ? WF.ink : WF.ink3)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 6)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .planningOptionChrome(selected: chosen)
        }
        .buttonStyle(.plain)
        .disabled(frozen)
        .opacity(frozen ? 0.6 : 1)
        .accessibilityAddTraits(chosen ? [.isSelected] : [])
    }

    private func forwardOption(
        _ o: WaffledAPI.PlanningKidForwardOption,
        card: WaffledAPI.PlanningKidCard,
        frozen: Bool
    ) -> some View {
        let checked = PlanningKidsChoice.forwardChosen(card, o)
        return Button { answer(card.personId, forward: .key(o.key)) } label: {
            HStack(spacing: 5) {
                Text(o.emoji).font(.system(size: 14))
                Text("\(o.when) · \(o.label)")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(checked ? WF.ink : WF.ink2)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .wfChip(selected: checked)
        }
        .buttonStyle(.plain)
        .disabled(frozen)
        .opacity(frozen ? 0.6 : 1)
        .accessibilityAddTraits(checked ? [.isSelected] : [])
    }

    private func forwardHatch(_ card: WaffledAPI.PlanningKidCard, frozen: Bool) -> some View {
        let chosen = PlanningKidsChoice.forwardIsCustom(card)
        return Button { model.beginTyping(personId: card.personId, which: .forward) } label: {
            HStack(spacing: 5) {
                Text(chosen ? (card.forward?.emoji ?? "✨") : "＋").font(.system(size: 14))
                Text(chosen ? (card.forward?.label ?? "") : "Add something")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(chosen ? WF.ink : WF.ink3)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .wfChip(selected: chosen)
        }
        .buttonStyle(.plain)
        .disabled(frozen)
        .opacity(frozen ? 0.6 : 1)
        .accessibilityAddTraits(chosen ? [.isSelected] : [])
    }

    // MARK: - The read-back

    private func readBack(_ card: WaffledAPI.PlanningKidCard) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let focus = card.focus {
                said(emoji: focus.emoji, big: focus.label, caption: "this week’s one thing")
            }
            if let forward = card.forward {
                said(
                    emoji: forward.emoji,
                    big: forward.label,
                    caption: forward.when.isEmpty
                        ? "the bit to look forward to"
                        : "\(forward.when) — the bit to look forward to")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("What \(card.name) said")
    }

    private func said(emoji: String, big: String, caption: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(emoji).font(.system(size: 30))
            VStack(alignment: .leading, spacing: 2) {
                Text(big)
                    .font(WF.serif(20, .bold)).foregroundStyle(WF.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text(caption).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - The frame's own control
    //
    // The web puts this in the shell's FooterExtra; the iOS seam routes a footer extra for
    // `meals` only, so the control lives in the body instead.

    @ViewBuilder private var extraControl: some View {
        if model.isReadBack {
            ghostButton("Change something", disabled: false) { model.beginChanging() }
        } else if model.canRepeat {
            ghostButton("Same as last week", disabled: model.isFrozen(shellBusy: props.busy)) {
                Task {
                    await model.repeatLastWeek(
                        sessionId: props.sessionId, weekStart: props.weekStart)
                    props.refresh()
                }
            }
        }
    }

    private func ghostButton(
        _ label: String, disabled: Bool, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(WF.ink2)
                .padding(.horizontal, 16).padding(.vertical, 9)
                .background(WF.panel)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.6 : 1)
    }

    // MARK: - Writes

    /// Set here as well as on the `rev` change: a remount whose fetch fails must not leave
    /// the shell holding a crumb it will replace the step's data with.
    private func reload() async {
        await model.load(sessionId: props.sessionId, weekStart: props.weekStart)
        if let crumb = model.crumb { props.setDecisionData(crumb) }
    }

    private func answer(
        _ personId: String,
        focus: PlanningKidPick = .absent,
        forward: PlanningKidPick = .absent
    ) {
        guard !model.isFrozen(shellBusy: props.busy) else { return }
        Task {
            await model.answer(
                sessionId: props.sessionId, personId: personId, weekStart: props.weekStart,
                focus: focus, forward: forward)
            props.refresh()
        }
    }
}

/// The escape hatch's box. `initial` is their saved answer or the draft they never saved,
/// so reopening the box does not discard words somebody already dictated.
///
/// `onDraft` fires ONCE, as the box goes away — per keystroke would re-render every card
/// in the step just to move a cursor.
private struct PlanningKidTypeIn: View {
    let placeholder: String
    let accessibilityLabel: String
    let initial: String
    let disabled: Bool
    let onCancel: () -> Void
    let onSave: (String) -> Void
    let onDraft: (String) -> Void

    private static let maxLength = 120

    @State private var text: String
    @FocusState private var focused: Bool

    init(
        placeholder: String,
        accessibilityLabel: String,
        initial: String,
        disabled: Bool,
        onCancel: @escaping () -> Void,
        onSave: @escaping (String) -> Void,
        onDraft: @escaping (String) -> Void
    ) {
        self.placeholder = placeholder
        self.accessibilityLabel = accessibilityLabel
        self.initial = initial
        self.disabled = disabled
        self.onCancel = onCancel
        self.onSave = onSave
        self.onDraft = onDraft
        _text = State(initialValue: initial)
    }

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(placeholder, text: $text)
                .font(.system(size: 15))
                .focused($focused)
                .submitLabel(.done)
                .onSubmit(save)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .wfField()
                .accessibilityLabel(accessibilityLabel)
            HStack(spacing: 8) {
                Button(action: onCancel) {
                    Text("Cancel")
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(WF.panel)
                        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }
                .buttonStyle(.plain)
                WaffledPrimaryCTA(
                    label: "Save", isDisabled: disabled || trimmed.isEmpty, action: save)
            }
        }
        .onAppear { focused = true }
        .onChange(of: text) { _, latest in
            if latest.count > Self.maxLength { text = String(latest.prefix(Self.maxLength)) }
        }
        .onDisappear { onDraft(text) }
    }

    private func save() {
        let value = trimmed
        guard !disabled, !value.isEmpty else { return }
        onSave(value)
    }
}

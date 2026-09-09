import SwiftUI

// Weekly Planning · step 1 "Loose ends" — what is still open, and the notes somebody
// parked, each routed to the step that will handle it. State, copy and the choice table
// live in `LooseEndsModel.swift`; this file is the screen.
//
// STEP 1 ROUTES; IT DOES NOT REPAIR: every primary choice is a DESTINATION and writes
// nothing to any module. THE SWITCH BELONGS TO THE DECK, NOT TO SEE-ALL, which lists BOTH
// groups under their own headings. The body is content-sized because the SHELL owns the
// scroll view (no `ScrollView`, no `WF.tabBarClearance` here).

struct PlanningOwnerChip: View {
    let owner: WaffledAPI.LooseEndOwner

    var body: some View {
        HStack(spacing: 5) {
            Avatar(colorHex: owner.colorHex, emoji: owner.avatarEmoji ?? "🙂", size: 18)
            Text(owner.name)
                .font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(owner.name) has this")
    }
}

struct LooseEndsStepView: View {
    let props: PlanningStepProps

    @Environment(SyncManager.self) private var sync

    @State private var model = PlanningLooseEndsModel()
    @State private var group: LooseEndGroup = .notDone
    /// Verification only: `WAFFLED_LE_SEEALL` starts in see-all. See DemoHooks.
    @State private var seeAll = DemoHooks.looseEndsSeeAll
    @State private var chooser = false
    @State private var ruling: String?
    @State private var note = ""
    @FocusState private var noteFocused: Bool

    private var disabled: Bool { props.busy || model.working }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            bar

            if !seeAll {
                Text(group.note)
                    .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Under the note rather than in the bar: a third control on a phone-width row
            // is how this screen ended up taking half the screen.
            if showChooser { listsButton }

            if let message = model.errorMessage {
                DismissibleErrorBanner(message: message) { model.clearError() }
            }

            content

            trail

            if group == .parked && !seeAll { captureBar }
        }
        .sheet(isPresented: $chooser) { listsSheet }
        // Verification only: open the chooser without a tap. See DemoHooks.openLists.
        .task(id: model.listCandidates.count) {
            if DemoHooks.openLists && showChooser { chooser = true }
        }
        .task(id: "\(props.sessionId)|\(props.weekStart)") {
            model.resetForWeek()
            // Read BEFORE the fetch: `data.routes` is a READ dependency, not only somewhere
            // this step writes. The crumb replaces `data` when the step is answered, so a
            // second visit whose fetch failed must not overwrite what the first routed.
            model.seedRoutes(from: props.step.data["routes"])
            await model.load(weekStart: props.weekStart, sessionId: props.sessionId)
            // Headless keyboard verification (`DemoHooks.focusPark`): the footer is PINNED,
            // so the band above the keyboard is only measurable with the keyboard up.
            // Group B first (no deck, no field), and the sleep waits for layout.
            if DemoHooks.focusPark {
                group = .parked
                try? await Task.sleep(for: .seconds(1))
                noteFocused = true
            }
        }
        .onChange(of: model.revision) { _, _ in props.setDecisionData(model.decisionData) }
        // THIS STEP LENDS NOTHING: its own bar PARKS notes, so a verb that turned a parked
        // note into a parked note is circular.
        .onAppear { props.lendVerb(nil) }
    }

    // MARK: - The bar

    @ViewBuilder private var bar: some View {
        HStack(spacing: 10) {
            if seeAll {
                Text("Everything still open")
                    .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
            } else {
                // The switch carries the distinction AND both counts, so you know what is
                // left in the group you are not looking at.
                HStack(spacing: 8) {
                    ForEach(LooseEndGroup.allCases, id: \.rawValue) { g in
                        Button {
                            group = g
                            model.clearError()
                        } label: {
                            HStack(spacing: 6) {
                                Text(g.label).font(.system(size: 13, weight: .bold))
                                    .foregroundStyle(g == group ? WF.ink : WF.ink2)
                                Text(model.remaining(g) == 0 ? "✓" : "\(model.remaining(g))")
                                    .font(.system(size: 12, weight: .heavy))
                                    .foregroundStyle(g == group ? WF.primary : WF.ink3)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .wfChip(selected: g == group)
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(g == group ? .isSelected : [])
                    }
                }
            }
            Spacer(minLength: 6)
            Button(seeAll ? "One at a time" : "See all") { seeAll.toggle() }
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(WF.ai)
                .buttonStyle(.plain)
        }
    }

    // MARK: - Which lists this step asks about

    /// Absent entirely rather than disabled: a control that opens an empty sheet is worse
    /// than none. `planning.manage` is adult-by-default and NOT admin, so whoever runs the
    /// session can do this without admin-only Settings.
    private var showChooser: Bool {
        sync.can("planning.manage")
            && !model.listCandidates.isEmpty
            && (seeAll || group == .notDone)
    }

    private var listsButton: some View {
        Button {
            chooser = true
        } label: {
            HStack(spacing: 6) {
                Text("Which lists?").font(.system(size: 13, weight: .bold))
                Text(listsSummary).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
            }
            .foregroundStyle(WF.ai)
        }
        .buttonStyle(.plain)
    }

    private var listsSummary: String {
        let all = model.listCandidates
        let on = all.filter(\.relevant).count
        return on == all.count ? "asking about all \(all.count)" : "asking about \(on) of \(all.count)"
    }

    private var listsSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("This step asks about anything still unchecked from before this week. Turn off a list that’s meant to stay open — a someday list, a wishlist — and it stops coming up every session. Your grocery list is never asked about: it rebuilds itself from the meal plan.")
                        .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)

                    WaffledCard(padding: 4) {
                        VStack(spacing: 0) {
                            ForEach(Array(model.listCandidates.enumerated()), id: \.element.id) { i, list in
                                if i > 0 { Divider().background(WF.hair) }
                                HStack(spacing: 11) {
                                    Text([list.emoji, list.name].compactMap { $0 }.joined(separator: " "))
                                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                                    Spacer(minLength: 8)
                                    Toggle("", isOn: Binding(
                                        get: { list.relevant },
                                        set: { on in rule(list.id, on) }))
                                        .labelsHidden().tint(WF.primary)
                                        .disabled(disabled || ruling != nil)
                                        .accessibilityLabel("Ask about \(list.name) in the weekly planning session")
                                }
                                .padding(.horizontal, 11).padding(.vertical, 11)
                                .opacity(ruling == list.id ? 0.5 : 1)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle("Lists it asks about")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { chooser = false }.font(.system(size: 15, weight: .bold))
                }
            }
        }
    }

    /// A list ruled out takes its cards out of the deck, and which cards is the server's.
    private func rule(_ id: String, _ on: Bool) {
        guard ruling == nil else { return }
        ruling = id
        Task {
            _ = await model.ruleList(
                id, relevant: on, weekStart: props.weekStart, sessionId: props.sessionId)
            ruling = nil
        }
    }

    // MARK: - Content

    @ViewBuilder private var content: some View {
        if !model.loaded {
            WaffledLoading(top: 24)
        } else if model.view == nil {
            WaffledEmptyState(
                emoji: "🌐",
                title: "Couldn’t read your loose ends",
                message: "Check your connection and try again.",
                top: 24)
        } else if seeAll {
            seeAllList
        } else if let card = model.open(group).first {
            deck(card)
        } else {
            cleared
        }
    }

    // MARK: one at a time

    @ViewBuilder private func deck(_ item: WaffledAPI.LooseEnd) -> some View {
        let total = model.total(group)
        let position = total - model.remaining(group) + 1
        let built = LooseEndChoice.build(item: item, group: group, destinations: model.destinations(group))

        VStack(alignment: .leading, spacing: 10) {
            Text("\(position) of \(total)")
                .font(.system(size: 12, weight: .heavy)).foregroundStyle(WF.ink3)

            ZStack(alignment: .top) {
                RoundedRectangle(cornerRadius: WF.rLG, style: .continuous)
                    .fill(WF.card).opacity(0.5)
                    .frame(height: 40)
                    .padding(.horizontal, 18).offset(y: 12)
                RoundedRectangle(cornerRadius: WF.rLG, style: .continuous)
                    .fill(WF.card).opacity(0.75)
                    .frame(height: 40)
                    .padding(.horizontal, 9).offset(y: 6)

                WaffledCard(padding: 16) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            SectionLabel(text: LooseEndCopy.kindLabel(item.kind))
                            if let owner = item.owner { PlanningOwnerChip(owner: owner) }
                            Spacer(minLength: 0)
                        }
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            if let emoji = item.emoji, !emoji.isEmpty {
                                Text(emoji).font(.system(size: 20))
                            }
                            Text(item.title)
                                .font(WF.serif(20)).foregroundStyle(WF.ink)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let detail = item.detail, !detail.isEmpty {
                            Text(detail).font(.system(size: 13)).foregroundStyle(WF.ink3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        VStack(spacing: 8) {
                            ForEach(built.choices) { choice in
                                choiceButton(choice, item: item)
                            }
                        }
                        .padding(.top, 2)
                        if !built.quiet.isEmpty {
                            HStack(spacing: 14) {
                                ForEach(built.quiet) { choice in
                                    Button(choice.label) { perform(choice, on: item) }
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(WF.ink2)
                                        .buttonStyle(.plain)
                                        .disabled(disabled)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// Full width, not the web's two-column grid: at phone width four destinations would each
    /// be a truncated two-word column, and the hint is half of the choice.
    private func choiceButton(_ choice: LooseEndChoice, item: WaffledAPI.LooseEnd) -> some View {
        Button {
            perform(choice, on: item)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(choice.label)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(choice.isPrimary ? WF.onInk : WF.ink)
                    Text(choice.hint)
                        .font(.system(size: 12))
                        .foregroundStyle(choice.isPrimary ? WF.onInk.opacity(0.75) : WF.ink3)
                }
                Spacer(minLength: 6)
                Image(systemName: "arrow.right")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(choice.isPrimary ? WF.onInk.opacity(0.8) : WF.ink3)
                    .opacity(isRoute(choice) ? 1 : 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14).padding(.vertical, 11)
            // A primary destination fills with ink, so its label takes `WF.onInk` — never
            // `.white`, which would go white-on-white once ink flips in dark mode.
            .background(choice.isPrimary ? WF.ink : WF.panel)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.6 : 1)
    }

    private func isRoute(_ choice: LooseEndChoice) -> Bool {
        if case .route = choice.act { return true }
        return false
    }

    // MARK: see all

    @ViewBuilder private var seeAllList: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(LooseEndCopy.disclaimer)
                .font(.system(size: 12.5)).foregroundStyle(WF.ink2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .wfField(fill: WF.panel)

            ForEach(LooseEndGroup.allCases, id: \.rawValue) { g in
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 6) {
                        Text(g.label).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                        Text(model.remaining(g) == 0 ? "✓" : "\(model.remaining(g))")
                            .font(.system(size: 12, weight: .heavy)).foregroundStyle(WF.primary)
                        Text("· \(g.caption)").font(.system(size: 12)).foregroundStyle(WF.ink3)
                    }
                    if model.open(g).isEmpty {
                        Text(g == .parked ? "Nothing parked is waiting." : "Nothing left open.")
                            .font(.system(size: 13)).foregroundStyle(WF.ink3)
                    } else {
                        VStack(spacing: 8) {
                            ForEach(model.open(g), id: \.key) { item in row(item, group: g) }
                        }
                    }
                    // Reachable in BOTH modes: "See all" must not be the one place you
                    // cannot write something down.
                    if g == .parked { captureBar }
                }
            }
        }
    }

    private func row(_ item: WaffledAPI.LooseEnd, group g: LooseEndGroup) -> some View {
        WaffledCard(padding: 12) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 8) {
                    Text(item.emoji.flatMap { $0.isEmpty ? nil : $0 } ?? "•")
                        .font(.system(size: 15))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        // WHERE IT CAME FROM, and who has it: without the kind, a chore
                        // called "Groceries" is indistinguishable from a list item.
                        // `ChipFlow`, not an HStack, because both names have to wrap.
                        ChipFlow(spacing: 6, lineSpacing: 3) {
                            Text(LooseEndCopy.kindLabel(item.kind).uppercased())
                                .font(.system(size: 10.5, weight: .heavy)).tracking(0.5)
                                .foregroundStyle(WF.ink3)
                            if let detail = item.detail, !detail.isEmpty {
                                Text(detail).font(.system(size: 12)).foregroundStyle(WF.ink3)
                            }
                            if let owner = item.owner { PlanningOwnerChip(owner: owner) }
                        }
                    }
                    Spacer(minLength: 0)
                }
                ChipFlow(spacing: 6, lineSpacing: 6) {
                    ForEach(model.destinations(g), id: \.to) { d in
                        pill(d.label, primary: d.primary == true) { sendOn(item, from: g, to: d.to) }
                    }
                    ForEach(item.actions, id: \.self) { a in
                        pill(LooseEndCopy.actionLabel(a, kind: item.kind), primary: false) {
                            settle(item, action: a)
                        }
                    }
                }
            }
        }
    }

    private func pill(_ label: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12.5, weight: .bold))
                .foregroundStyle(primary ? WF.onInk : WF.ink2)
                .padding(.horizontal, 11).padding(.vertical, 6)
                .background(primary ? WF.ink : WF.panel)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.6 : 1)
    }

    // MARK: cleared

    @ViewBuilder private var cleared: some View {
        let other = group.other
        VStack(spacing: 10) {
            Text("✓").font(.system(size: 34, weight: .heavy)).foregroundStyle(WF.success)
            Text(LooseEndCopy.clearedTitle(group)).font(WF.serif(20)).foregroundStyle(WF.ink)
            Text(LooseEndCopy.clearedSubtitle(
                group, sources: model.view?.sources ?? [], remainingOther: model.remaining(other)))
                .font(.system(size: 13)).foregroundStyle(WF.ink3)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if model.remaining(other) > 0 {
                WaffledPrimaryCTA(label: "Go to \(other.label)") { group = other }
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
    }

    // MARK: trail

    @ViewBuilder private var trail: some View {
        let items = model.trail
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(LooseEndCopy.trailCaption)
                    .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(Array(items.enumerated()), id: \.offset) { index, route in
                    HStack(spacing: 6) {
                        Text(route.title)
                            .font(.system(size: 13, weight: index == 0 ? .bold : .semibold))
                            .foregroundStyle(index == 0 ? WF.ink : WF.ink2)
                            .lineLimit(1)
                        Text("→").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                        Text(model.stepName(route.to))
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
                        Spacer(minLength: 6)
                        if index == 0 {
                            Button("Undo") { undo(route) }
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(WF.ai)
                            .buttonStyle(.plain)
                            .disabled(disabled)
                        }
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .wfField(fill: WF.panel)
        }
    }

    // MARK: capture

    private var captureBar: some View {
        HStack(spacing: 8) {
            Text("＋").font(.system(size: 15, weight: .heavy)).foregroundStyle(WF.ink3)
            // NOT disabled while the write is in flight: focus on a disabled field is a
            // silent no-op, and this bar puts the cursor back after every note.
            TextField(LooseEndCopy.capturePlaceholder, text: $note)
                .font(.system(size: 15))
                .focused($noteFocused)
                .submitLabel(.done)
                .onSubmit { park() }
            Button("Park it") { park() }
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(canPark ? WF.primary : WF.ink3)
                .buttonStyle(.plain)
                .disabled(!canPark)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .wfField()
        // NO `.wfKeyboardDoneToolbar` HERE, deliberately — see the note in
        // PlanningShellView.sessionScreen. That accessory bar measured ~79pt for one button
        // stacked on the session's fixed footer, and this field's keyboard has a return key.
    }

    private var canPark: Bool {
        !disabled && !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: actions

    private func perform(_ choice: LooseEndChoice, on item: WaffledAPI.LooseEnd) {
        switch choice.act {
        case let .route(to):
            sendOn(item, from: group, to: to)
        case let .settle(action):
            settle(item, action: action)
        case .leave:
            model.leave(item)
        }
    }

    /// Routing a PARKED note sets its `step_key`, which the later steps' hand-off banners
    /// read — so the session view is genuinely stale until the shell re-reads.
    private func sendOn(_ item: WaffledAPI.LooseEnd, from g: LooseEndGroup, to: String) {
        Task {
            if await model.send(item, from: g, to: to, sessionId: props.sessionId) {
                props.refresh()
            }
        }
    }

    private func undo(_ r: WaffledAPI.LooseEndRoute) {
        Task {
            if await model.undo(r, sessionId: props.sessionId) { props.refresh() }
        }
    }

    private func settle(_ item: WaffledAPI.LooseEnd, action: String) {
        Task {
            let ok = await model.settle(
                item, action: action, weekStart: props.weekStart, sessionId: props.sessionId)
            if ok { props.refresh() }
        }
    }

    private func park() {
        let text = note
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        Task {
            if await model.park(text, weekStart: props.weekStart, sessionId: props.sessionId) {
                note = ""
                // Parking is a burst, so the cursor goes back rather than making you re-aim.
                noteFocused = true
                props.refresh()
            }
        }
    }
}

import SwiftUI

/// Weekly Planning · step 6 "Goals" — "What's each group's focus this week?" Web parity with
/// `planning/steps/GoalsStep.tsx`.
///
/// THE TABS ARE THE `goal_lists` THAT ALREADY EXIST. Picking a goal sets the goals module's own
/// `is_featured`; there is no second "focus" concept, a hand-made pin is never cleared, and
/// picking NOTHING settles the group just the same.
///
/// ANSWERING THE STEP IS SEPARATE FROM SETTING FOCUS: `/goals/focus` merges onto the step row
/// and leaves `status` alone. So this body must mirror the server's focus map back through
/// `setDecisionData` after every read and write, because the affirmative REPLACES the step's
/// data with whatever the crumb holds.
struct GoalsStepView: View {
    let props: PlanningStepProps

    @Environment(SyncManager.self) private var sync
    @State private var model = PlanningGoalsStepModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !model.loaded {
                WaffledLoading()
            } else if model.view == nil {
                WaffledEmptyState(
                    emoji: "🎯",
                    title: "Couldn’t read your goals",
                    message: "Reload, or skip this step — skipping is a real answer.")
            } else if model.groups.isEmpty {
                WaffledEmptyState(
                    emoji: "🎯",
                    title: "No goal groups yet",
                    message: "Make one on the Goals screen and this step will have something to ask about. Skipping is a real answer in the meantime.")
            } else {
                tabs
                if let message = model.errorMessage {
                    DismissibleErrorBanner(message: message) { model.dismissError() }
                }
                if let active = model.active { groupCard(active) }
            }
        }
        .task(id: props.sessionId) { await reload() }
        // Mirror what the session knows onto the crumb after EVERY fresh read AND every write,
        // not only after a tap: the shell resets the crumb on step change and REPLACES the
        // step's stored data when the affirmative is pressed.
        //
        // NEVER `setDecisionData(model.crumb)` STRAIGHT THROUGH. This crumb is a MIRROR of
        // server state, so handing the shell a nil (a failed fetch, or a 403 because goals was
        // toggled off mid-session) is not "no news", it is the wipe: `decideStep` writes
        // `data = excluded.data` with `input.data ?? {}`.
        .onChange(of: model.rev) {
            if let crumb = model.crumb { props.setDecisionData(crumb) }
        }
        .onAppear { props.lendVerb(nil) }
        .goalEditor(isPresented: newGoalSheet) {
            if let g = model.newGoalGroup {
                GoalCreateSheet(
                    lists: [g.asGoalList],
                    defaultListId: g.listId,
                    // DELIBERATELY EMPTY. `members` only feeds the editor's "New group" sheet,
                    // which `lockedListId` removes — and handing it `sync.members` would make
                    // this presentation observe SyncManager and re-lay-out the whole editor on
                    // every unrelated sync mutation (see `TasksStep.editor`).
                    members: [],
                    lockedListId: g.listId,
                    startFeatured: true
                ) { goalBody, _ in
                    // The GROUP IS CAPTURED HERE, synchronously: the editor dismisses itself
                    // on submit, which clears the sheet flag before the task runs.
                    let target = g.listId
                    Task {
                        let made = await model.submitNewGoal(
                            sessionId: props.sessionId, listId: target, body: goalBody)
                        // ONLY ON A REAL SAVE: a refresh flips the shell busy and greys the
                        // whole step out, which over a goal that never saved is a second,
                        // false failure on top of the banner.
                        if made { props.refresh() }
                    }
                }
            }
        }
    }

    private var newGoalSheet: Binding<Bool> {
        Binding(
            get: { model.newForListId != nil },
            set: { if !$0 { model.closeNewGoal() } })
    }

    // MARK: - Tabs

    private var tabs: some View {
        VStack(alignment: .leading, spacing: 7) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(model.groups) { tab($0) }
                }
                // Room for the selected chip's 1.5pt border, which a clipped scroll view would
                // otherwise shave off the first and last tab.
                .padding(.horizontal, 2).padding(.vertical, 2)
            }
            Text("\(model.settledCount) of \(model.groups.count) settled")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(WF.ink3)
        }
    }

    private func tab(_ g: WaffledAPI.PlanningGoalGroup) -> some View {
        let on = g.listId == model.active?.listId
        return Button { model.selectTab(g.listId) } label: {
            HStack(spacing: 5) {
                Text(g.emoji ?? "🎯").font(.system(size: 14))
                Text(g.name)
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(on ? WF.ink : WF.ink2)
                    .lineLimit(1)
                if g.isPrivate { Text("🔒").font(.system(size: 10)) }
                if g.settled {
                    Text("★").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.gold)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .wfChip(selected: on)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(g.settled ? "\(g.name), settled" : g.name)
        .accessibilityAddTraits(on ? [.isSelected] : [])
    }

    // MARK: - The group on screen

    private func groupCard(_ g: WaffledAPI.PlanningGoalGroup) -> some View {
        let frozen = model.isFrozen(shellBusy: props.busy)
        return WaffledCard(padding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                header(g)

                VStack(spacing: 8) {
                    ForEach(g.goals) { goalOption($0, group: g, frozen: frozen) }
                    nothingOption(g, frozen: frozen)
                }

                Text(PlanningGoalsText.verdict(g))
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(g.settled && g.focusGoalId != nil ? WF.ink : WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)

                newGoalButton(g, frozen: frozen)
            }
        }
    }

    private func newGoalButton(
        _ g: WaffledAPI.PlanningGoalGroup, frozen: Bool
    ) -> some View {
        let allowed = PlanningGoalsStepModel.canTarget(
            g, canManageGoals: sync.can("goal.manage"), personId: sync.currentPersonId)
        let off = frozen || !allowed

        return VStack(alignment: .leading, spacing: 4) {
            Button { model.openNewGoal() } label: {
                HStack(spacing: 5) {
                    Image(systemName: "plus").font(.system(size: 11, weight: .heavy))
                    Text("New goal for this week").font(.system(size: 13, weight: .bold))
                }
                .foregroundStyle(off ? WF.ink3 : WF.primary)
            }
            .buttonStyle(.plain)
            .disabled(off)

            if !allowed {
                Text("Adding a goal to \(g.name) needs permission to manage goals")
                    .font(.system(size: 11.5)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func header(_ g: WaffledAPI.PlanningGoalGroup) -> some View {
        HStack(spacing: 10) {
            WaffledEmojiTile(emoji: g.emoji ?? "🎯")
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(g.name).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    if g.isPrivate { Text("🔒").font(.system(size: 11)) }
                }
                Text(PlanningGoalsText.groupSubtitle(g))
                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
            }
            Spacer(minLength: 6)
            avatarStack(g.members)
        }
    }

    private func avatarStack(_ members: [WaffledAPI.PlanningGoalMember]) -> some View {
        HStack(spacing: -8) {
            ForEach(members.prefix(4)) { m in
                Avatar(colorHex: m.colorHex, emoji: m.avatarEmoji ?? "🙂", size: 26)
                    .overlay(Circle().strokeBorder(WF.card, lineWidth: 1.5))
                    .accessibilityLabel(m.name)
            }
        }
    }

    // MARK: - One choosable goal

    private func goalOption(
        _ item: WaffledAPI.PlanningGoalGoal,
        group: WaffledAPI.PlanningGoalGroup,
        frozen: Bool
    ) -> some View {
        let g = item.goal
        let checked = group.focusGoalId == g.id
        // ALWAYS through the shared helper. An inline `totalProgress` here is the bug the
        // helper exists to prevent.
        let progress = GoalDisplay.progress(g)
        let target = GoalDisplay.target(g)

        return Button { pick(listId: group.listId, goalId: g.id) } label: {
            HStack(alignment: .top, spacing: 10) {
                Text(g.emoji ?? GoalStyle.emoji(g.category))
                    .font(.system(size: 19))
                    .frame(width: 26)

                VStack(alignment: .leading, spacing: 5) {
                    Text(g.title)
                        .font(.system(size: 14.5, weight: .semibold))
                        .foregroundStyle(WF.ink)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 4) {
                        Text(PlanningGoalsText.kindLabel(g))
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(WF.ink3)
                        if let pace = item.pace {
                            Text("·").font(.system(size: 11.5)).foregroundStyle(WF.ink3)
                            Text(pace.text)
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundStyle(PlanningPaceTone.color(pace.tone))
                                .lineLimit(1)
                        }
                    }

                    ProgressBar(
                        value: GoalDisplay.fraction(g),
                        tint: GoalStyle.color(g.category),
                        track: WF.panel,
                        height: 6)
                }

                VStack(alignment: .trailing, spacing: 0) {
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(goalFmt(progress))
                            .font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.ink)
                        if let target {
                            Text("/ \(goalFmt(target))")
                                .font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                    }
                    Text(PlanningGoalsText.axisLabel(g))
                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(WF.ink3)
                        .lineLimit(1)
                }
                .frame(minWidth: 54, alignment: .trailing)

                Text(checked ? "★" : "")
                    .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.gold)
                    .frame(width: 14)
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

    private func nothingOption(_ g: WaffledAPI.PlanningGoalGroup, frozen: Bool) -> some View {
        let checked = g.settled && g.focusGoalId == nil
        return Button { pick(listId: g.listId, goalId: nil) } label: {
            HStack(spacing: 10) {
                Text("🤍").font(.system(size: 19)).frame(width: 26)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Nothing this week")
                        .font(.system(size: 14.5, weight: .semibold)).foregroundStyle(WF.ink)
                    Text(g.goals.isEmpty
                         ? "This group has no goals yet."
                         : "No goal needs the spotlight — leave the week clear.")
                        .font(.system(size: 11.5)).foregroundStyle(WF.ink3)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 6)
                Text(checked ? "★" : "")
                    .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.gold)
                    .frame(width: 14)
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

    // MARK: - Writes

    private func reload() async {
        await model.load(sessionId: props.sessionId)
        if let crumb = model.crumb { props.setDecisionData(crumb) }
    }

    private func pick(listId: String, goalId: String?) {
        guard !model.isFrozen(shellBusy: props.busy) else { return }
        Task {
            await model.pick(sessionId: props.sessionId, listId: listId, goalId: goalId)
            props.refresh()
        }
    }
}

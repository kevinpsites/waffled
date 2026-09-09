import SwiftUI

/// Weekly Planning · step 4 "Family night" — "Accept the rotation, or change it?"
///
/// Web parity with `planning/steps/FamilyNightStep.tsx`. The fast path is reading the rows and
/// moving on, so the affirmative writes nothing.
///
/// Everything that IS a decision goes through the familyNight module's own OCCURRENCE endpoint:
///   · tap a face → an assignment pinned for THIS WEEK only. It materializes the occurrence, and
///     occurrence counts are what the rotation counts, so a pin shifts next week's turn.
///   · the theme → free text on the same occurrence ('' clears it).
///   · Skip this week → status 'skipped', which calls off the GATHERING, never the recurring event.
///
/// "Skip this week" lives in the BODY, not the shell's footer, so the action and its Undo sit
/// together. No `ScrollView`, no `WF.tabBarClearance`, no padding: the shell owns all three.
struct FamilyNightStepView: View {
    let props: PlanningStepProps

    @State private var model = PlanningFamilyNightModel()
    /// Closed again after a pick, so a second tap on a stale list can't relink.
    @State private var picking = false
    /// ONE focus token for the whole step, so one keyboard "Done" dismisses whichever line is live.
    @FocusState private var focusedField: String?

    /// Nothing may be touched while a write is in flight; a called-off week freezes all but Undo.
    private var disabled: Bool { props.busy || model.busy }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let message = model.errorMessage {
                DismissibleErrorBanner(message: message) { model.errorMessage = nil }
            }

            if let board = model.board {
                gathering(board)
                if board.isSkipped { skipBar(board) } else { rotationNote; skipThisWeek }
            } else if model.loaded {
                WaffledEmptyState(
                    emoji: "🏡",
                    title: "Couldn't read this week's family night",
                    message: "Reload and try again — nothing has been changed.")
            } else {
                WaffledLoading()
            }
        }
        .task(id: props.weekStart) {
            // Drop focus first: the rows keep their identity across a week change, so a draft held
            // mid-sentence would be written to the NEW week's date.
            focusedField = nil
            picking = false
            await model.load(weekStart: props.weekStart)
        }
        // The crumb, kept in step with every read and write, so the affirmative writes back what
        // is already true instead of erasing it.
        .onChange(of: model.rev) { props.setDecisionData(model.crumb) }
        // NO `.wfKeyboardDoneToolbar` HERE, deliberately — see PlanningShellView.sessionScreen.
        // That accessory bar stacks ~79pt on top of the session's fixed footer.
    }

    // MARK: - The gathering

    @ViewBuilder
    private func gathering(_ board: WaffledAPI.PlanningFamilyNightBoard) -> some View {
        WaffledCard(padding: 16) {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text("🏡 Family Night")
                            .font(.system(size: 15, weight: .heavy)).foregroundStyle(WF.ink)
                        Spacer(minLength: 6)
                        Text(model.recurrence)
                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                    Text(model.when)
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
                }

                PlanningCommitLine(
                    label: "Theme",
                    field: "theme",
                    focus: $focusedField,
                    value: board.theme ?? "",
                    placeholder: #"optional — "pizza and the new Lego set""#,
                    limit: 120,
                    disabled: disabled || board.isSkipped,
                    // '' clears; leaving the key out would mean "keep whatever is there".
                    onCommit: { text in save(PlanningFamilyNightBody.setTheme(date: board.date, theme: text)) })

                ForEach(model.rows) { row in
                    partRow(row, board: board)
                }

                if board.members.isEmpty {
                    Text("Add family members and the rotation has somebody to offer.")
                        .font(.system(size: 13)).foregroundStyle(WF.ink3)
                }

                calendarLine(board)
            }
        }
        // Called off, not deleted: the week stays legible so Undo has something to undo.
        .opacity(board.isSkipped ? 0.5 : 1)
    }

    @ViewBuilder
    private func partRow(_ row: PlanningFamilyNightModel.PartRow, board: WaffledAPI.PlanningFamilyNightBoard) -> some View {
        let part = row.part
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 10) {
                WaffledEmojiTile(emoji: part.emoji, size: 19, frame: 36, cornerRadius: 11)
                VStack(alignment: .leading, spacing: 2) {
                    Text(part.label)
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    Text(row.suggestion)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(part.pinned ? WF.ink2 : WF.ink3)
                }
                Spacer(minLength: 0)
            }

            if !board.members.isEmpty {
                ChipFlow(spacing: 8, lineSpacing: 8) {
                    ForEach(board.members) { member in
                        face(member, part: part, board: board)
                    }
                }
            }

            // WHAT the part is, not whose turn it is. Sent WITHOUT a `personId` key, so naming
            // the treat leaves whoever has it alone.
            PlanningCommitLine(
                label: "What",
                field: part.partId,
                focus: $focusedField,
                value: part.detail ?? "",
                placeholder: row.detailHint,
                limit: 200,
                disabled: disabled || board.isSkipped,
                accessibilityLabel: row.detailAccessibilityLabel,
                onCommit: { text in
                    save(PlanningFamilyNightBody.setDetail(date: board.date, partId: part.partId, detail: text))
                })
        }
        .padding(.vertical, 4)
    }

    /// Tapping the suggested person is a REAL action, so the accessible name is the action.
    private func face(_ member: WaffledAPI.PlanningFamilyNightMember,
                      part: WaffledAPI.PlanningFamilyNightPart,
                      board: WaffledAPI.PlanningFamilyNightBoard) -> some View {
        let isCurrent = member.id == part.personId
        return Button {
            save(PlanningFamilyNightBody.pin(date: board.date, partId: part.partId, personId: member.id))
        } label: {
            Avatar(colorHex: member.colorHex, emoji: member.avatarEmoji ?? "🙂", size: 38)
                .overlay(Circle().strokeBorder(isCurrent ? WF.primary : Color.clear, lineWidth: 2))
                .opacity(isCurrent ? 1 : 0.55)
        }
        .buttonStyle(.plain)
        .disabled(disabled || board.isSkipped)
        .accessibilityLabel("Pin \(part.label) to \(member.name)")
        // Only a PIN is a selected state; the rotation's suggestion is drawn as current.
        .accessibilityAddTraits(part.pinned && isCurrent ? [.isSelected] : [])
    }

    // MARK: - This week on the calendar

    /// TWO different things live here: `onCalendar` is the STANDING recurring series set once in
    /// Settings; `eventId` is the event THIS gathering points at, which a session can decide.
    ///
    /// Neither button opens an event form. "Add to calendar" is ONE server call that creates and
    /// links atomically — a create-then-adopt round trip could not be made safe, because the app
    /// writes events LOCALLY first and the id would not exist server-side yet.
    @ViewBuilder
    private func calendarLine(_ board: WaffledAPI.PlanningFamilyNightBoard) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if board.eventId != nil {
                HStack(alignment: .top, spacing: 10) {
                    Text("📅").font(.system(size: 17))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(board.eventTitle ?? "On the calendar")
                            .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                        Text("\(board.eventWhen ?? "") · on the calendar for this week")
                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                    Spacer(minLength: 6)
                    // Unlinks ONLY: "this isn't family night after all" must never delete Friday.
                    ghostButton("Unlink", disabled: disabled || board.isSkipped) {
                        save(PlanningFamilyNightBody.linkEvent(date: board.date, eventId: nil))
                    }
                }
            } else {
                HStack(alignment: .top, spacing: 10) {
                    Text("📅").font(.system(size: 17))
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Not on the calendar this week")
                            .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                        Text(board.onCalendar
                             ? "The standing weekly event still stands — this is for a one-off, or to point at something already on the week."
                             : "Add it as an event, or point at something already on the week.")
                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 8) {
                            ghostButton("Add to calendar", disabled: disabled || board.isSkipped) {
                                picking = false
                                save(PlanningFamilyNightBody.addEvent(date: board.date))
                            }
                            ghostButton(picking ? "Never mind" : "Link an event",
                                        disabled: disabled || board.isSkipped) {
                                picking.toggle()
                                if picking {
                                    Task { await model.loadWeekEvents(weekStart: props.weekStart) }
                                }
                            }
                        }
                        if picking { eventPicker(board) }
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(.top, 2)
    }

    @ViewBuilder
    private func eventPicker(_ board: WaffledAPI.PlanningFamilyNightBoard) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !model.weekEventsLoaded {
                Text("Reading this week's calendar…")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
            } else if model.weekEvents.isEmpty {
                Text("Nothing on the week to point at yet.")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
            } else {
                ForEach(model.weekEvents) { event in
                    Button {
                        picking = false
                        save(PlanningFamilyNightBody.linkEvent(date: board.date, eventId: event.id))
                    } label: {
                        Text(event.title)
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 11).padding(.vertical, 9)
                            .wfField(radius: WF.rSM, fill: WF.panel)
                    }
                    .buttonStyle(.plain)
                    .disabled(disabled)
                }
            }
        }
        .accessibilityLabel("Events on this week")
    }

    // MARK: - Skipped, and the way back

    @ViewBuilder
    private func skipBar(_ board: WaffledAPI.PlanningFamilyNightBoard) -> some View {
        WaffledCard(padding: 14) {
            HStack(alignment: .top, spacing: 10) {
                Text("⏭").font(.system(size: 17))
                VStack(alignment: .leading, spacing: 3) {
                    Text("Skipped this week")
                        .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                    // The rotation advancing on a skipped week is INTENDED, so the copy says so.
                    Text("The gathering is marked skipped\(board.onCalendar ? ", and the recurring calendar event is left alone" : ""). Everyone's turn still moves on, so next week is the next person up.")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 6)
                ghostButton("Undo", disabled: disabled) {
                    save(PlanningFamilyNightBody.setStatus(date: board.date, status: "planned"))
                }
            }
        }
    }

    /// The module's rotation is a COUNT of gatherings against the family's order — deliberately
    /// NOT "who did what last time", which it never reads.
    private var rotationNote: some View {
        Text("These are rotation suggestions — each part taken in turn, in your family's order. Leave them and they stand; tap a face and it's pinned for this week only, which is what shifts next week's turn.")
            .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Skipping the STEP decides nothing; skipping the WEEK calls the gathering off. Once it is
    /// off, the way back is Undo on the skip bar, so this control disappears.
    @ViewBuilder
    private var skipThisWeek: some View {
        if let board = model.board {
            ghostButton("Skip this week", disabled: disabled) {
                save(PlanningFamilyNightBody.setStatus(date: board.date, status: "skipped"))
            }
        }
    }

    // MARK: - Plumbing

    private func ghostButton(_ label: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(disabled ? WF.ink3 : WF.ink2)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(WF.panel)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private func save(_ body: [String: JSONValue]) {
        Task {
            if await model.write(body, weekStart: props.weekStart) { props.refresh() }
        }
    }
}

/// A free-text line saved on FOCUS LOSS (and on Return) rather than per keystroke. Shared by the
/// theme and every part's detail: same clearing rule ('' clears, an absent key means "leave it").
/// Focus loss is load-bearing — `.onSubmit` alone covers only Return, so typing a theme and then
/// tapping a face would silently throw it away.
private struct PlanningCommitLine: View {
    let label: String
    /// Optional purely so it is the SAME type as the focus binding's value.
    let field: String?
    let focus: FocusState<String?>.Binding
    let value: String
    let placeholder: String
    let limit: Int
    let disabled: Bool
    /// The accessible name, when the visible label is too terse: three rows each show "What".
    var accessibilityLabel: String?
    let onCommit: (String) -> Void

    @State private var draft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            SectionLabel(text: label)
            TextField(placeholder, text: $draft)
                .font(.system(size: 14))
                .foregroundStyle(WF.ink)
                .textInputAutocapitalization(.sentences)
                .focused(focus, equals: field)
                .disabled(disabled)
                .padding(.horizontal, 11).padding(.vertical, 10)
                .wfField()
                .accessibilityLabel(accessibilityLabel ?? label)
                .onSubmit { focus.wrappedValue = nil }
        }
        .onAppear { draft = value }
        // Guarded on focus so a draft in progress is never clobbered by a read landing mid-sentence.
        .onChange(of: value) { _, fresh in
            if focus.wrappedValue != field { draft = fresh }
        }
        .onChange(of: draft) { _, typed in
            if typed.count > limit { draft = String(typed.prefix(limit)) }
        }
        .onChange(of: focus.wrappedValue) { was, now in
            if was == field, now != field { commit() }
        }
    }

    private func commit() {
        let trimmed = draft.trimmingCharacters(in: .whitespaces)
        guard !disabled, trimmed != value else { return }
        onCommit(trimmed)
    }
}

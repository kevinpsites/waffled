import SwiftUI

/// Weekly Planning · step 5 "Connection" — "Who gets time with whom?" Web parity with
/// `planning/steps/ConnectionStep.tsx`.
///
/// NOTHING NEW IS STORED FOR THIS STEP. A pairing is a query over event participants and claiming a
/// slot writes an ORDINARY CALENDAR EVENT. This file must never grow a pairing record: a row's
/// state is whatever the calendar says next time you look, so every action RE-READS. The one thing
/// remembered is a POINTER — which event answers which pairing.
///
/// Four rules this file must not break:
///  1. THE ROWS ARE A PROMPT, NOT THE LIST, with "Make a pairing" first-class beneath them.
///  2. TIME THAT ALREADY EXISTS GETS CREDIT.
///  3. ADDING IS THE APP'S OWN `EventEditSheet`, opened with the people and the slot's instant
///     (`prefillStart`). This step keeps only what the sheet cannot do: choosing who, and picking
///     one of the week's real gaps.
///  4. NO INVENTED TIMES. `startsAt == nil` means the whole day is free and the sheet's own picker
///     decides the hour.
///
/// The body is content-sized; the SHELL scrolls.
struct ConnectionStepView: View {
    let props: PlanningStepProps

    @Environment(SyncManager.self) private var sync
    @State private var model = PlanningConnectionModel()
    @State private var picking: String?
    @State private var compose: PlanningConnectionCompose?
    /// Read back in `onSaved`, so it has to outlive the sheet's item being cleared.
    @State private var composeParticipants: [String] = []

    private var tz: TimeZone { sync.householdTz }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.failed, model.board != nil {
                DismissibleErrorBanner(message: ConnectionCopy.readFailed) { model.clearFailed() }
            }
            content
        }
        .task(id: props.weekStart) {
            // SEED FIRST, THEN READ. The crumb carries `links`, and pushing one before the
            // seed lands would hand the shell an empty map to write back over a real one.
            model.seedLinks(from: props.step.data["links"], weekStart: props.weekStart)
            await model.load(weekStart: props.weekStart)
        }
        .onChange(of: model.revision) { _, _ in props.setDecisionData(model.decisionData) }
        // THIS STEP LENDS THE BANNER NOTHING: a parked note has no pairing to belong to.
        // Withdrawn explicitly, because the verb is the SHELL's state and would still be step 2's.
        .onAppear { props.lendVerb(nil) }
        .sheet(item: $compose, onDismiss: composeDismissed) { c in
            eventSheet(c)
        }
    }

    @ViewBuilder private var content: some View {
        if let board = model.board {
            if board.pairings.isEmpty {
                WaffledEmptyState(
                    emoji: "🫂", title: "Nobody to pair up yet",
                    message: ConnectionCopy.needsTwoPeople)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(model.rows) { row in
                        rowCard(row)
                    }
                    PlanningMakePairing(
                        model: model, weekStart: props.weekStart, members: sync.members,
                        busy: props.busy, onCompose: { openComposer($0) })
                    Text(ConnectionCopy.note)
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } else if model.failed {
            WaffledEmptyState(emoji: "📵", title: ConnectionCopy.readFailed)
        } else if !model.loaded {
            VStack(spacing: 8) {
                WaffledLoading(top: 24)
                Text("Looking at who’s been where…")
                    .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
            }
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: - One pairing

    private func rowCard(_ row: PlanningConnectionRow) -> some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 10) {
                    HStack(spacing: -6) {
                        ForEach(row.personIds, id: \.self) { id in
                            face(id)
                        }
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(row.who)

                    VStack(alignment: .leading, spacing: 3) {
                        Text(row.who)
                            .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                        Text(row.sentence)
                            .font(.system(size: 12.5)).foregroundStyle(WF.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }

                ChipFlow(spacing: 6, lineSpacing: 6) {
                    // TIME THAT ALREADY EXISTS, first — the only answer that costs nobody an
                    // evening. AND IT NAMES THE EVENT: a day and an hour identify nothing.
                    if let oneTap = row.oneTap {
                        chip(
                            "\(row.oneTapChosen ? "✓ " : "")\(oneTap.title) · \(String(oneTap.day.prefix(3)))",
                            selected: row.oneTapChosen, tint: WF.success,
                            label: "\(oneTap.title) on \(oneTap.when) "
                                + (row.oneTapChosen ? "is your time together" : "already counts")
                        ) {
                            link(row.key, oneTap.id)
                        }
                    }

                    // An evening where the two are both there ALONGSIDE somebody else was only
                    // ever a sentence. NEVER in the chosen state: one chip per row is the answer.
                    if row.showPicker {
                        chip(
                            row.answer == nil ? "Link a time" : "Change",
                            selected: false, tint: WF.primary,
                            label: (row.answer == nil ? "Link a time" : "Change the time") + " for \(row.who)"
                        ) {
                            picking = picking == row.key ? nil : row.key
                        }
                    }

                    ForEach(row.slots) { slot in
                        chip(slot.label, selected: false, tint: WF.primary, label: slot.label) {
                            openComposer(compose(slot, participantIds: row.personIds))
                        }
                    }

                    chip(
                        "＋ Another time", selected: false, tint: WF.primary,
                        label: "Another time for \(row.who)"
                    ) {
                        openComposer(
                            PlanningConnectionCompose(
                                day: dayDate(props.weekStart), start: nil,
                                participantIds: row.personIds))
                    }
                }

                // Named by WHEN they are — two dinners in one week need telling apart. Picking the
                // one already linked unlinks it.
                if picking == row.key {
                    VStack(spacing: 6) {
                        ForEach(row.candidates) { event in
                            Button {
                                link(row.key, event.id)
                            } label: {
                                HStack(spacing: 8) {
                                    Text(event.title)
                                        .font(.system(size: 13.5, weight: .bold)).foregroundStyle(WF.ink)
                                    Spacer(minLength: 6)
                                    Text(event.when)
                                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                                }
                                .padding(.horizontal, 11).padding(.vertical, 9)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .planningOptionChrome(
                                    selected: row.answer?.id == event.id, tint: WF.success)
                            }
                            .buttonStyle(.plain)
                            .disabled(props.busy)
                            .accessibilityAddTraits(row.answer?.id == event.id ? .isSelected : [])
                        }
                    }
                    .accessibilityLabel("Time \(row.who) already share")
                }
            }
        }
    }

    private func face(_ personId: String) -> some View {
        let member = sync.members.first { $0.id == personId }
        return Avatar(colorHex: member?.colorHex, emoji: member?.emoji ?? "🙂", size: 30)
    }

    private func chip(
        _ text: String, selected: Bool, tint: Color, label: String, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: 12.5, weight: .bold))
                .foregroundStyle(selected ? tint : WF.ink2)
                .padding(.horizontal, 11).padding(.vertical, 7)
                .wfChip(selected: selected, tint: tint)
        }
        .buttonStyle(.plain)
        .disabled(props.busy)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: - Actions

    private func link(_ key: String, _ eventId: String?) {
        picking = nil
        Task { await model.link(key: key, eventId: eventId, sessionId: props.sessionId) }
    }

    /// The day, and the instant ONLY when there is one: `startsAt == nil` is the whole day free.
    private func compose(
        _ slot: WaffledAPI.PlanningConnectionSlot, participantIds: [String]
    ) -> PlanningConnectionCompose {
        PlanningConnectionCompose(
            day: dayDate(slot.date),
            // `EventTime.parse` on purpose: the server sends a UTC instant WITH milliseconds,
            // which a bare `ISO8601DateFormatter` refuses — and a nil falls back to 5pm.
            start: EventTime.parse(slot.startsAt),
            participantIds: participantIds)
    }

    private func openComposer(_ next: PlanningConnectionCompose) {
        composeParticipants = next.participantIds
        compose = next
    }

    /// `onSaved` is ASSIGNED rather than passed: it is a property on `EventEditSheet` with no
    /// matching parameter on that type's explicit initializer, and this file may not edit it.
    private func eventSheet(_ c: PlanningConnectionCompose) -> EventEditSheet {
        var sheet = EventEditSheet(
            event: nil, initialDate: c.day, prefillParticipantIds: c.participantIds,
            prefillStart: c.start)
        sheet.onSaved = { onSaved() }
        return sheet
    }

    /// Re-read, and keep asking until the answer includes the event just written. See `catchup`.
    private func onSaved() {
        // No "did they save?" flag, unlike step 2: this step lends the banner no verb.
        let participants = composeParticipants
        Task {
            await model.settleAfterSave(
                weekStart: props.weekStart, sessionId: props.sessionId,
                participantIds: participants)
        }
        props.refresh()
    }

    private func composeDismissed() {
        composeParticipants = []
    }

    private func dayDate(_ key: String) -> Date {
        DateFmt.date(key, "yyyy-MM-dd", tz) ?? Date()
    }
}

/// "＋ Make a pairing" — the first-class action, at full width under the rows.
///
/// Choosing WHO is the input to the slot query and the prefill for the sheet, not an event form:
/// what, when and the save all belong to `EventEditSheet`, and every chip below opens it.
private struct PlanningMakePairing: View {
    let model: PlanningConnectionModel
    let weekStart: String
    let members: [SyncedMember]
    let busy: Bool
    let onCompose: (PlanningConnectionCompose) -> Void

    @Environment(SyncManager.self) private var sync
    @State private var open = false
    @State private var picked: Set<String> = []
    @State private var slots: [WaffledAPI.PlanningConnectionSlot] = []
    @State private var who = ""

    /// HOUSEHOLD ORDER, not tap order — so the key the composer builds matches a row's.
    private var chosen: [String] { members.filter { picked.contains($0.id) }.map(\.id) }
    /// Keyed on the ids THEMSELVES, so the slot read fires on a change of choice, not a rebuild.
    private var chosenKey: String { chosen.joined(separator: ",") }

    var body: some View {
        Group {
            if open { expanded } else { collapsed }
        }
        .task(id: chosenKey) {
            guard chosen.count >= 2 else {
                slots = []
                who = ""
                return
            }
            if let result = await model.slots(weekStart: weekStart, personIds: chosen) {
                slots = result.slots
                who = result.who
            } else {
                slots = []
                who = ""
            }
        }
    }

    private var collapsed: some View {
        Button {
            open = true
        } label: {
            HStack(spacing: 10) {
                Text("＋ Make a pairing — any two people, any time")
                    .font(.system(size: 13.5, weight: .bold)).foregroundStyle(WF.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 6)
                HStack(spacing: -6) {
                    ForEach(members) { member in
                        Avatar(colorHex: member.colorHex, emoji: member.emoji ?? "🙂", size: 24)
                    }
                }
            }
            .padding(13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .wfField(fill: WF.panel)
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    private var expanded: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel(text: "Who")
                    ChipFlow(spacing: 6, lineSpacing: 6) {
                        ForEach(members) { member in
                            let on = picked.contains(member.id)
                            Button {
                                if picked.contains(member.id) {
                                    picked.remove(member.id)
                                } else {
                                    picked.insert(member.id)
                                }
                            } label: {
                                HStack(spacing: 6) {
                                    Avatar(
                                        colorHex: member.colorHex, emoji: member.emoji ?? "🙂",
                                        size: 22)
                                    Text(member.name)
                                        .font(.system(size: 12.5, weight: .bold))
                                        .foregroundStyle(on ? WF.primaryD : WF.ink2)
                                }
                                .padding(.horizontal, 9).padding(.vertical, 5)
                                .wfChip(selected: on, tint: WF.primary)
                            }
                            .buttonStyle(.plain)
                            .disabled(busy)
                            .accessibilityLabel(
                                on ? "\(member.name) — take out of the pairing"
                                   : "\(member.name) — add to the pairing")
                            .accessibilityAddTraits(on ? .isSelected : [])
                        }
                    }
                    Text(who.isEmpty ? "Tap two people — or three." : "\(who) · tap to add anyone else")
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)
                }

                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel(text: "When")
                    if chosen.count < 2 {
                        Text("Their free evenings appear once there are two of them.")
                            .font(.system(size: 12)).foregroundStyle(WF.ink3)
                    } else {
                        ChipFlow(spacing: 6, lineSpacing: 6) {
                            ForEach(slots.prefix(PlanningConnectionCopy.slotsPerRow + 1)) { slot in
                                chip(slot.label) {
                                    onCompose(
                                        PlanningConnectionCompose(
                                            day: dayDate(slot.date),
                                            start: EventTime.parse(slot.startsAt),
                                            participantIds: chosen))
                                }
                            }
                            // "Any time" has to mean any time — this opens the sheet's own picker.
                            chip("Pick a date and time") {
                                onCompose(
                                    PlanningConnectionCompose(
                                        day: dayDate(weekStart), start: nil,
                                        participantIds: chosen))
                            }
                        }
                    }
                }

                Button("Cancel") {
                    open = false
                    picked = []
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(WF.ink3)
                .buttonStyle(.plain)
            }
        }
    }

    private func chip(_ text: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ink2)
                .padding(.horizontal, 11).padding(.vertical, 7)
                .wfChip(selected: false, tint: WF.primary)
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    private func dayDate(_ key: String) -> Date {
        DateFmt.date(key, "yyyy-MM-dd", sync.householdTz) ?? Date()
    }
}

/// What the shared event sheet is opening on. `start` is nil when the whole day is free.
struct PlanningConnectionCompose: Identifiable {
    let id = UUID().uuidString
    let day: Date
    let start: Date?
    let participantIds: [String]
}

/// The step's fixed copy, in one place so a sentence can be asserted without a view.
enum ConnectionCopy {
    static let readFailed = "Couldn’t read your week just now."
    static let needsTwoPeople =
        "This one needs more than one person in the household — add someone in Settings, and pairings appear here."
    static let note =
        "The rows above are just the pairings the app can see — they aren’t the list. "
        + "Make a pairing takes any two people and any time, and the slots offered are the gaps the "
        + "week already left behind. Either way it ends up as a normal calendar event. Add a third "
        + "person and it still lands on the calendar — it just counts as time together rather than as "
        + "time with just the two of them."
}

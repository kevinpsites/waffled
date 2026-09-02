import SwiftUI

/// Create a rhythm by saying it as a sentence:
///
///     🌬 Air filter
///     every 3 months,
///     counted when I mark it done,
///     on Kevin
///
/// and then read, underneath, what that sentence will actually do. The sheet used to open
/// with a two-card picker for the shape, which put the most abstract question first and
/// asked it in the vocabulary of the schema. That choice hasn't gone anywhere — it is the
/// "counted when" clause, phrased as the thing it decides:
///
///   `.completion` — you did the thing, and the clock restarts from when you ACTUALLY did
///                   it, so being late shifts the next one instead of stacking misses.
///   `.scheduling` — a calendar event exists for the period. We never ask whether it
///                   happened; getting the opportunity onto the calendar IS the outcome.
///
/// Mirrors the web `RhythmModal.tsx`, down to the line breaks — web places them with
/// `<br />` and this places them as rows of a `VStack`, because SwiftUI has no inline flow
/// and the design prescribes the same four lines either way.
///
/// Every token is a real control, never a tappable label: the sentence has nowhere to hang
/// a visible label, so each one carries an accessibility label instead. The "counted when"
/// token is a `Menu` rather than a picker because both options need their consequence
/// spelled out, and a two-`Text` menu button is exactly the native control for that.
///
/// Editing asks LESS. The shape and the period anchor (`startsOn`, `autoSchedule`,
/// `rrule`) are not editable and the server refuses them: moving the anchor of a live
/// rhythm would silently re-interpret the periods it has already skipped — they are keyed
/// on `period_start` — and point its bookings at periods that no longer exist. So on an
/// edit those clauses are stated rather than offered.
struct RhythmEditorSheet: View {
    let model: RhythmsModel
    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss
    @State private var form: RhythmForm
    @State private var saving = false
    @State private var error: String?
    @State private var advanced = DemoHooks.rhythmEditorMore

    init(model: RhythmsModel, editing: WaffledAPI.Rhythm? = nil) {
        self.model = model
        _form = State(initialValue: editing.map { RhythmForm(editing: $0) } ?? RhythmForm())
    }

    private var isNew: Bool { form.editingId == nil }
    /// Editable on a completion rhythm — that just moves the next due date. Not on a
    /// scheduling one, whose periods are generated from it.
    private var cadenceFixed: Bool { !isNew && form.shape == .scheduling }

    /// Completion shape only: a scheduling rhythm has no completions by design — whether
    /// it happened is the question that shape refuses to ask — so it is never requested.
    @State private var history: WaffledAPI.RhythmHistory?
    @State private var rawRuleOpen = false

    /// Named for what it decides, not for the column it is stored in.
    private static let modes: [(shape: WaffledAPI.RhythmShape, label: String, why: String)] = [
        (.completion, "I mark it done",
         "The clock restarts the day you actually do it. Late once ≠ late forever."),
        (.scheduling, "it’s on the calendar",
         "Getting it booked is the win — nobody asks later whether it happened."),
    ]

    private var modeLabel: String {
        Self.modes.first { $0.shape == form.shape }?.label ?? ""
    }

    /// Both fields follow the cadence until they are touched, and touching one is what
    /// pins it. The controls therefore read the derived value and write the raw one —
    /// binding straight to the optional would show an empty control for a default that is,
    /// in fact, entirely definite.
    private var leadBinding: Binding<Int> {
        Binding(get: { form.effectiveLeadDays }, set: { form.leadDays = $0 })
    }

    private var dueBinding: Binding<Date> {
        Binding(get: { form.firstDue() }, set: { form.nextDue = $0 })
    }

    /// The booking window as editable text.
    ///
    /// Text rather than an Int binding because "no window" has to be expressible: an
    /// empty field means the whole period counts, which is what `every` meant on its own
    /// and what every rhythm made before the column has. A number binding would have to
    /// pick some sentinel for that, and zero reads as "no days count at all".
    private var windowBinding: Binding<String> {
        Binding(
            get: { form.windowDays.map(String.init) ?? "" },
            set: { form.windowDays = Int($0.filter(\.isNumber)).flatMap { $0 > 0 ? $0 : nil } })
    }

    private var windowExplainer: String {
        guard let d = form.windowDays, d > 0 else {
            return "Leave it blank and a booking anywhere in the period counts."
        }
        return "You’ll be asked at the start of each period, and a booking counts for "
            + "\(d) \(d == 1 ? "day" : "days") — after that the period goes unbooked."
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Say it as a sentence. Everything else has a sane default.")
                        .font(.system(size: 13)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)

                    sentence

                    if isNew { consequence } else { anchorNote }
                    if let history, history.total > 0 { historyNote(history) }

                    moreRow
                    if advanced { advancedFields }

                    if let error {
                        Text(error).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    WaffledPrimaryCTA(label: isNew ? "Add rhythm" : "Save changes",
                                      isBusy: saving, isDisabled: !form.isValid) {
                        Task { await save() }
                    }
                }
                .padding(16)
            }
            // The cadence field is a number pad, and a number pad has no return key. Without
            // this the only way out of it is to tap another control, which is a trap on a
            // sheet whose primary button the keyboard is covering.
            .scrollDismissesKeyboard(.interactively)
            .background(WF.canvas)
            .task {
                guard let id = form.editingId, form.shape == .completion else { return }
                history = try? await WaffledAPI().rhythmCompletions(id: id, limit: 5)
            }
            .navigationTitle(isNew ? "New rhythm" : "Edit rhythm")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    // MARK: - the sentence

    private var sentence: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                // The emoji leads, as it does on every row this will become.
                TextField("🔁", text: $form.emoji)
                    .font(.system(size: 17))
                    .multilineTextAlignment(.center)
                    .frame(width: 54)
                    .padding(.vertical, 9)
                    .wfField(radius: WF.rSM, fill: WF.panel)
                    .accessibilityLabel("Emoji")
                // The placeholder is the first example anyone reads, so it is the most
                // ordinary rhythm there is rather than the most exotic one.
                TextField("Take the trash out", text: $form.title)
                    .font(.system(size: 17, weight: .semibold))
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .frame(maxWidth: .infinity)
                    .wfField(radius: WF.rSM, fill: WF.panel)
                    .accessibilityLabel("What")
            }

            HStack(spacing: 8) {
                fixed("every")
                if cadenceFixed {
                    // A scheduling rhythm's cadence IS its period grid: periods are tiled
                    // from the anchor by this interval, so a new one re-reads every period
                    // already skipped or booked. Same reason "counted when" is fixed below,
                    // and stated the same way rather than left to fail on save.
                    HStack(spacing: 1) {
                        fixedToken("\(form.count) \(form.unit.label)")
                        fixed(",")
                    }
                    Spacer(minLength: 0)
                } else {
                    TextField("1", value: $form.count, format: .number)
                        .font(.system(size: 17, weight: .semibold))
                        .multilineTextAlignment(.center)
                        .keyboardType(.numberPad)
                        .frame(width: 56)
                        .padding(.vertical, 9)
                        .wfField(radius: WF.rSM, fill: WF.panel)
                        .accessibilityLabel("How often")
                    // The comma hangs off the token it follows rather than sitting a whole
                    // word-space away from it, which read as a stray mark on its own.
                    HStack(spacing: 1) {
                        Menu {
                            ForEach(RhythmForm.Unit.allCases) { u in
                                Button(u.label) { form.unit = u }
                            }
                        } label: { WaffledMenuPill(text: form.unit.label) }
                            .accessibilityLabel("Unit")
                        fixed(",")
                    }
                    Spacer(minLength: 0)
                }
            }

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                fixed("counted when")
                HStack(spacing: 1) {
                    if isNew {
                        // Two `Text`s in a menu button become a title and a subtitle, which
                        // is the whole reason this is a Menu and not a Picker: both answers
                        // need their consequence spelled out, and a wheel has nowhere to
                        // put one.
                        Menu {
                            ForEach(Self.modes, id: \.shape) { m in
                                Button { form.shape = m.shape } label: {
                                    Text(m.label)
                                    Text(m.why)
                                }
                            }
                        } label: { WaffledMenuPill(text: modeLabel) }
                            .accessibilityLabel("counted when")
                    } else {
                        // Not offered: re-shaping a live rhythm would re-read every period
                        // it has already skipped or booked. Stated plainly, not hidden.
                        fixedToken(modeLabel)
                    }
                    fixed(",")
                }
                Spacer(minLength: 0)
            }

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                fixed("on")
                Menu {
                    Button("the whole household") { form.personId = nil }
                    ForEach(sync.members) { m in Button(m.name) { form.personId = m.id } }
                } label: {
                    WaffledMenuPill(text: sync.members.first { $0.id == form.personId }?.name
                                    ?? "the whole household")
                }
                .accessibilityLabel("Who")
                Spacer(minLength: 0)
            }
        }
    }

    /// The words between the tokens — the parts of the sentence nobody edits.
    private func fixed(_ text: String) -> some View {
        Text(text).font(.system(size: 17)).foregroundStyle(WF.ink2)
            .lineLimit(1).fixedSize()
    }

    /// A clause that is stated rather than offered. Shaped like the tokens beside it so the
    /// sentence still reads as one sentence, and flat so it doesn't invite a tap.
    private func fixedToken(_ text: String) -> some View {
        Text(text).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink2)
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(WF.panel.opacity(0.6)).clipShape(Capsule())
    }

    // MARK: - what the sentence will do

    /// The two dates that are the whole promise. Both come through `consequence`, which
    /// derives them from `nudgePlan` rather than from the typed runway: the server keeps
    /// `least(leadTime, every / 2)`, so a weekly rhythm asked for 14 days' notice would
    /// otherwise be promised a nudge on a day nothing is ever going to happen.
    @ViewBuilder private var consequence: some View {
        let anchor = form.shape == .scheduling ? form.startsOn : form.firstDue()
        if let plan = RhythmFormat.consequence(shape: form.shape, every: form.every,
                                               leadDays: form.effectiveLeadDays, anchor: anchor) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: form.shape == .completion ? "checkmark.circle.fill" : "calendar")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(WF.primary)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 6) {
                    promise(plan)
                        .font(.system(size: 13.5)).foregroundStyle(WF.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if let cap = RhythmFormat.capNote(every: form.every, leadDays: form.effectiveLeadDays) {
                        Text(cap).font(.system(size: 12)).foregroundStyle(WF.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
    }

    private func promise(_ plan: RhythmFormat.Consequence) -> Text {
        let lands = Text(RhythmFormat.dayMonth(plan.landsOn)).bold()
        let nudge = Text(RhythmFormat.dayMonth(plan.nudgeFrom)).bold()
        if form.shape == .completion {
            return Text("Next one lands around ") + lands + Text(". It’ll be on your Today card from ")
                + nudge + Text(". If you do it late the next one moves with it — misses never stack up.")
        }
        return Text("Booking it is the win — we’ll never ask whether it happened. A fresh window opens ")
            + Text(RhythmFormat.cadenceLabel(form.every))
            + Text(", and if nothing’s on the calendar by ") + nudge + Text(" it moves to Needs you now.")
    }

    /// On an edit, the clause the sheet won't offer — named in full, with the way through.
    /// The history this rhythm has actually kept, and how often it REALLY happens.
    ///
    /// `GET /:id/completions` and its average have existed since the migration and were
    /// reachable from no client — iOS did not even have the call. So the register kept a
    /// record it could not show, and the fact it is kept FOR ("how often does this really
    /// happen?") had nowhere to appear. A nominal 3 months that runs at 5 is the cadence
    /// telling you it is wrong.
    @ViewBuilder private func historyNote(_ h: WaffledAPI.RhythmHistory) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(historyHeadline(h))
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(h.completions.map { RhythmFormat.shortDate($0.completedAt) }.joined(separator: " · "))
                .font(.system(size: 13)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .wfField(radius: WF.rSM, fill: WF.panel)
    }

    private func historyHeadline(_ h: WaffledAPI.RhythmHistory) -> String {
        let done = h.total == 1 ? "Done once" : "Done \(h.total) times"
        // Rounded, and absent below two completions: one date is not an interval, so the
        // server returns null there rather than inventing one — and this must not fill
        // that in with a number of its own.
        guard let avg = h.averageIntervalDays else { return done }
        return "\(done) · about every \(Int(avg.rounded())) days, against \(RhythmFormat.cadenceLabel(form.every))"
    }

    /// One weekday, not several.
    ///
    /// Single-select on purpose, unlike the calendar's event editor: a rule that fires
    /// twice inside one period would assert something the cadence never said, and the
    /// period is satisfied by ONE booking either way. Web behaves the same.
    private var weekdayChips: some View {
        let current = form.byday.first ?? Recurrence.weekdayCode(form.startsOn)
        return HStack(spacing: 6) {
            ForEach(Recurrence.weekdays, id: \.self) { code in
                WeekdayToggleChip(label: Self.chipDay[code] ?? code, isOn: current == code) {
                    form.byday = [code]
                }
            }
        }
    }

    private static let chipDay = ["SU": "Su", "MO": "Mo", "TU": "Tu", "WE": "We", "TH": "Th", "FR": "Fr", "SA": "Sa"]
    /// 1…5 and -1 (last) — "the last Saturday" is not expressible as a day number, and a
    /// rhythm anchored on the 31st is the case that makes it necessary.
    private static let monthlyOrdinals = [1, 2, 3, 4, 5, -1]
    private static let ordinalWord = ["", "first", "second", "third", "fourth", "fifth"]

    private func ordinalWord(_ n: Int) -> String {
        n == -1 ? "last" : (Self.ordinalWord.indices.contains(n) ? Self.ordinalWord[n] : "\(n)th")
    }

    private var monthlyModeMenu: some View {
        let weekdayName = DateFmt.string(form.startsOn, "EEEE", Cal.current.timeZone)
        func nth(_ ord: Int) -> String { "The \(ordinalWord(ord)) \(weekdayName)" }
        let current = form.monthlyMode == .dayOfMonth ? "The same date" : nth(form.monthlyOrdinal)
        return Menu {
            Button("The same date") { form.monthlyMode = .dayOfMonth }
            ForEach(Self.monthlyOrdinals, id: \.self) { ord in
                Button(nth(ord)) { form.monthlyMode = .nthWeekday; form.monthlyOrdinal = ord }
            }
        } label: {
            WaffledMenuPill(text: current)
        }
    }

    /// The escape hatch, for anything the builder cannot say. Carried by the form since it
    /// was written and never shown, so a rule web could express had no iOS equivalent.
    @ViewBuilder private var advancedRule: some View {
        DisclosureGroup(isExpanded: $rawRuleOpen) {
            TextField("FREQ=MONTHLY;BYDAY=2FR", text: $form.customRule)
                .font(.system(size: 14, design: .monospaced))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.characters)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .wfField(radius: WF.rSM, fill: WF.panel)
                .padding(.top, 6)
        } label: {
            Text("Advanced — write the rule yourself")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
        }
    }

    private var anchorNote: some View {
        LockNote(form.shape == .scheduling
                 ? "Periods are anchored to \(RhythmFormat.shortDate(RhythmFormat.ymd(form.startsOn))), \(RhythmFormat.cadenceLabel(form.every)). Moving the anchor would re-interpret the periods you’ve already skipped or booked, so it can’t change here — retire this one and make a new one instead."
                 : "The clock isn’t set by hand — marking it done restarts it from when you actually did it. Moving the anchor would mean a different rhythm, so retire this one and make a new one instead.")
    }

    // MARK: - more options

    private var moreRow: some View {
        Button { advanced.toggle() } label: {
            HStack(spacing: 8) {
                Image(systemName: advanced ? "chevron.down" : "chevron.right")
                    .font(.system(size: 12, weight: .bold))
                Text(advanced ? "Fewer options"
                     : "More options — notes, how early to nudge, auto-add to calendar")
                    .font(.system(size: 13, weight: .semibold))
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .foregroundStyle(WF.ink2)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var advancedFields: some View {
        WaffledFieldCard(title: form.shape == .completion
                         ? "Start nudging me this many days early"
                         : "Start nudging me this many days before the window closes") {
            VStack(alignment: .leading, spacing: 6) {
                Stepper("\(form.effectiveLeadDays) days", value: leadBinding, in: 0...365)
                    .font(.system(size: 15, weight: .semibold))
                // Spelled out against THIS rhythm's cadence rather than left as "the
                // period", which was reasonably read as "what period? I'm scheduling it
                // every week".
                Text(form.shape == .completion
                     ? "Capped at half the cadence — a runway longer than the cycle never closes, so it would never go quiet."
                     : RhythmFormat.nudgeExplainer(every: form.every, leadDays: form.effectiveLeadDays))
                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }

        // The anchors are create-only: see the note at the top of this file.
        if isNew {
            if form.shape == .completion {
                WaffledFieldCard(title: "First one due") {
                    DatePicker("First one due", selection: dueBinding, displayedComponents: [.date])
                        .datePickerStyle(.compact)
                        .labelsHidden()
                }
            } else {
                WaffledFieldCard(title: "First period starts") {
                    VStack(alignment: .leading, spacing: 10) {
                        DatePicker("First period starts", selection: $form.startsOn,
                                   displayedComponents: [.date])
                            .datePickerStyle(.compact)
                            .labelsHidden()

                        Toggle("Put it on the calendar automatically", isOn: $form.autoSchedule)
                            .font(.system(size: 15, weight: .semibold))
                            .tint(WF.primary)
                        if form.autoSchedule {
                            Text("\(Recurrence.describeRrule(form.rrule(), start: form.startsOn)) — booked once, then it just stays there.")
                                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                                .fixedSize(horizontal: false, vertical: true)
                            // Which day it lands on. The weekday used to come from the
                            // anchor date and only from there, so a rhythm you wanted on
                            // Wednesdays had to be ANCHORED on a Wednesday. Web has had
                            // these since the redesign.
                            if form.unit == .weeks { weekdayChips }
                            if form.unit == .months { monthlyModeMenu }
                            advancedRule
                        } else {
                            Text("When it happens is an open decision every period, so it’ll ask you to pick a time.")
                                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }

        // The booking window — the one part of WHEN that is editable in place, so unlike
        // the anchor block above it is not gated on `isNew`. The cadence and the anchor
        // ARE the period grid: moving either re-reads every boundary, so skips (keyed on
        // period_start) stop matching and bookings get re-attributed. A window moves no
        // boundary and re-keys no skip — narrowing one can put a period back to asking,
        // which is visible and undone by widening it again.
        //
        // Hidden when the rhythm books itself: the rule already decides which day inside
        // the period, so there is nothing left to pick, and the server refuses the pair.
        if form.shape == .scheduling, !form.autoSchedule {
            WaffledFieldCard(title: "Only the first … days of each period count") {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("the whole period", text: windowBinding)
                        .keyboardType(.numberPad)
                        .font(.system(size: 15))
                        .padding(.horizontal, 12).padding(.vertical, 11)
                        .wfField(radius: WF.rSM, fill: WF.panel)
                    Text(windowExplainer)
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }

        WaffledFieldCard(title: "Notes") {
            TextField("Furnace, 20x25x1", text: $form.notes, axis: .vertical)
                .lineLimit(2...4)
                .font(.system(size: 15))
                .padding(.horizontal, 12).padding(.vertical, 11)
                .wfField(radius: WF.rSM, fill: WF.panel)
        }
    }

    private func save() async {
        guard !saving, form.isValid else { return }
        saving = true
        error = nil
        do {
            try await model.save(form)
            dismiss()
        } catch {
            self.error = APIErrorText.message(for: error, fallback: "Couldn’t save that — check the cadence and try again.")
            saving = false
        }
    }
}

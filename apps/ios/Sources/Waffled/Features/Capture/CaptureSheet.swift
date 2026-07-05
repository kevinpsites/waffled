import SwiftUI

/// "Add anything" — type free text, the server's pluggable LLM parses it, you
/// confirm the preview, and it commits. Mirrors the handoff `ios-add.png`.
///
/// Events are written to the local mirror and routed/pushed to Google server-side
/// (see SyncManager.commitEvent). Grocery/task/meal commits land next.
struct CaptureSheet: View {
    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss
    /// Start voice dictation as soon as the sheet appears (from a mic tap).
    var autoDictate = false
    @State private var text = ""
    @State private var phase: Phase = .input
    @State private var intent: CaptureIntent?
    @State private var via = ""
    @State private var thinking = false              // the LLM is still improving the guess
    @State private var serverAlt: CaptureIntent?     // the LLM's take when it disagrees with a confident heuristic
    @State private var serverAltVia = ""
    @State private var error: String?
    @State private var dictation = Dictation()
    // Inline-editable fields for the "Waffled understood" card (populated per intent).
    @State private var editKind = "event"       // the (re-classifiable) intent kind
    @State private var editName = ""            // event title / item / chore / meal
    @State private var evDate = Date()
    @State private var evAllDay = false
    @State private var evPerson: String?        // event / task assignee
    @State private var editQty = ""             // grocery / list quantity
    @State private var editListName = ""        // list target
    @State private var taskStars = 0
    @State private var taskCurrency = "stars"
    @State private var taskRrule: String?       // preserved if the parse found a recurrence
    @State private var evRepeat = RepeatState.none   // event recurrence (seeded by the parse, editable)
    @State private var evUntilOn = false             // "ends on a date" toggle
    @State private var evUntil = Date()
    @State private var mealSlot = "dinner"
    @State private var mealDate = Date()
    @State private var lists: [WaffledAPI.ListSummary] = []   // for the list picker
    @State private var editing = false                     // glance → full field editor
    @FocusState private var focused: Bool
    @State private var detent: PresentationDetent = .large   // open tall (roomy input), draggable to medium

    private static let kinds: [(key: String, icon: String, label: String)] = [
        ("event", "📅", "Event"), ("list", "📝", "List"), ("grocery", "🛒", "Grocery"),
        ("task", "✅", "Task"), ("meal", "🍽️", "Meal"),
    ]

    enum Phase { case input, parsing, preview, committing }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            if let error {
                Text(error).font(.system(size: 13)).foregroundStyle(WF.primaryD)
            }
            switch phase {
            case .input, .parsing: inputView
            case .preview, .committing: previewView
            }
            Spacer(minLength: 0)
        }
        .padding(20)
        .background(WF.canvas)
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .task {
            // Focus the field (or start dictation / demo) FIRST so the keyboard comes
            // up instantly. The LLM warm-up + ancillary loads used to be awaited here,
            // which froze the sheet for ~10s before the keyboard appeared — they now
            // run off the critical path below.
            if let demo = DemoHooks.captureText {   // headless demo driver (no-op unless set)
                text = demo
                parse()
            } else if autoDictate {
                dictation.toggle()
            } else {
                focused = true
            }
            // Pre-warm the model + load list/currency pickers in the background. None of
            // these are needed until after the user types and parses, so they never need
            // to block focus.
            async let warm: Void = sync.warmCapture()
            async let currencies: Void = sync.loadCurrencies()
            let fetchedLists = (try? await WaffledAPI().listSummaries()) ?? []
            _ = await (warm, currencies)
            lists = fetchedLists
        }
        .onDisappear { dictation.stop(); resetForm() }
    }

    /// Clear everything so reopening the bar starts fresh (the sheet's @State otherwise
    /// survives a dismiss on iPhone, leaving the last parse filled in).
    private func resetForm() {
        text = ""; phase = .input; error = nil
        intent = nil; via = ""; thinking = false
        serverAlt = nil; serverAltVia = ""
        editing = false; editKind = "event"; editName = ""; editQty = ""
        evRepeat = .none; evUntilOn = false; evPerson = nil
        taskStars = 0; taskRrule = nil
        detent = .large
    }

    // MARK: header
    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkles").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ai)
            Text("Add with AI").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ai)
            Spacer()
            Button("Cancel") { dismiss() }
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
        }
    }

    // MARK: input
    private var inputView: some View {
        VStack(alignment: .leading, spacing: 14) {
            ZStack(alignment: .bottomTrailing) {
                TextField("Soccer practice Tuesday at 4pm for Wally…", text: $text, axis: .vertical)
                    .font(.system(size: 17, weight: .semibold))
                    .lineLimit(3...8)
                    .focused($focused)
                    .submitLabel(.go)
                    .onSubmit(parse)
                    .padding(16).padding(.trailing, 40)
                    .background(WF.panel)
                    .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))

                Button { dictation.toggle() } label: {
                    Image(systemName: dictation.isListening ? "mic.fill" : "mic")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(dictation.isListening ? .white : WF.ink2)
                        .frame(width: 34, height: 34)
                        .background(dictation.isListening ? WF.primary : WF.card)
                        .clipShape(Circle())
                        .overlay(Circle().strokeBorder(dictation.isListening ? Color.clear : WF.hair, lineWidth: 1))
                }
                .buttonStyle(.plain).padding(10)
            }
            .onChange(of: dictation.transcript) { _, t in if !t.isEmpty { text = t } }

            WaffledPrimaryCTA(
                label: phase == .parsing ? "Thinking…" : "Tell Waffled",
                tint: WF.ai,
                isBusy: phase == .parsing,
                isDisabled: !canParse,
                action: parse
            )
        }
    }

    private var canParse: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: preview — a confident one-tap "glance", with the full field editor a tap away

    @ViewBuilder private var previewView: some View {
        if editing { editorView } else { glanceView }
    }

    // Glance: the first guess. Tap Add to commit it as-is, or Edit to refine.
    private var glanceView: some View {
        VStack(alignment: .leading, spacing: 12) {
            glanceCard
            if let alt = serverAlt { altRow(alt) }
            HStack(spacing: 10) {
                Button { withAnimation(.snappy(duration: 0.22)) { editing = true } } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "slider.horizontal.3").font(.system(size: 13, weight: .semibold))
                        Text("Edit").font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundStyle(WF.ink)
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }
                commitButton
            }
            .buttonStyle(.plain)
        }
    }

    // Editor: the full, re-classifiable card we built — reached by the Edit tap.
    private var editorView: some View {
        VStack(alignment: .leading, spacing: 12) {
            understoodCard
            typeSwitcher
            HStack(spacing: 10) {
                Button("Edit text") { phase = .input; focused = true }
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                commitButton
            }
            .buttonStyle(.plain)
        }
    }

    private var commitButton: some View {
        WaffledPrimaryCTA(
            label: addLabel,
            tint: WF.primary,
            isBusy: phase == .committing,
            isDisabled: !canCommit,
            action: commit
        )
    }

    // The confident summary line — icon, kind, what Waffled heard, and who it's for.
    private var glanceCard: some View {
        HStack(spacing: 12) {
            WaffledEmojiTile(emoji: Self.kinds.first { $0.key == editKind }?.icon ?? "✨")
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(editKind.uppercased()).font(.system(size: 11, weight: .heavy)).tracking(0.4).foregroundStyle(WF.ai)
                    if thinking {
                        HStack(spacing: 3) {
                            ProgressView().controlSize(.mini)
                            Text("improving…").font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ai)
                        }
                    } else if !viaLabel.isEmpty {
                        Text(viaLabel).font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                }
                Text(editName.isEmpty ? namePlaceholder : editName)
                    .font(.system(size: 17, weight: .bold)).foregroundStyle(WF.ink)
                if !glanceDetail.isEmpty {
                    Text(glanceDetail).font(.system(size: 12.5)).foregroundStyle(WF.ink2)
                }
            }
            Spacer(minLength: 0)
            if let m = sync.member(named: evPerson) {
                Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 32)
            }
        }
        .padding(14)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    /// When the LLM and the on-device guess disagree on the kind, offer the other take —
    /// "this is what the LLM suggests" — as a one-tap toggle.
    private func altRow(_ alt: CaptureIntent) -> some View {
        let s = altSummary(alt)
        return Button { withAnimation(.snappy(duration: 0.2)) { switchToAlt() } } label: {
            HStack(spacing: 10) {
                Image(systemName: "sparkles").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ai)
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(altProviderLabel) reads it as a \(s.kind.lowercased())")
                        .font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ai)
                    Text(s.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                }
                Spacer(minLength: 6)
                Text("Use it").font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ai)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(WF.ai.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.ai.opacity(0.25), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func altSummary(_ i: CaptureIntent) -> (kind: String, title: String) {
        switch i {
        case let .event(t, _, _, _, _, _, _): return ("Event", t)
        case let .grocery(n, _): return ("Grocery", n)
        case let .task(t, _, _, _, _): return ("Task", t)
        case let .meal(t, _, _, _): return ("Meal", t)
        case let .list(item, _, _): return ("List", item)
        }
    }

    private var altProviderLabel: String {
        switch serverAltVia {
        case "on-device": return "The on-device guess"
        case "anthropic": return "Claude"
        case "openai": return "OpenAI"
        case "ollama": return "The local LLM"
        default: return "The other parse"
        }
    }

    /// The one-line subtitle under the glance title, per kind.
    private var glanceDetail: String {
        switch editKind {
        case "event":
            let pattern = evAllDay ? "EEE, MMM d" : "EEE, MMM d · h:mm a"
            var detail = DateFmt.string(evDate, pattern, sync.householdTz) + (evAllDay ? " · all day" : "")
            // Surface the recurrence in the glance so "every Thursday" reads as recurring.
            if evRepeat.freq != .none {
                var cal = Calendar(identifier: .gregorian); cal.timeZone = sync.householdTz
                let rr = Recurrence.buildRrule(evRepeat, start: evDate, cal)
                detail += " · 🔁 \(Recurrence.describeRrule(rr, start: evDate, cal))"
            }
            return detail
        case "task":
            let who = evPerson ?? "Up for grabs"
            let reward = taskStars > 0 ? " · \(taskStars) \(rewardLabel.lowercased())" : ""
            return who + reward
        case "grocery":
            return editQty.isEmpty ? "Adds to the grocery list" : "\(editQty) · grocery list"
        case "list":
            return editListName.isEmpty ? "Adds to a list" : "Adds to \(editListName)"
        case "meal":
            return "\(mealSlot.capitalized) · \(DateFmt.string(mealDate, "EEE, MMM d", sync.householdTz))"
        default: return ""
        }
    }

    private var understoodCard: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(alignment: .top, spacing: 12) {
                WaffledEmojiTile(emoji: Self.kinds.first { $0.key == editKind }?.icon ?? "✨")
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Text(editKind.uppercased()).font(.system(size: 11, weight: .heavy)).tracking(0.4).foregroundStyle(WF.ai)
                        if !viaLabel.isEmpty { Text(viaLabel).font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3) }
                        Spacer()
                    }
                    TextField(namePlaceholder, text: $editName)
                        .font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                        .padding(.horizontal, 12).padding(.vertical, 10).innerInput()
                    kindFields
                }
            }
        }
        .padding(14)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    @ViewBuilder private var kindFields: some View {
        switch editKind {
        case "event":
            personChips(allowNone: true, noneLabel: "Nobody", icon: "🚫")
            HStack(spacing: 8) {
                DatePicker("", selection: $evDate, displayedComponents: .date).labelsHidden()
                if !evAllDay { DatePicker("", selection: $evDate, displayedComponents: .hourAndMinute).labelsHidden() }
                Spacer(minLength: 0)
            }
            toggleChip("All day", on: evAllDay) { evAllDay.toggle() }
            eventRepeatFields
        case "task":
            personChips(allowNone: true, noneLabel: "Up for grabs", icon: "🙌")
            HStack(spacing: 10) {
                Text(rewardLabel).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
                stepper($taskStars)
                if sync.currencies.count > 1 { currencyMenu }
            }
        case "grocery":
            TextField("quantity (optional, e.g. 2 lbs)", text: $editQty)
                .font(.system(size: 14, weight: .semibold))
                .padding(.horizontal, 12).padding(.vertical, 10).innerInput()
        case "list":
            listPicker
            TextField("quantity (optional)", text: $editQty)
                .font(.system(size: 14, weight: .semibold))
                .padding(.horizontal, 12).padding(.vertical, 10).innerInput()
        case "meal":
            ChipFlow(spacing: 8, lineSpacing: 8) {
                ForEach(["breakfast", "lunch", "dinner", "snack"], id: \.self) { mt in
                    selectChip(mt.capitalized, on: mealSlot == mt) { mealSlot = mt }
                }
            }
            HStack { DatePicker("", selection: $mealDate, displayedComponents: .date).labelsHidden(); Spacer(minLength: 0) }
        default: EmptyView()
        }
    }

    // MARK: field pieces

    private func personChips(allowNone: Bool, noneLabel: String, icon: String) -> some View {
        ChipFlow(spacing: 8, lineSpacing: 8) {
            if allowNone {
                selectChip("\(icon) \(noneLabel)", on: evPerson == nil) { evPerson = nil }
            }
            ForEach(sync.members) { m in
                let on = evPerson == m.name
                Button { evPerson = m.name } label: {
                    HStack(spacing: 6) {
                        Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 20)
                        Text(m.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(on ? WF.ai : WF.ink)
                    }
                    .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 6)
                    .background(on ? WF.ai.opacity(0.1) : WF.card2)
                    .overlay(Capsule().strokeBorder(on ? WF.ai : WF.hair, lineWidth: on ? 1.5 : 1)).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func selectChip(_ label: String, on: Bool, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            Text(label).font(.system(size: 13, weight: .semibold)).foregroundStyle(on ? WF.ai : WF.ink)
                .lineLimit(1).fixedSize()
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(on ? WF.ai.opacity(0.1) : WF.card2)
                .overlay(Capsule().strokeBorder(on ? WF.ai : WF.hair, lineWidth: on ? 1.5 : 1)).clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func toggleChip(_ label: String, on: Bool, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            HStack(spacing: 5) {
                Image(systemName: on ? "checkmark.square.fill" : "square").font(.system(size: 13)).foregroundStyle(on ? WF.ai : WF.ink3)
                Text(label).font(.system(size: 13, weight: .semibold)).foregroundStyle(on ? WF.ai : WF.ink2)
            }
            .padding(.horizontal, 11).padding(.vertical, 7)
            .background(on ? WF.ai.opacity(0.1) : WF.card2)
            .overlay(Capsule().strokeBorder(on ? WF.ai : WF.hair, lineWidth: on ? 1.5 : 1)).clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: event recurrence (capture parity with the web — Repeats + Until)

    /// A compact repeat picker for a captured event: a frequency menu (seeded by the
    /// AI's parse) plus an optional "ends on a date". Builds an RRULE on commit; the
    /// full per-occurrence editing lives in the calendar editor.
    @ViewBuilder private var eventRepeatFields: some View {
        HStack(spacing: 8) {
            Text("Repeats").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
            Menu {
                Button("Does not repeat") { evRepeat = .none }
                Button("Daily") { evRepeat = { var s = RepeatState.none; s.freq = .daily; return s }() }
                Button("Weekdays") { evRepeat = { var s = RepeatState.none; s.freq = .weekdays; return s }() }
                Button("Weekly") { evRepeat.freq = .weekly }   // keeps any AI-parsed day
                Button("Monthly") { evRepeat = { var s = RepeatState.none; s.freq = .monthly; return s }() }
                Button("Yearly") { evRepeat = { var s = RepeatState.none; s.freq = .custom; s.unit = .year; return s }() }
            } label: {
                HStack(spacing: 5) {
                    Text(captureRepeatLabel).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink)
                    Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(WF.ink3)
                }
                .padding(.horizontal, 11).padding(.vertical, 7)
                .background(WF.card2).overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1)).clipShape(Capsule())
            }
            Spacer(minLength: 0)
        }
        if evRepeat.freq != .none {
            HStack(spacing: 8) {
                toggleChip("Ends on", on: evUntilOn) { evUntilOn.toggle() }
                if evUntilOn {
                    DatePicker("", selection: $evUntil, in: evDate..., displayedComponents: .date).labelsHidden()
                }
                Spacer(minLength: 0)
            }
        }
    }

    private var captureRepeatLabel: String {
        switch evRepeat.freq {
        case .none: return "Does not repeat"
        case .daily: return "Daily"
        case .weekdays: return "Weekdays"
        case .weekly: return "Weekly"
        case .monthly: return "Monthly"
        case .custom: return evRepeat.unit == .year ? "Yearly" : "Custom"
        }
    }

    private func stepper(_ value: Binding<Int>) -> some View {
        HStack(spacing: 12) {
            Button { if value.wrappedValue > 0 { value.wrappedValue -= 1 } } label: {
                Image(systemName: "minus.circle.fill").font(.system(size: 22)).foregroundStyle(value.wrappedValue > 0 ? WF.ink2 : WF.hair)
            }.buttonStyle(.plain)
            Text("\(value.wrappedValue)").font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.ink).frame(minWidth: 18)
            Button { value.wrappedValue += 1 } label: {
                Image(systemName: "plus.circle.fill").font(.system(size: 22)).foregroundStyle(WF.primary)
            }.buttonStyle(.plain)
        }
    }

    private var currencyMenu: some View {
        Menu {
            ForEach(sync.currencies) { c in Button("\(c.symbol) \(c.label)") { taskCurrency = c.key } }
        } label: {
            chipBody {
                Text(sync.currencySymbol(taskCurrency)).font(.system(size: 13))
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(WF.ink3)
            }
        }
    }

    private var listPicker: some View {
        Menu {
            ForEach(lists) { l in Button("\(l.emoji ?? "📝") \(l.name)") { editListName = l.name } }
        } label: {
            HStack {
                Text(editListName.isEmpty ? "Choose a list" : editListName)
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(editListName.isEmpty ? WF.ink3 : WF.ink).lineLimit(1)
                Spacer()
                Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
            }
            .padding(.horizontal, 12).padding(.vertical, 11).innerInput()
        }
    }

    private var typeSwitcher: some View {
        ChipFlow(spacing: 8, lineSpacing: 8) {
            ForEach(Self.kinds, id: \.key) { k in
                let on = editKind == k.key
                Button { editKind = k.key } label: {
                    HStack(spacing: 5) {
                        Text(k.icon).font(.system(size: 13))
                        Text(k.label).font(.system(size: 13, weight: .semibold)).foregroundStyle(on ? WF.ai : WF.ink2)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(on ? WF.ai.opacity(0.1) : WF.card)
                    .overlay(Capsule().strokeBorder(on ? WF.ai : WF.hair, lineWidth: on ? 1.5 : 1)).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func chipBody<V: View>(@ViewBuilder _ content: () -> V) -> some View {
        HStack(spacing: 6) { content() }
            .padding(.leading, 10).padding(.trailing, 12).padding(.vertical, 7)
            .background(WF.card2).overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1)).clipShape(Capsule())
    }

    private var namePlaceholder: String {
        switch editKind {
        case "event": return "Event title"
        case "task": return "Chore title"
        case "meal": return "Meal"
        default: return "Item"
        }
    }
    private var rewardLabel: String { sync.currencies.first { $0.key == taskCurrency }?.label ?? "Stars" }
    private var addLabel: String {
        switch editKind {
        case "event": return "Add event"
        case "task": return "Add task"
        case "grocery": return "Add to groceries"
        case "list": return "Add to list"
        case "meal": return "Add meal"
        default: return "Add"
        }
    }
    private var canCommit: Bool {
        !editName.trimmingCharacters(in: .whitespaces).isEmpty && (editKind != "list" || !editListName.trimmingCharacters(in: .whitespaces).isEmpty)
    }
    private var viaLabel: String {
        switch via {
        case "anthropic": return "via Claude"
        case "openai": return "via OpenAI"
        case "ollama": return "via local LLM"
        case "on-device": return "on device"   // the offline heuristic fallback
        default: return ""
        }
    }

    // MARK: actions
    private func parse() {
        dictation.stop()
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        focused = false; error = nil; serverAlt = nil

        // 1) Instant on-device guess — shown immediately, so you can add it before the
        //    LLM even responds.
        var cal = Calendar(identifier: .gregorian); cal.timeZone = sync.householdTz
        let local = CaptureHeuristic.parse(t, persons: sync.members.map(\.name), now: Date(), cal: cal, lists: lists.map(\.name))
        let localConfident = local != nil && CaptureHeuristic.looksConfident(local, text: t)
        if let local, localConfident { accept(local, via: "on-device", autoCommit: false) }
        else { phase = .parsing }
        thinking = true

        // 2) Upgrade with the configured LLM in the background.
        Task {
            let r = try? await sync.resolveCapture(t)
            // Bail if the user changed the text meanwhile, or opened the editor (don't
            // clobber their edits).
            guard text.trimmingCharacters(in: .whitespacesAndNewlines) == t, !editing else { thinking = false; return }
            thinking = false
            if let r, let si = r.intent, !r.fallback {
                if localConfident, let local, kindOf(si) != kindOf(local) {
                    serverAlt = si; serverAltVia = r.via          // disagree on kind → keep ours, offer theirs
                } else {
                    // Agree (or local weak) → take the LLM's read, but backfill a
                    // recurrence the (deterministic) heuristic found if the LLM dropped it.
                    accept(mergeRecurrence(llm: si, local: local), via: r.via, autoCommit: false)
                }
            } else if !localConfident {
                // LLM unavailable AND no confident on-device guess.
                if let local { accept(local, via: "on-device", autoCommit: false) }
                else { error = "Couldn’t understand that — try rephrasing."; phase = .input }
            }
            if DemoHooks.captureCommit { commit() }
        }
    }

    private func accept(_ i: CaptureIntent, via v: String, autoCommit: Bool = true) {
        intent = i; via = v; phase = .preview
        populate(i)
        if autoCommit, DemoHooks.captureCommit { commit() }
    }

    /// Keep the heuristic's recurrence when the LLM agreed it's an event but returned a
    /// one-off (small local models often miss "every Thursday"). The LLM still wins on
    /// title / person / time.
    private func mergeRecurrence(llm: CaptureIntent, local: CaptureIntent?) -> CaptureIntent {
        guard case let .event(t, s, a, p, llmRrule, sl, w) = llm, llmRrule == nil,
              case let .event(_, _, _, _, localRrule?, localSL, _) = local else { return llm }
        return .event(title: t, startsAt: s, allDay: a, personName: p,
                      rrule: localRrule, scheduleLabel: localSL.isEmpty ? sl : localSL, whenLabel: w)
    }

    private func kindOf(_ i: CaptureIntent) -> String {
        switch i {
        case .event: return "event"; case .grocery: return "grocery"; case .task: return "task"
        case .meal: return "meal"; case .list: return "list"
        }
    }

    /// Swap the shown intent for the other parse (LLM ↔ on-device), keeping the previous
    /// one offered so it's a one-tap toggle.
    private func switchToAlt() {
        guard let alt = serverAlt else { return }
        let prev = intent, prevVia = via
        accept(alt, via: serverAltVia, autoCommit: false)
        if let prev { serverAlt = prev; serverAltVia = prevVia } else { serverAlt = nil }
    }

    /// Seed the inline-editable fields from the parsed intent. `editKind` drives which
    /// card is shown; the user can re-classify it and the other fields carry over.
    private func populate(_ i: CaptureIntent) {
        editing = false   // always land on the confident glance first
        let iso = ISO8601DateFormatter()
        let isoFrac = ISO8601DateFormatter(); isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        func date(_ s: String?) -> Date? {
            guard let s else { return nil }
            return iso.date(from: s) ?? isoFrac.date(from: s)
        }
        switch i {
        case let .event(title, startsAt, allDay, personName, rrule, _, _):
            editKind = "event"; editName = title; evAllDay = allDay; evPerson = personName
            evDate = date(startsAt) ?? Date()
            evRepeat = Recurrence.parseRepeat(rrule)
            evUntilOn = false
        case let .grocery(name, quantity):
            editKind = "grocery"; editName = name; editQty = quantity ?? ""
        case let .task(title, personName, stars, rrule, _):
            editKind = "task"; editName = title; evPerson = personName
            taskStars = stars ?? 0; taskRrule = rrule
        case let .meal(title, d, mealType, _):
            editKind = "meal"; editName = title; mealSlot = mealType
            mealDate = date(d) ?? Date()
        case let .list(itemName, listName, quantity):
            editKind = "list"; editName = itemName; editQty = quantity ?? ""
            editListName = listName ?? (lists.first { $0.listType.lowercased() != "grocery" }?.name ?? "")
        }
    }

    private func commit() {
        error = nil; phase = .committing
        let name = editName.trimmingCharacters(in: .whitespacesAndNewlines)
        let qty = editQty.trimmingCharacters(in: .whitespaces).isEmpty ? nil : editQty.trimmingCharacters(in: .whitespaces)
        Task {
            let ok: Bool
            switch editKind {
            case "event":
                let cal = Calendar.current
                let start = evAllDay ? (cal.date(bySettingHour: 12, minute: 0, second: 0, of: evDate) ?? evDate) : evDate
                let rrule = Recurrence.buildRrule(evRepeat, start: start)
                var endAt: String?
                if rrule != nil, evUntilOn {
                    let eod = cal.date(bySettingHour: 23, minute: 59, second: 0, of: evUntil) ?? evUntil
                    endAt = ISO8601DateFormatter().string(from: eod)
                }
                ok = await sync.commitEvent(title: name, startsAtISO: ISO8601DateFormatter().string(from: start),
                                            allDay: evAllDay, personName: evPerson, rrule: rrule, recurrenceEndAt: endAt)
            case "grocery":
                ok = await sync.commitGrocery(name: name, quantity: qty)
            case "task":
                ok = await sync.commitTask(title: name, personName: evPerson,
                                           stars: taskStars > 0 ? taskStars : nil,
                                           rewardCurrency: taskCurrency, rrule: taskRrule)
            case "meal":
                let d = ISO8601DateFormatter().string(from: mealDate)
                ok = await sync.commitMeal(title: name, date: d, mealType: mealSlot)
            case "list":
                ok = await sync.commitListItem(item: name, listName: editListName, quantity: qty)
            default:
                ok = false
            }
            if ok {
                dismiss()
            } else {
                error = sync.lastError ?? "Couldn't add that."; phase = .preview
            }
        }
    }
}

private extension View {
    /// The white inner-field treatment used inside the "Waffled understood" card.
    func innerInput() -> some View { wfField(fill: WF.card2) }
}

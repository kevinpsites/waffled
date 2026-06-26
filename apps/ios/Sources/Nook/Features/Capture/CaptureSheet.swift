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
    @State private var error: String?
    @State private var dictation = Dictation()
    // Inline-editable fields for the "Nook understood" card (populated per intent).
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
    @State private var lists: [NookAPI.ListSummary] = []   // for the list picker
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
                Text(error).font(.system(size: 13)).foregroundStyle(NK.primaryD)
            }
            switch phase {
            case .input, .parsing: inputView
            case .preview, .committing: previewView
            }
            Spacer(minLength: 0)
        }
        .padding(20)
        .background(NK.canvas)
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
            let fetchedLists = (try? await NookAPI().listSummaries()) ?? []
            _ = await (warm, currencies)
            lists = fetchedLists
        }
        .onDisappear { dictation.stop() }
    }

    // MARK: header
    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkles").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ai)
            Text("Add with AI").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ai)
            Spacer()
            Button("Cancel") { dismiss() }
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink2)
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
                    .background(NK.panel)
                    .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))

                Button { dictation.toggle() } label: {
                    Image(systemName: dictation.isListening ? "mic.fill" : "mic")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(dictation.isListening ? .white : NK.ink2)
                        .frame(width: 34, height: 34)
                        .background(dictation.isListening ? NK.primary : NK.card)
                        .clipShape(Circle())
                        .overlay(Circle().strokeBorder(dictation.isListening ? Color.clear : NK.hair, lineWidth: 1))
                }
                .buttonStyle(.plain).padding(10)
            }
            .onChange(of: dictation.transcript) { _, t in if !t.isEmpty { text = t } }

            NookPrimaryCTA(
                label: phase == .parsing ? "Thinking…" : "Tell Nook",
                tint: NK.ai,
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
            HStack(spacing: 10) {
                Button { withAnimation(.snappy(duration: 0.22)) { editing = true } } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "slider.horizontal.3").font(.system(size: 13, weight: .semibold))
                        Text("Edit").font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundStyle(NK.ink)
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
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
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                commitButton
            }
            .buttonStyle(.plain)
        }
    }

    private var commitButton: some View {
        NookPrimaryCTA(
            label: addLabel,
            tint: NK.primary,
            isBusy: phase == .committing,
            isDisabled: !canCommit,
            action: commit
        )
    }

    // The confident summary line — icon, kind, what Nook heard, and who it's for.
    private var glanceCard: some View {
        HStack(spacing: 12) {
            NookEmojiTile(emoji: Self.kinds.first { $0.key == editKind }?.icon ?? "✨")
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(editKind.uppercased()).font(.system(size: 11, weight: .heavy)).tracking(0.4).foregroundStyle(NK.ai)
                    if !viaLabel.isEmpty { Text(viaLabel).font(.system(size: 11, weight: .semibold)).foregroundStyle(NK.ink3) }
                }
                Text(editName.isEmpty ? namePlaceholder : editName)
                    .font(.system(size: 17, weight: .bold)).foregroundStyle(NK.ink)
                if !glanceDetail.isEmpty {
                    Text(glanceDetail).font(.system(size: 12.5)).foregroundStyle(NK.ink2)
                }
            }
            Spacer(minLength: 0)
            if let m = sync.member(named: evPerson) {
                Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 32)
            }
        }
        .padding(14)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    /// The one-line subtitle under the glance title, per kind.
    private var glanceDetail: String {
        switch editKind {
        case "event":
            let pattern = evAllDay ? "EEE, MMM d" : "EEE, MMM d · h:mm a"
            return DateFmt.string(evDate, pattern, sync.householdTz) + (evAllDay ? " · all day" : "")
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
                NookEmojiTile(emoji: Self.kinds.first { $0.key == editKind }?.icon ?? "✨")
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Text(editKind.uppercased()).font(.system(size: 11, weight: .heavy)).tracking(0.4).foregroundStyle(NK.ai)
                        if !viaLabel.isEmpty { Text(viaLabel).font(.system(size: 11, weight: .semibold)).foregroundStyle(NK.ink3) }
                        Spacer()
                    }
                    TextField(namePlaceholder, text: $editName)
                        .font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink)
                        .padding(.horizontal, 12).padding(.vertical, 10).innerInput()
                    kindFields
                }
            }
        }
        .padding(14)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
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
                Text(rewardLabel).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink2)
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
                        Text(m.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(on ? NK.ai : NK.ink)
                    }
                    .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 6)
                    .background(on ? NK.ai.opacity(0.1) : NK.card2)
                    .overlay(Capsule().strokeBorder(on ? NK.ai : NK.hair, lineWidth: on ? 1.5 : 1)).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func selectChip(_ label: String, on: Bool, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            Text(label).font(.system(size: 13, weight: .semibold)).foregroundStyle(on ? NK.ai : NK.ink)
                .lineLimit(1).fixedSize()
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(on ? NK.ai.opacity(0.1) : NK.card2)
                .overlay(Capsule().strokeBorder(on ? NK.ai : NK.hair, lineWidth: on ? 1.5 : 1)).clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func toggleChip(_ label: String, on: Bool, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            HStack(spacing: 5) {
                Image(systemName: on ? "checkmark.square.fill" : "square").font(.system(size: 13)).foregroundStyle(on ? NK.ai : NK.ink3)
                Text(label).font(.system(size: 13, weight: .semibold)).foregroundStyle(on ? NK.ai : NK.ink2)
            }
            .padding(.horizontal, 11).padding(.vertical, 7)
            .background(on ? NK.ai.opacity(0.1) : NK.card2)
            .overlay(Capsule().strokeBorder(on ? NK.ai : NK.hair, lineWidth: on ? 1.5 : 1)).clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: event recurrence (capture parity with the web — Repeats + Until)

    /// A compact repeat picker for a captured event: a frequency menu (seeded by the
    /// AI's parse) plus an optional "ends on a date". Builds an RRULE on commit; the
    /// full per-occurrence editing lives in the calendar editor.
    @ViewBuilder private var eventRepeatFields: some View {
        HStack(spacing: 8) {
            Text("Repeats").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink2)
            Menu {
                Button("Does not repeat") { evRepeat = .none }
                Button("Daily") { evRepeat = { var s = RepeatState.none; s.freq = .daily; return s }() }
                Button("Weekdays") { evRepeat = { var s = RepeatState.none; s.freq = .weekdays; return s }() }
                Button("Weekly") { evRepeat.freq = .weekly }   // keeps any AI-parsed day
                Button("Monthly") { evRepeat = { var s = RepeatState.none; s.freq = .monthly; return s }() }
                Button("Yearly") { evRepeat = { var s = RepeatState.none; s.freq = .custom; s.unit = .year; return s }() }
            } label: {
                HStack(spacing: 5) {
                    Text(captureRepeatLabel).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink)
                    Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(NK.ink3)
                }
                .padding(.horizontal, 11).padding(.vertical, 7)
                .background(NK.card2).overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1)).clipShape(Capsule())
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
                Image(systemName: "minus.circle.fill").font(.system(size: 22)).foregroundStyle(value.wrappedValue > 0 ? NK.ink2 : NK.hair)
            }.buttonStyle(.plain)
            Text("\(value.wrappedValue)").font(.system(size: 16, weight: .heavy)).foregroundStyle(NK.ink).frame(minWidth: 18)
            Button { value.wrappedValue += 1 } label: {
                Image(systemName: "plus.circle.fill").font(.system(size: 22)).foregroundStyle(NK.primary)
            }.buttonStyle(.plain)
        }
    }

    private var currencyMenu: some View {
        Menu {
            ForEach(sync.currencies) { c in Button("\(c.symbol) \(c.label)") { taskCurrency = c.key } }
        } label: {
            chipBody {
                Text(sync.currencySymbol(taskCurrency)).font(.system(size: 13))
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(NK.ink3)
            }
        }
    }

    private var listPicker: some View {
        Menu {
            ForEach(lists) { l in Button("\(l.emoji ?? "📝") \(l.name)") { editListName = l.name } }
        } label: {
            HStack {
                Text(editListName.isEmpty ? "Choose a list" : editListName)
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(editListName.isEmpty ? NK.ink3 : NK.ink).lineLimit(1)
                Spacer()
                Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
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
                        Text(k.label).font(.system(size: 13, weight: .semibold)).foregroundStyle(on ? NK.ai : NK.ink2)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(on ? NK.ai.opacity(0.1) : NK.card)
                    .overlay(Capsule().strokeBorder(on ? NK.ai : NK.hair, lineWidth: on ? 1.5 : 1)).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func chipBody<V: View>(@ViewBuilder _ content: () -> V) -> some View {
        HStack(spacing: 6) { content() }
            .padding(.leading, 10).padding(.trailing, 12).padding(.vertical, 7)
            .background(NK.card2).overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1)).clipShape(Capsule())
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
        default: return ""
        }
    }

    // MARK: actions
    private func parse() {
        dictation.stop()
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        focused = false; error = nil; phase = .parsing
        Task {
            do {
                let r = try await sync.resolveCapture(t)
                if let i = r.intent, !r.fallback { accept(i, via: r.via); return }
            } catch {
                // offline / server error → fall through to the on-device heuristic
            }
            localFallback(t)
        }
    }

    private func accept(_ i: CaptureIntent, via v: String) {
        intent = i; via = v; phase = .preview
        populate(i)
        if DemoHooks.captureCommit { commit() }
    }

    /// On-device heuristic — runs when the LLM can't (offline, no provider, or it defers).
    /// So the capture bar still works, just without the AI smarts.
    private func localFallback(_ t: String) {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = sync.householdTz
        let names = sync.members.map(\.name)
        if let i = CaptureHeuristic.parse(t, persons: names, now: Date(), cal: cal, lists: lists.map(\.name)) {
            accept(i, via: "on-device")
        } else {
            error = "Couldn’t understand that — try rephrasing."; phase = .input
        }
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
    /// The white inner-field treatment used inside the "Nook understood" card.
    func innerInput() -> some View { nkField(fill: NK.card2) }
}

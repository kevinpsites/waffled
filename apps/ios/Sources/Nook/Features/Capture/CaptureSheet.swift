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
    // Inline-editable fields for a parsed event (the "Nook understood" card).
    @State private var evTitle = ""
    @State private var evDate = Date()
    @State private var evAllDay = false
    @State private var evPerson: String?
    @FocusState private var focused: Bool

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
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
            await sync.warmCapture()
            if let demo = DemoHooks.captureText {   // headless demo driver (no-op unless set)
                text = demo
                parse()
            } else if autoDictate {
                dictation.toggle()
            } else {
                focused = true
            }
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

            Button(action: parse) {
                HStack {
                    if phase == .parsing { ProgressView().tint(.white) }
                    Text(phase == .parsing ? "Understanding…" : "Understand")
                        .font(.system(size: 16, weight: .semibold))
                }
                .frame(maxWidth: .infinity).padding(.vertical, 13)
                .background(canParse ? NK.ai : NK.ink3).foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!canParse || phase == .parsing)
        }
    }

    private var canParse: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: preview ("Nook understood")
    @ViewBuilder private var previewView: some View {
        if let intent {
            let s = CaptureSummary(intent)
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: "sparkles").font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ai)
                    Text("Nook understood").font(.system(size: 13, weight: .heavy)).tracking(0.5).foregroundStyle(NK.ai)
                    Spacer()
                    if !viaLabel.isEmpty {
                        Text(viaLabel).font(.system(size: 11, weight: .semibold)).foregroundStyle(NK.ink3)
                    }
                }

                if case .event = intent {
                    eventEditorCard
                } else {
                    NookCard {
                        HStack(spacing: 12) {
                            Text(s.icon).font(.system(size: 22))
                                .frame(width: 42, height: 42).background(NK.panel)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.kind.uppercased()).font(.system(size: 11, weight: .heavy)).tracking(0.4)
                                    .foregroundStyle(NK.ink3)
                                Text(s.primary).font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink)
                                if !s.detail.isEmpty {
                                    Text(s.detail).font(.system(size: 12.5)).foregroundStyle(NK.ink2)
                                }
                            }
                            Spacer(minLength: 0)
                            if let m = personFor(intent) {
                                Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 32)
                            }
                        }
                    }
                }

                HStack(spacing: 10) {
                    Button("Edit text") { phase = .input; focused = true }
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                        .frame(maxWidth: .infinity).padding(.vertical, 13)
                        .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    Button(action: commit) {
                        HStack {
                            if phase == .committing { ProgressView().tint(.white) }
                            Text(addLabel).font(.system(size: 15, weight: .semibold))
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 13)
                        .background(NK.primary).foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    }
                    .disabled(phase == .committing)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: inline event editor (the "Nook understood" card for events)

    private var eventEditorCard: some View {
        let member = evPerson.flatMap { sync.member(named: $0) }
        let color = Color(hexString: member?.colorHex) ?? FamilyColor.lottie.solid
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 11) {
                RoundedRectangle(cornerRadius: 99).fill(color).frame(width: 4, height: 40)
                VStack(alignment: .leading, spacing: 3) {
                    TextField("Event title", text: $evTitle)
                        .font(.system(size: 17, weight: .bold)).foregroundStyle(NK.ink)
                    Text(whenSubtitle).font(.system(size: 12.5)).foregroundStyle(NK.ink2)
                }
                Spacer(minLength: 0)
                if let m = member { Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 32) }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    whoChip(member)
                    DatePicker("", selection: $evDate, displayedComponents: .date).labelsHidden()
                    if !evAllDay {
                        DatePicker("", selection: $evDate, displayedComponents: .hourAndMinute).labelsHidden()
                    }
                    Button { evAllDay.toggle() } label: {
                        chipBody {
                            Image(systemName: evAllDay ? "checkmark.square.fill" : "square")
                                .font(.system(size: 13)).foregroundStyle(evAllDay ? NK.primary : NK.ink3)
                            Text("All day").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink2)
                        }
                    }
                    .buttonStyle(.plain)
                }
                .padding(.vertical, 1)
            }
        }
        .padding(14)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private func whoChip(_ member: SyncedMember?) -> some View {
        Menu {
            Button("Up for grabs") { evPerson = nil }
            ForEach(sync.members) { m in Button(m.name) { evPerson = m.name } }
        } label: {
            chipBody {
                if let m = member { Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 20) }
                else { Image(systemName: "person").font(.system(size: 12)).foregroundStyle(NK.ink3) }
                Text(member?.name ?? "Anyone").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink)
            }
        }
    }

    private func chipBody<V: View>(@ViewBuilder _ content: () -> V) -> some View {
        HStack(spacing: 6) { content() }
            .padding(.leading, 8).padding(.trailing, 12).padding(.vertical, 6)
            .background(NK.card2).overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1)).clipShape(Capsule())
    }

    private var whenSubtitle: String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US"); f.timeZone = sync.householdTz
        if evAllDay { f.dateFormat = "EEE, MMM d"; return "\(f.string(from: evDate)) · all day" }
        f.dateFormat = "EEE, MMM d · h:mm a"; return f.string(from: evDate)
    }

    private var addLabel: String {
        if case .event = intent { return "Add event" }
        return "Add"
    }

    private var viaLabel: String {
        switch via {
        case "anthropic": return "via Claude"
        case "openai": return "via OpenAI"
        case "ollama": return "via local LLM"
        default: return ""
        }
    }

    private func personFor(_ intent: CaptureIntent) -> SyncedMember? {
        switch intent {
        case let .event(_, _, _, name, _): return sync.member(named: name)
        case let .task(_, name, _, _, _): return sync.member(named: name)
        default: return nil
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
                if let i = r.intent, !r.fallback {
                    intent = i; via = r.via; phase = .preview
                    if case let .event(title, startsAt, allDay, personName, _) = i {
                        evTitle = title
                        evDate = EventTime.parse(startsAt) ?? Date()
                        evAllDay = allDay
                        evPerson = personName
                    }
                    if DemoHooks.captureCommit { commit() }
                } else {
                    error = "Couldn't understand that — try rephrasing."; phase = .input
                }
            } catch {
                self.error = "Parsing failed (offline or server error)."; phase = .input
            }
        }
    }

    private func commit() {
        guard let intent else { return }
        error = nil; phase = .committing
        Task {
            let ok: Bool
            switch intent {
            case .event:
                // Use the inline-edited fields (who / when / title / all-day).
                let cal = Calendar.current
                let start = evAllDay ? (cal.date(bySettingHour: 12, minute: 0, second: 0, of: evDate) ?? evDate) : evDate
                let iso = ISO8601DateFormatter().string(from: start)
                ok = await sync.commitEvent(title: evTitle.trimmingCharacters(in: .whitespacesAndNewlines),
                                            startsAtISO: iso, allDay: evAllDay, personName: evPerson)
            case let .grocery(name, quantity):
                ok = await sync.commitGrocery(name: name, quantity: quantity)
            case let .task(title, personName, stars, rrule, _):
                ok = await sync.commitTask(title: title, personName: personName, stars: stars, rrule: rrule)
            case let .meal(title, date, mealType, _):
                ok = await sync.commitMeal(title: title, date: date, mealType: mealType)
            case let .list(itemName, listName, quantity):
                ok = await sync.commitListItem(item: itemName, listName: listName, quantity: quantity)
            }
            if ok {
                dismiss()
            } else {
                error = sync.lastError ?? "Couldn't add that."; phase = .preview
            }
        }
    }
}

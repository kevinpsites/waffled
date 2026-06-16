import SwiftUI

/// "Add anything" — type free text, the server's pluggable LLM parses it, you
/// confirm the preview, and it commits. Mirrors the handoff `ios-add.png`.
///
/// Events are written to the local mirror and routed/pushed to Google server-side
/// (see SyncManager.commitEvent). Grocery/task/meal commits land next.
struct CaptureSheet: View {
    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var phase: Phase = .input
    @State private var intent: CaptureIntent?
    @State private var via = ""
    @State private var error: String?
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
            } else {
                focused = true
            }
        }
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
            TextField("Soccer practice Tuesday at 4pm for Wally…", text: $text, axis: .vertical)
                .font(.system(size: 17, weight: .semibold))
                .lineLimit(3...8)
                .focused($focused)
                .submitLabel(.go)
                .onSubmit(parse)
                .padding(16)
                .background(NK.panel)
                .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))

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

                HStack(spacing: 10) {
                    Button("Edit") { phase = .input; focused = true }
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
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        focused = false; error = nil; phase = .parsing
        Task {
            do {
                let r = try await sync.resolveCapture(t)
                if let i = r.intent, !r.fallback {
                    intent = i; via = r.via; phase = .preview
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
            case let .event(title, startsAt, allDay, personName, _):
                ok = await sync.commitEvent(title: title, startsAtISO: startsAt, allDay: allDay, personName: personName)
            case let .grocery(name, quantity):
                ok = await sync.commitGrocery(name: name, quantity: quantity)
            case let .task(title, personName, stars, rrule, _):
                ok = await sync.commitTask(title: title, personName: personName, stars: stars, rrule: rrule)
            case let .meal(title, date, mealType, _):
                ok = await sync.commitMeal(title: title, date: date, mealType: mealType)
            }
            if ok {
                dismiss()
            } else {
                error = sync.lastError ?? "Couldn't add that."; phase = .preview
            }
        }
    }
}

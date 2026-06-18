import SwiftUI

/// The AI "Plan my week ✨" flow. A short config (who you're cooking for, anything
/// to keep in mind, ingredients to use up) → `POST /api/meals/plan-week` → a review
/// of the per-night suggestion cards you accept or skip. Nothing is saved until you
/// tap Add; each accepted card is applied via `SyncManager.setMealPlan`.
struct PlanWeekSheet: View {
    let start: String
    let weekLabel: String
    let defaultCookingFor: Int
    /// Called after suggestions are applied, so the planner reloads.
    let onApplied: () -> Void

    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    private enum Phase { case config, loading, review, empty, failed }
    @State private var phase: Phase = .config
    @State private var cookingFor: Int
    @State private var keepInMind = ""
    @State private var useUpText = ""
    @State private var suggestions: [NookAPI.PlanCardDTO] = []
    @State private var accepted: Set<String> = []
    @State private var via: String?
    @State private var errorMessage: String?
    @State private var applying = false

    private let api = NookAPI()

    init(start: String, weekLabel: String, defaultCookingFor: Int, onApplied: @escaping () -> Void) {
        self.start = start
        self.weekLabel = weekLabel
        self.defaultCookingFor = defaultCookingFor
        self.onApplied = onApplied
        _cookingFor = State(initialValue: max(1, defaultCookingFor))
    }

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .config: configView
                case .loading: loadingView
                case .review: reviewView
                case .empty: messageView("🎉", "Every night this week is already planned.", "Nothing to suggest — you’re all set.")
                case .failed: messageView("😕", "Couldn’t plan the week", errorMessage ?? "The AI provider didn’t respond. Try again.")
                }
            }
            .background(NK.canvas)
            .navigationTitle("Plan my week").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    // MARK: config

    private var configView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 10) {
                    Text("✨").font(.system(size: 26))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Fill the empty nights").font(.system(size: 17, weight: .bold)).foregroundStyle(NK.ink)
                        Text(weekLabel).font(.system(size: 13)).foregroundStyle(NK.ink3)
                    }
                }

                VStack(alignment: .leading, spacing: 9) {
                    SectionLabel(text: "Cooking for")
                    HStack(spacing: 14) {
                        Button { cookingFor = max(1, cookingFor - 1) } label: { stepGlyph("minus") }
                        Text("\(cookingFor)").font(.system(size: 18, weight: .bold)).foregroundStyle(NK.ink).frame(minWidth: 26)
                        Button { cookingFor = min(20, cookingFor + 1) } label: { stepGlyph("plus") }
                        Text(cookingFor == 1 ? "person" : "people").font(.system(size: 13)).foregroundStyle(NK.ink3)
                    }
                }

                field("Keep in mind", "busy week · quick meals · no repeats…", text: $keepInMind)
                field("Use up (optional)", "chicken in freezer, zucchini…", text: $useUpText)
                Text("Comma-separated ingredients you’d like featured.")
                    .font(.system(size: 12)).foregroundStyle(NK.ink3)

                Button { Task { await suggest() } } label: {
                    Text("✨ Suggest meals").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(NK.ai).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                }
                .buttonStyle(.plain).padding(.top, 4)
            }
            .padding(20)
        }
    }

    private func field(_ label: String, _ placeholder: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            SectionLabel(text: label)
            TextField(placeholder, text: text, axis: .vertical)
                .font(.system(size: 15)).lineLimit(1...3)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        }
    }

    private func stepGlyph(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink)
            .frame(width: 34, height: 34).background(NK.panel).clipShape(Circle())
    }

    // MARK: loading

    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView().controlSize(.large).tint(NK.ai)
            Text("Drafting your week…").font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink)
            Text("Asking the kitchen AI — this can take a moment on a local model.")
                .font(.system(size: 13)).foregroundStyle(NK.ink3).multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func messageView(_ emoji: String, _ title: String, _ subtitle: String) -> some View {
        VStack(spacing: 12) {
            Text(emoji).font(.system(size: 44))
            Text(title).font(.system(size: 18, weight: .bold)).foregroundStyle(NK.ink)
            Text(subtitle).font(.system(size: 14)).foregroundStyle(NK.ink3)
                .multilineTextAlignment(.center).padding(.horizontal, 40)
            if phase == .failed {
                Button { phase = .config } label: {
                    Text("Try again").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ai)
                }
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: review

    private var reviewView: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 10) {
                    HStack {
                        Text("\(accepted.count) of \(suggestions.count) selected")
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
                        Spacer()
                        Button(accepted.count == suggestions.count ? "Clear all" : "Select all") {
                            accepted = accepted.count == suggestions.count ? [] : Set(suggestions.map(\.id))
                        }
                        .font(.system(size: 13, weight: .semibold)).tint(NK.ai)
                    }
                    if let via { Text("via \(viaLabel(via))").font(.system(size: 11, weight: .semibold)).foregroundStyle(NK.ai)
                        .frame(maxWidth: .infinity, alignment: .leading) }
                    ForEach(suggestions) { card in suggestionCard(card) }
                }
                .padding(16)
            }
            applyBar
        }
    }

    private func suggestionCard(_ card: NookAPI.PlanCardDTO) -> some View {
        let on = accepted.contains(card.id)
        return Button {
            if on { accepted.remove(card.id) } else { accepted.insert(card.id) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20)).foregroundStyle(on ? NK.ai : NK.ink3)
                Text(card.emoji ?? "🍽️").font(.system(size: 26))
                    .frame(width: 46, height: 46).background(RecipeGradient.forCategory(card.mealType))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(weekday(card.date)).font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(NK.ink3)
                    Text(card.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                        .lineLimit(2).multilineTextAlignment(.leading)
                    HStack(spacing: 8) {
                        if let m = card.minutes { tag("🕐 \(m)m") }
                        tag(card.recipeId != nil ? "📖 From library" : "✨ New dish")
                    }
                    if let note = card.note, !note.isEmpty {
                        Text(note).font(.system(size: 12)).foregroundStyle(NK.ink3).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(13)
            .background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
                .strokeBorder(on ? NK.ai.opacity(0.4) : NK.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func tag(_ t: String) -> some View {
        Text(t).font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink2)
            .padding(.horizontal, 7).padding(.vertical, 2).background(NK.panel).clipShape(Capsule())
    }

    private var applyBar: some View {
        VStack(spacing: 0) {
            Divider().background(NK.hair)
            Button { Task { await apply() } } label: {
                HStack(spacing: 8) {
                    if applying { ProgressView().controlSize(.small).tint(.white) }
                    Text(applying ? "Adding…" : "Add \(accepted.count) to the week")
                        .font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 14)
                .background(accepted.isEmpty ? NK.ink3 : NK.ai)
                .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            }
            .buttonStyle(.plain).disabled(accepted.isEmpty || applying)
            .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .background(NK.canvas)
    }

    // MARK: actions

    private func suggest() async {
        phase = .loading
        let useUp = useUpText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        do {
            let result = try await api.planWeek(start: start, cookingFor: cookingFor,
                                                keepInMind: keepInMind, useUp: Array(useUp.prefix(12)))
            via = result.via
            if let err = result.error, result.suggestions.isEmpty {
                errorMessage = friendly(err); phase = .failed
            } else if result.suggestions.isEmpty {
                phase = .empty
            } else {
                suggestions = result.suggestions
                accepted = Set(result.suggestions.map(\.id))
                phase = .review
            }
        } catch {
            errorMessage = "The AI provider didn’t respond. Check your connection and try again."
            phase = .failed
        }
    }

    private func apply() async {
        applying = true
        for card in suggestions where accepted.contains(card.id) {
            _ = await sync.setMealPlan(date: card.date, mealType: card.mealType,
                                       recipeId: card.recipeId,
                                       title: card.recipeId == nil ? card.title : nil)
        }
        applying = false
        onApplied()
        dismiss()
    }

    // MARK: helpers

    private func friendly(_ err: String) -> String {
        err == "AIUnavailable" || err == "No AI provider configured"
            ? "No AI provider is set up. Choose one in Settings → AI & capture."
            : err
    }
    private func viaLabel(_ v: String) -> String {
        switch v { case "anthropic": return "Claude"; case "openai": return "OpenAI"
        case "ollama", "local": return "local AI"; default: return v }
    }
    private func weekday(_ ymd: String) -> String {
        let inF = DateFormatter(); inF.dateFormat = "yyyy-MM-dd"; inF.timeZone = sync.householdTz
        guard let d = inF.date(from: ymd) else { return ymd }
        let outF = DateFormatter(); outF.dateFormat = "EEE MMM d"; outF.timeZone = sync.householdTz
        return outF.string(from: d).uppercased()
    }
}

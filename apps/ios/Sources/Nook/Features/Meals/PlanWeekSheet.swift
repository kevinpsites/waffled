import SwiftUI

/// The AI "Plan my week ✨" flow. A short config (who you're cooking for, anything
/// to keep in mind, ingredients to use up) → `POST /api/meals/plan-week` → a review
/// of the per-night suggestion cards you accept or skip. Nothing is saved until you
/// tap Add; each accepted card is applied via `SyncManager.setMealPlan`.
struct PlanWeekSheet: View {
    let start: String
    let weekLabel: String
    /// The seven days of the week being planned (in household order, Sun→Sat).
    let weekDays: [Date]
    /// Household size — labels the "whole family" cooking-for option.
    let familySize: Int
    /// Called after suggestions are applied, so the planner reloads.
    let onApplied: () -> Void

    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    private enum Phase { case config, loading, review, empty, failed }
    private let mealTypes = ["breakfast", "lunch", "dinner"]

    @State private var phase: Phase = .config
    @State private var mealType = "dinner"
    @State private var selectedDays: Set<String> = []   // ymd; seeded Mon–Fri on appear
    @State private var cookingFor = 0                    // 0 ⇒ whole family
    @State private var keepInMind = ""
    @State private var useUp: [String] = []
    @State private var useUpInput = ""
    @State private var suggestions: [NookAPI.PlanCardDTO] = []
    @State private var accepted: Set<String> = []
    @State private var via: String?
    @State private var errorMessage: String?
    @State private var applying = false

    private let api = NookAPI()

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
        .task { seedDaysIfNeeded() }
    }

    /// Default to weekdays (Mon–Fri), matching the web kiosk.
    private func seedDaysIfNeeded() {
        guard selectedDays.isEmpty else { return }
        for d in weekDays where (2...6).contains(cal.component(.weekday, from: d)) {
            selectedDays.insert(ymd(d))
        }
    }

    // MARK: config

    private var configView: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Tell Nook the guardrails — it drafts the meals and the grocery list in one go.")
                        .font(.system(size: 14)).foregroundStyle(NK.ink3)
                        .fixedSize(horizontal: false, vertical: true)

                    // Plan which meal?
                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Plan which meal?")
                        HStack(spacing: 0) {
                            ForEach(mealTypes, id: \.self) { m in
                                Button { mealType = m } label: {
                                    Text(m.capitalized)
                                        .font(.system(size: 14, weight: mealType == m ? .bold : .medium))
                                        .foregroundStyle(mealType == m ? NK.ink : NK.ink3)
                                        .frame(maxWidth: .infinity).padding(.vertical, 9)
                                        .background(
                                            mealType == m
                                                ? AnyView(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous).fill(NK.card)
                                                    .shadow(color: .black.opacity(0.06), radius: 3, y: 1))
                                                : AnyView(Color.clear))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(3).background(NK.panel)
                        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    }

                    // Which days?
                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Which days?")
                        HStack(spacing: 6) {
                            ForEach(weekDays, id: \.self) { d in dayChip(d) }
                        }
                    }

                    // Cooking for
                    NookCard(padding: 14) {
                        HStack {
                            Text("Cooking for").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                            Spacer()
                            Menu {
                                Button { cookingFor = 0 } label: { Text("\(familySize) · whole family") }
                                ForEach(1...8, id: \.self) { n in
                                    Button { cookingFor = n } label: { Text("\(n)") }
                                }
                            } label: {
                                HStack(spacing: 6) {
                                    Text(cookingForLabel).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                                    Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink3)
                                }
                                .padding(.horizontal, 14).padding(.vertical, 9)
                                .background(NK.panel).clipShape(Capsule())
                            }
                        }
                    }

                    // Use up first
                    NookCard(padding: 14) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Use up first").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink)
                            ChipFlow(spacing: 8, lineSpacing: 8) {
                                ForEach(useUp, id: \.self) { u in useUpChip(u) }
                                TextField("+ Add", text: $useUpInput)
                                    .font(.system(size: 14)).textInputAutocapitalization(.never)
                                    .submitLabel(.done).onSubmit { addUseUp() }
                                    .frame(minWidth: 80)
                                    .padding(.horizontal, 12).padding(.vertical, 7)
                                    .background(NK.panel).clipShape(Capsule())
                            }
                        }
                    }

                    // Keep in mind
                    NookCard(padding: 14) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Keep in mind").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink)
                            TextField("e.g. Lottie skips spicy · Tue & Thu are busy — keep under 30 min",
                                      text: $keepInMind, axis: .vertical)
                                .font(.system(size: 14)).lineLimit(2...4)
                                .padding(.horizontal, 12).padding(.vertical, 10)
                                .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
                        }
                    }
                }
                .padding(20)
            }
            suggestBar
        }
    }

    private var suggestBar: some View {
        VStack(spacing: 0) {
            Divider().background(NK.hair)
            Button { Task { await suggest() } } label: {
                Text("✨ Plan my week").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                    .background(selectedDays.isEmpty ? NK.ink3 : NK.ai)
                    .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            }
            .buttonStyle(.plain).disabled(selectedDays.isEmpty)
            .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .background(NK.canvas)
    }

    private func dayChip(_ d: Date) -> some View {
        let key = ymd(d)
        let on = selectedDays.contains(key)
        return Button {
            if on { selectedDays.remove(key) } else { selectedDays.insert(key) }
        } label: {
            VStack(spacing: 2) {
                Text(dowLetter(d)).font(.system(size: 15, weight: .heavy)).foregroundStyle(on ? .white : NK.ink2)
            }
            .frame(maxWidth: .infinity).frame(height: 46)
            .background(on ? NK.primary : NK.card)
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).strokeBorder(on ? .clear : NK.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func useUpChip(_ u: String) -> some View {
        HStack(spacing: 5) {
            Text(u).font(.system(size: 14, weight: .medium)).foregroundStyle(NK.ink)
            Button { useUp.removeAll { $0 == u } } label: {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(NK.ink3)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(NK.panel).clipShape(Capsule())
    }

    private func addUseUp() {
        let v = useUpInput.trimmingCharacters(in: .whitespaces)
        guard !v.isEmpty, !useUp.contains(v), useUp.count < 12 else { useUpInput = ""; return }
        useUp.append(v); useUpInput = ""
    }

    private var cookingForLabel: String {
        cookingFor == 0 ? "\(familySize) · whole family" : "\(cookingFor)"
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
                    Text(applying ? "Adding…" : "Add \(accepted.count) & build list")
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
        addUseUp()   // fold any half-typed entry into the chips
        phase = .loading
        do {
            let result = try await api.planWeek(
                start: start, mealType: mealType, dates: selectedDays.sorted(),
                cookingFor: cookingFor > 0 ? cookingFor : nil,
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
        // "& build list" — rebuild the grocery list from the newly planned week.
        await sync.rebuildGroceryFromWeek(weekStart: start)
        applying = false
        onApplied()
        dismiss()
    }

    // MARK: date helpers

    private var cal: Calendar {
        var c = Calendar(identifier: .gregorian); c.timeZone = sync.householdTz; return c
    }
    private func ymd(_ d: Date) -> String {
        let f = DateFormatter(); f.calendar = cal; f.timeZone = sync.householdTz; f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }
    private func dowLetter(_ d: Date) -> String {
        let f = DateFormatter(); f.calendar = cal; f.timeZone = sync.householdTz; f.dateFormat = "EEEEE"
        return f.string(from: d)   // narrow weekday: S M T W T F S
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

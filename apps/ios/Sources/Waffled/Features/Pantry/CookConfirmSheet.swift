import SwiftUI

/// "Used from your pantry" — shown after marking a recipe cooked, when the server finds
/// on-hand pantry items the recipe likely used. Each row offers three choices, defaulting
/// to the server's suggestion (staples → "Didn't use", countable > 1 → "Used some", else
/// "Used it up"). Only used_up/decrement are sent to /consume; "Didn't use" is dropped.
/// Mirrors the web `CookConfirm`. Matching + suggestions are entirely server-side.
struct CookConfirmSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let matches: [WaffledAPI.RecipeMatch]
    var onApplied: (Int) -> Void = { _ in }

    @State private var choice: [String: String]
    @State private var busy = false

    private static let modes: [(key: String, label: String)] = [
        ("decrement", "Used some"), ("used_up", "Used it up"), ("skip", "Didn’t use"),
    ]

    init(title: String, matches: [WaffledAPI.RecipeMatch], onApplied: @escaping (Int) -> Void = { _ in }) {
        self.title = title
        self.matches = matches
        self.onApplied = onApplied
        _choice = State(initialValue: Dictionary(uniqueKeysWithValues: matches.map { ($0.id, $0.suggested) }))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Update your pantry after cooking \(title).")
                        .font(.system(size: 14)).foregroundStyle(NK.ink3)
                        .padding(.top, 2)
                    ForEach(matches) { row($0) }
                }
                .padding(20).padding(.bottom, 90)
            }
            .background(NK.canvas)
            .safeAreaInset(edge: .bottom) { bar }
            .navigationTitle("Used from your pantry").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Not now") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func row(_ m: WaffledAPI.RecipeMatch) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                Text(m.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                Text(amountLabel(m)).font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                if m.isStaple {
                    Text("· staple").font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
                }
                Spacer(minLength: 0)
            }
            segmented(m.id)
        }
        .padding(12)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private func amountLabel(_ m: WaffledAPI.RecipeMatch) -> String {
        let a = m.amount.trimmingCharacters(in: .whitespaces)
        let u = m.unit.trimmingCharacters(in: .whitespaces)
        if a.isEmpty && u.isEmpty { return "on hand" }
        return [a, u].filter { !$0.isEmpty }.joined(separator: " ")
    }

    private func segmented(_ id: String) -> some View {
        HStack(spacing: 6) {
            ForEach(Self.modes, id: \.key) { mode in
                let on = (choice[id] ?? "skip") == mode.key
                Button { choice[id] = mode.key } label: {
                    Text(mode.label)
                        .font(.system(size: 13, weight: on ? .bold : .semibold))
                        .foregroundStyle(on ? .white : NK.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 8)
                        .background(on ? NK.primary : NK.panel)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }.buttonStyle(.plain)
            }
        }
    }

    private var bar: some View {
        Button { confirm() } label: {
            Text(busy ? "Updating…" : "Update pantry").fontWeight(.bold)
                .font(.system(size: 16)).foregroundStyle(.white)
                .frame(maxWidth: .infinity).padding(.vertical, 15)
                .background(NK.primary)
        }
        .buttonStyle(.plain).disabled(busy)
    }

    private func confirm() {
        let items = matches.compactMap { m -> (id: String, mode: String)? in
            let mode = choice[m.id] ?? m.suggested
            return mode == "skip" ? nil : (id: m.id, mode: mode)
        }
        busy = true
        Task {
            if !items.isEmpty { _ = try? await WaffledAPI().pantryConsume(items) }
            onApplied(items.count)
            dismiss()
        }
    }
}

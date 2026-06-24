import SwiftUI

// Stateless leaf views shared by PlanWeekSheet and PlanMonthSheet. These are pure
// view-layer reuse — no parent state lives here. Keep rendered output pixel-identical
// to the originals (NK.* tokens, font sizes, spacing must match exactly).

/// A small pill button (icon + label) used in a review card's action row.
struct PlanActionChip: View {
    let icon: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 12, weight: .bold))
                Text(label).font(.system(size: 12, weight: .bold)).lineLimit(1).fixedSize()
            }
            .foregroundStyle(NK.ink2)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(NK.panel).clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// A tiny metadata tag chip (e.g. "🕐 30m", "📖 Library").
struct PlanTag: View {
    let text: String

    var body: some View {
        Text(text).font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink2)
            .padding(.horizontal, 7).padding(.vertical, 2).background(NK.panel).clipShape(Capsule()).lineLimit(1)
    }
}

/// The "Use up first" card — a chip flow of ingredients to prioritize, plus an
/// inline add field. The parent owns `items` and `input`; this view is otherwise
/// self-contained (same 12-item cap and chip styling as both plan sheets).
struct UseUpCard: View {
    @Binding var items: [String]
    @Binding var input: String

    var body: some View {
        NookCard(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Use up first").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink)
                ChipFlow(spacing: 8, lineSpacing: 8) {
                    ForEach(items, id: \.self) { u in chip(u) }
                    TextField("+ Add", text: $input)
                        .font(.system(size: 14)).textInputAutocapitalization(.never)
                        .submitLabel(.done).onSubmit { add() }
                        .frame(minWidth: 80)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(NK.panel).clipShape(Capsule())
                }
            }
        }
    }

    private func chip(_ u: String) -> some View {
        HStack(spacing: 5) {
            Text(u).font(.system(size: 14, weight: .medium)).foregroundStyle(NK.ink)
            Button { items.removeAll { $0 == u } } label: {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(NK.ink3)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(NK.panel).clipShape(Capsule())
    }

    private func add() {
        let v = input.trimmingCharacters(in: .whitespaces)
        guard !v.isEmpty, !items.contains(v), items.count < 12 else { input = ""; return }
        items.append(v); input = ""
    }
}

/// The full-screen loading state shown while the AI drafts a plan.
struct PlanLoadingView: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 16) {
            ProgressView().controlSize(.large).tint(NK.ai)
            Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink)
            Text(subtitle)
                .font(.system(size: 13)).foregroundStyle(NK.ink3).multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The full-screen empty/error message. Pass `onRetry` to show a "Try again" button.
struct PlanMessageView: View {
    let emoji: String
    let title: String
    let subtitle: String
    var onRetry: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 12) {
            Text(emoji).font(.system(size: 44))
            Text(title).font(.system(size: 18, weight: .bold)).foregroundStyle(NK.ink)
            Text(subtitle).font(.system(size: 14)).foregroundStyle(NK.ink3)
                .multilineTextAlignment(.center).padding(.horizontal, 40)
            if let onRetry {
                Button(action: onRetry) {
                    Text("Try again").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ai)
                }
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The compact drag preview shown while dragging a review card onto another night.
struct PlanCardDragPreview: View {
    let card: NookAPI.PlanCardDTO

    var body: some View {
        HStack(spacing: 5) {
            Text(card.emoji ?? "🍽️").font(.system(size: 14))
            Text(card.title).font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(NK.card).clipShape(Capsule()).overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1))
    }
}

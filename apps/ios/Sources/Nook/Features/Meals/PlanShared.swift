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

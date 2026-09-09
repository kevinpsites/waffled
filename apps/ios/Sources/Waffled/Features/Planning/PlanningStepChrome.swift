import SwiftUI

// Chrome shared by the planning steps' pickers.
//
// `wfChip(selected:tint:)` in `DesignSystem/FieldStyles.swift` is the canonical selectable
// treatment, but it clips to a `Capsule` and a focus option here is a three-line row. So
// this is the SAME treatment on a rounded rectangle, in one place rather than in both steps.

extension View {
    /// Selectable-ROW treatment: `wfChip`'s look, squared off for multi-line options.
    func planningOptionChrome(
        selected: Bool,
        tint: Color = WF.primary,
        radius: CGFloat = WF.rMD
    ) -> some View {
        background(selected ? tint.opacity(0.12) : WF.card)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(selected ? tint : WF.hair, lineWidth: selected ? 1.5 : 1)
            )
    }
}

/// The tone of a goal's pace sentence, in WF tokens. `flat` is deliberately NOT a warning
/// colour: "roughly 1 book a month" is a fact about a slow goal, not a complaint.
///
/// Classification is split from the colour so it can be asserted without comparing two
/// `Color`s — the tone arrives as a STRING, and anything unrecognised must read neutral.
enum PlanningPaceTone {
    enum Kind: Hashable {
        case ok
        case behind
        case neutral
    }

    static func kind(_ tone: String) -> Kind {
        switch tone {
        case "ok": return .ok
        case "behind": return .behind
        default: return .neutral
        }
    }

    static func color(_ tone: String) -> Color {
        switch kind(tone) {
        case .ok: return WF.success
        case .behind: return WF.warn
        case .neutral: return WF.ink3
        }
    }
}

import SwiftUI

/// Canonical form/chip chrome, so the boxed-input and selectable-chip looks live in
/// ONE place instead of being re-spelled (background + clipShape + hairline overlay)
/// in every view. Padding and label content stay at the call site; only the shared
/// fill/border/shape treatment is centralized.
extension View {
    /// Boxed field chrome: a fill (card by default) with a hairline border, rounded.
    /// Replaces the per-file `cardField()` / `cardBox()` / `innerField()` / `innerInput()`.
    func nkField(radius: CGFloat = NK.rMD, fill: Color = NK.card) -> some View {
        background(fill)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    /// Selectable-chip treatment: a tinted fill + colored border when selected, a
    /// card fill + hairline when not. The single source for every picker chip
    /// (people, categories, sections, filters). Padding/label stay at the call site.
    func nkChip(selected: Bool, tint: Color = NK.primary) -> some View {
        background(selected ? tint.opacity(0.12) : NK.card)
            .overlay(Capsule().strokeBorder(selected ? tint : NK.hair, lineWidth: selected ? 1.5 : 1))
            .clipShape(Capsule())
    }
}

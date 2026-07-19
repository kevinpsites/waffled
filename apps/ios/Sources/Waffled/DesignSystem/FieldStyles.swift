import SwiftUI

/// Canonical form/chip chrome, so the boxed-input and selectable-chip looks live in
/// ONE place instead of being re-spelled (background + clipShape + hairline overlay)
/// in every view. Padding and label content stay at the call site; only the shared
/// fill/border/shape treatment is centralized.
extension View {
    /// Boxed field chrome: a fill (card by default) with a hairline border, rounded.
    /// Replaces the per-file `cardField()` / `cardBox()` / `innerField()` / `innerInput()`.
    func wfField(radius: CGFloat = WF.rMD, fill: Color = WF.card) -> some View {
        background(fill)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    /// Selectable-chip treatment: a tinted fill + colored border when selected, a
    /// card fill + hairline when not. The single source for every picker chip
    /// (people, categories, sections, filters). Padding/label stay at the call site.
    func wfChip(selected: Bool, tint: Color = WF.primary) -> some View {
        background(selected ? tint.opacity(0.12) : WF.card)
            .overlay(Capsule().strokeBorder(selected ? tint : WF.hair, lineWidth: selected ? 1.5 : 1))
            .clipShape(Capsule())
    }

    /// The keyboard accessory "Done" button (trailing, semibold) — the ONE way we give
    /// a keyboard an explicit dismiss when it otherwise has none (decimal pads have no
    /// return key; rapid-entry bars keep focus after every submit). `dismiss` should
    /// clear the caller's `@FocusState` (which also commits any in-flight inline edit).
    func wfKeyboardDoneToolbar(dismiss: @escaping () -> Void) -> some View {
        toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done", action: dismiss).fontWeight(.semibold)
            }
        }
    }
}

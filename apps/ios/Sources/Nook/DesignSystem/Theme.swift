import SwiftUI

/// Nook design tokens, ported 1:1 from the handoff `nook.css` `:root` variables so
/// the phone speaks the same visual language as the kiosk — "warm-white canvas,
/// color comes from people, AI woven in."
enum NK {

    // MARK: Surfaces
    static let canvas = Color(hex: 0xFAF7F2)   // --bg  warm-white canvas
    static let rail   = Color(hex: 0xF1ECE3)
    static let panel  = Color(hex: 0xF4EFE7)
    static let card   = Color(hex: 0xFFFFFF)
    static let card2  = Color(hex: 0xFCFAF6)

    // MARK: Ink
    static let ink   = Color(hex: 0x1D1D1F)
    static let ink2  = Color(hex: 0x6B6B70)
    static let ink3  = Color(hex: 0xA6A29B)
    static let hair  = Color(hex: 0x282118).opacity(0.08)
    static let hair2 = Color(hex: 0x282118).opacity(0.045)

    // MARK: Brand
    static let primary  = Color(hex: 0xEC6049)   // coral — the capture/primary action
    static let primaryD = Color(hex: 0xD84A33)
    static let ai       = Color(hex: 0x6E56CF)   // AI violet
    static let ai2      = Color(hex: 0x8C74E8)
    static let gold     = Color(hex: 0xF3A93B)   // stars

    // MARK: Radii (--r-*)
    static let rXS: CGFloat = 8
    static let rSM: CGFloat = 12
    static let rMD: CGFloat = 16
    static let rLG: CGFloat = 22
    static let rXL: CGFloat = 30

    // MARK: Type — SF for UI, New York (.serif) for headings, matching --sans/--serif.
    static func serif(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .serif)
    }
}

/// Per-person color. "Color comes from people" — each family member owns a hue
/// (solid) plus a soft tint for fills/backgrounds.
enum FamilyColor: String, CaseIterable {
    case kevin, kelly, wally, lottie

    var solid: Color {
        switch self {
        case .kevin:  return Color(hex: 0x2F7FED)
        case .kelly:  return Color(hex: 0xE0548B)
        case .wally:  return Color(hex: 0x25A368)
        case .lottie: return Color(hex: 0x8A5CF0)
        }
    }

    var tint: Color {
        switch self {
        case .kevin:  return Color(hex: 0xE7F0FE)
        case .kelly:  return Color(hex: 0xFCE9F1)
        case .wally:  return Color(hex: 0xE4F5EC)
        case .lottie: return Color(hex: 0xF0E9FD)
        }
    }
}

// MARK: - Shadows (--sh-1..3)

extension View {
    /// Soft card shadow (--sh-1).
    func nkShadow1() -> some View {
        shadow(color: Color(hex: 0x282118).opacity(0.05), radius: 1.5, x: 0, y: 1)
    }
    /// Raised shadow (--sh-3) — used by the floating capture button.
    func nkShadow3() -> some View {
        shadow(color: Color(hex: 0x282118).opacity(0.12), radius: 18, x: 0, y: 8)
    }
}

// MARK: - Color(hex:)

extension Color {
    /// Build a Color from a 0xRRGGBB literal — keeps the token table readable.
    init(hex: UInt32) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8) & 0xFF) / 255
        let b = Double(hex & 0xFF) / 255
        self.init(.sRGB, red: r, green: g, blue: b, opacity: 1)
    }
}

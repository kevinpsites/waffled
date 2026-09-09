import SwiftUI
import UIKit

/// Waffled design tokens, ported 1:1 from the handoff `waffled.css` `:root` +
/// `[data-theme="dark"]` variables. Every token carries a light and a dark value; UIKit
/// re-resolves each `Color(light:dark:)` on the trait change (see `DARK_MODE.md`).
///
/// A WARM dark, never pure black. Brand, AI and per-person hues stay FIXED with the lights
/// off; only two things change — tints become low-opacity washes, and elevation inverts.
enum WF {

    // MARK: Surfaces — warm whites → warm charcoals; elevation inverts.
    static let canvas = Color(light: 0xFAF7F2, dark: 0x14110C)   // --bg
    static let rail   = Color(light: 0xF1ECE3, dark: 0x1B160F)
    static let panel  = Color(light: 0xF4EFE7, dark: 0x1A1710)
    static let card   = Color(light: 0xFFFFFF, dark: 0x232019)   // raised: lighter than canvas in dark
    static let card2  = Color(light: 0xFCFAF6, dark: 0x1C1811)

    static let ink   = Color(light: 0x1D1D1F, dark: 0xF3EEE4)
    static let ink2  = Color(light: 0x6B6B70, dark: 0xADA69A)
    static let ink3  = Color(light: 0xA6A29B, dark: 0x726B5E)
    /// Foreground for text/icons on a solid `WF.ink` fill. The *inverse* of ink — replaces
    /// a `.white` literal, which would stay white while `ink` flips to near-white in dark.
    /// Aliases `canvas` so the two cannot drift on a repalette.
    static let onInk = canvas

    // The alpha AMOUNT differs by mode for hair (.08 → .10) and hair-2 (.045 → .06), so they
    // can't use the single-opacity init. `line` is .18 in both modes, so the shared init is fine.
    static let hair  = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(white: 1, alpha: 0.10)
        : UIColor(hex: 0x282118, alpha: 0.08) })
    static let hair2 = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(white: 1, alpha: 0.06)
        : UIColor(hex: 0x282118, alpha: 0.045) })
    static let line  = Color(light: 0x282118, dark: 0xFFFFFF).opacity(0.18)

    // MARK: Brand — hues fixed; only the shade retunes for dark.
    static let primary  = Color(hex: 0xEC6049)                    // coral — same both themes
    static let primaryD = Color(light: 0xD84A33, dark: 0xF0745F)
    static let gold     = Color(hex: 0xF3A93B)                    // stars — same both themes
    // AI accent (violet): LIGHTER in light, richer/darker "pop" in dark (matches waffled.css
    // after the late `--ai` swap — do not invert these, see DARK_MODE.md round-3 note).
    static let ai       = Color(light: 0x8C74E8, dark: 0x6E56CF)
    static let ai2      = Color(light: 0xA48CF0, dark: 0x8C74E8)
    static let aiD      = Color(light: 0x6A3FC4, dark: 0xB9A3F5)  // AI text-on-tint (readable both)

    // MARK: Status / semantic — base for text/icons; the `*T` tints below for fills. Light
    // values intentionally equal the former person hues, so there is one source of truth.
    static let success = Color(light: 0x25A368, dark: 0x34B87A)
    static let danger  = Color(light: 0xC0392B, dark: 0xE15B4C)
    static let warn    = Color(light: 0xC77A1A, dark: 0xE8A13E)
    static let info    = Color(light: 0x2F7FED, dark: 0x4C9BFF)

    // MARK: Tints — a pale solid pastel in light; a low-opacity wash of the hue in dark.
    static let primaryT = Color.wash(light: 0xF3E2D8, darkBase: 0xEC6049, darkAlpha: 0.18)
    static let aiT      = Color.wash(light: 0xEFEAFC, darkBase: 0x8C74E8, darkAlpha: 0.20)
    static let successT = Color.wash(light: 0xE4F5EC, darkBase: 0x34B87A, darkAlpha: 0.20)
    static let dangerT  = Color.wash(light: 0xFBE3E1, darkBase: 0xE15B4C, darkAlpha: 0.18)
    static let warnT    = Color.wash(light: 0xFDF2DD, darkBase: 0xE8A13E, darkAlpha: 0.18)
    static let infoT    = Color.wash(light: 0xE7F0FE, darkBase: 0x4C9BFF, darkAlpha: 0.20)

    static let rXS: CGFloat = 8
    static let rSM: CGFloat = 12
    static let rMD: CGFloat = 16
    static let rLG: CGFloat = 22
    static let rXL: CGFloat = 30

    // MARK: Bottom-bar clearance
    /// Room a scrolling screen must leave at the bottom for the phone's tab bar.
    ///
    /// `AppRoot` stacks that bar *over* the content — a bottom-aligned ZStack layer, not a
    /// safe-area inset — so SwiftUI reserves nothing and every scrolling screen has to
    /// leave the space by hand. Forget it and the last row sits under the bar, unreachable.
    static var tabBarClearance: CGFloat { tabBarHeight + scrollBreathingRoom }

    /// The same clearance, but only on the shell that has a bottom bar — the iPad kiosk has
    /// none, so a shared screen should ask for this rather than leave 110pt of dead space.
    static var bottomBarClearance: CGFloat { DeviceExperience.current == .planner ? tabBarClearance : 0 }

    // MARK: …and the two numbers it's built from
    //
    // `tabBarClearance` serves a SCROLLING screen: the bar's height plus room so the last
    // row doesn't hug it. A screen with a FIXED footer wants a different number — flush
    // with the top of the bar. Both derive from what `WaffledTabBar` actually draws, and
    // the bar draws itself from these same two constants, so they cannot drift.

    /// The capture FAB's diameter — the tallest child in the bar, so it sets the height.
    /// Its `-18` offset lifts it visually but does NOT participate in layout.
    static let captureButtonSize: CGFloat = 54
    static let barTopPadding: CGFloat = 10
    /// What the bar occupies in layout: its tallest child plus that padding. The background
    /// bleeds into the bottom safe area, but the CONTENT above it is laid out inside it.
    static var tabBarHeight: CGFloat { captureButtonSize + barTopPadding }
    /// Slack a scrolling screen leaves beyond the bar, keeping `tabBarClearance` at 110.
    static let scrollBreathingRoom: CGFloat = 46

    /// Clearance for a footer PINNED above the tab bar rather than scrolling under it: the
    /// bar's height and not a point more. Zero on the kiosk, which has no bar. Do NOT shave
    /// it below `tabBarHeight` to reclaim space — that puts controls under the bar.
    static var fixedBarClearance: CGFloat { DeviceExperience.current == .planner ? tabBarHeight : 0 }

    // MARK: Type — SF for UI, New York (.serif) for headings, matching --sans/--serif.
    static func serif(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .serif)
    }
}

/// Per-person color: each family member owns a hue slot (solid) plus a soft tint for fills.
/// Named `person1…4` to match the web `--person-1…4` tokens, so the accent palette is
/// decoupled from any demo person's name.
enum FamilyColor: String, CaseIterable {
    case person1, person2, person3, person4

    var solid: Color {
        switch self {
        case .person1: return Color(hex: 0x2F7FED)   // blue
        case .person2: return Color(hex: 0xE0548B)   // pink
        case .person3: return Color(hex: 0x25A368)   // green
        case .person4: return Color(hex: 0x8A5CF0)   // purple
        }
    }

    /// Soft fill — a pale solid pastel in light; the hue at ~20% alpha in dark.
    var tint: Color {
        switch self {
        case .person1: return .wash(light: 0xE7F0FE, darkBase: 0x2F7FED, darkAlpha: 0.20)
        case .person2: return .wash(light: 0xFCE9F1, darkBase: 0xE0548B, darkAlpha: 0.22)
        case .person3: return .wash(light: 0xE4F5EC, darkBase: 0x25A368, darkAlpha: 0.20)
        case .person4: return .wash(light: 0xF0E9FD, darkBase: 0x8A5CF0, darkAlpha: 0.22)
        }
    }
}

// MARK: - Shadows (--sh-1..3) — deepen in dark so raised surfaces still separate.

extension View {
    func wfShadow1() -> some View {
        shadow(color: Color(UIColor { $0.userInterfaceStyle == .dark
            ? UIColor(white: 0, alpha: 0.45)
            : UIColor(hex: 0x282118, alpha: 0.05) }),
            radius: 1.5, x: 0, y: 1)
    }
    /// Raised shadow (--sh-3) — used by the floating capture button.
    func wfShadow3() -> some View {
        shadow(color: Color(UIColor { $0.userInterfaceStyle == .dark
            ? UIColor(white: 0, alpha: 0.60)
            : UIColor(hex: 0x282118, alpha: 0.12) }),
            radius: 18, x: 0, y: 8)
    }
}


extension Color {
    init(hex: UInt32) {
        self = Color(UIColor(hex: hex, alpha: 1))
    }

    /// A Color that resolves per appearance; `light`/`dark` are 0xRRGGBB literals. The
    /// backbone of the dark theme — one line per token, so the table stays 1:1 with web.
    /// (Alpha stays 1; the one token that needs transparency — `line` — applies `.opacity`.)
    init(light: UInt32, dark: UInt32) {
        self = Color(UIColor { tc in
            UIColor(hex: tc.userInterfaceStyle == .dark ? dark : light, alpha: 1)
        })
    }

    /// A theme-aware tint: the pale solid `light` pastel in light mode, a low-opacity wash of
    /// `darkBase` in dark — the "tints become washes" rule.
    static func wash(light: UInt32, darkBase: UInt32, darkAlpha: Double) -> Color {
        Color(UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(hex: darkBase, alpha: darkAlpha)
                : UIColor(hex: light, alpha: 1)
        })
    }

    /// From a "#RRGGBB" string (real `persons.color_hex` data); nil for malformed input.
    init?(hexString: String?) {
        guard var s = hexString else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(hex: v)
    }
}

extension UIColor {
    /// Shared by every WF token so the hex→component math lives in exactly one place.
    convenience init(hex: UInt32, alpha: CGFloat) {
        self.init(
            red:   CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue:  CGFloat(hex & 0xFF) / 255,
            alpha: alpha)
    }
}

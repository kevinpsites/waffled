import SwiftUI
import UIKit

/// Family-aware event coloring + the household's chip style. A hand-mirror of the web
/// `apps/web/src/lib/event-color.ts` + `apps/web/src/lib/display.ts` (and the `.ev-tint`
/// rules in `apps/web/src/styles/waffled.css`), so a household's calendar reads the same
/// on the phone, the wall tablet and the browser.
///
/// The resolution is pure and lives here rather than in the views because *both* device
/// experiences render events — `TodayView`/`CalendarView` on iPhone and
/// `KioskDashboard`/`KioskCalendarView` on iPad — and a rule applied to only one of them
/// is the defect this app keeps shipping.

/// How the calendar paints an event chip. `solid` (full-color blocks — the default, and
/// the most glanceable from across the kitchen) or `tinted` (a soft wash with colored
/// text). Stored in `households.settings.display.eventStyle`.
enum EventStyle: String, Sendable, Equatable, CaseIterable, Identifiable {
    case solid, tinted

    var id: String { rawValue }

    /// The Settings label — matches the web's `<select>` options.
    var label: String { self == .tinted ? "Tinted" : "Solid colors" }

    /// Resolve the stored value; **anything but an explicit `"tinted"` is solid**, so an
    /// unset, typo'd or future value degrades to the default look instead of an empty chip.
    static func resolve(_ raw: String?) -> EventStyle { raw == "tinted" ? .tinted : .solid }
}

/// Everything a view needs to color one event: who's in the household, the whole-family
/// color, and the chip style. Precomputed once per data change on `SyncManager` (see the
/// "precompute in the model" rule in `apps/ios/CLAUDE.md`) so a render is a set lookup.
struct EventPalette: Sendable, Equatable {
    /// Default whole-family color — deliberately not one of the member swatches.
    static let defaultFamilyHex = "#F97316"

    var memberIds: Set<String> = []
    var familyHex: String = EventPalette.defaultFamilyHex
    var style: EventStyle = .solid

    /// A full `#RRGGBB` value, or the default. Mirrors the server's `HEX_COLOR` guard —
    /// the stored setting is free-form jsonb, so a hand-edited household row can't leak a
    /// malformed color into the calendar.
    static func normalizedFamilyHex(_ raw: String?) -> String {
        guard let raw, isHex(raw) else { return defaultFamilyHex }
        return raw
    }

    /// Is this a full `#RRGGBB` hex? (Shared with the custom-color picker.)
    static func isHex(_ s: String) -> Bool {
        s.count == 7 && s.hasPrefix("#") && s.dropFirst().allSatisfy(\.isHexDigit)
    }

    /// A "family event" = its people (participants + the owner) cover every household
    /// member. **One-person households never qualify** — there's no whole-vs-part
    /// distinction to draw, so a solo household keeps its own color everywhere.
    func isFamilyEvent(_ e: SyncedEvent) -> Bool {
        guard memberIds.count >= 2 else { return false }
        var ids = Set(e.participantIds)
        if let owner = e.personId { ids.insert(owner) }
        return memberIds.isSubset(of: ids)
    }

    /// The color this event should paint in: the family color for whole-family events,
    /// else the owner's. `nil` means unassigned — the call site keeps its own grey (the
    /// grids and the agenda surfaces deliberately use different ones, matching the two
    /// fallbacks the web passes to `useEventColor`).
    func hex(for e: SyncedEvent) -> String? {
        isFamilyEvent(e) ? familyHex : e.colorHex
    }

    /// `hex(for:)` as a `Color`, falling back to the caller's own unassigned color.
    func color(for e: SyncedEvent, fallback: Color = WF.ink3) -> Color {
        Color(hexString: hex(for: e)) ?? fallback
    }

    /// The fill + text for a chip that has a *background* (month-cell chips, week/day
    /// blocks, all-day pills). Bars and dots have no background, so they take
    /// `color(for:)` directly and ignore the style.
    func chip(for e: SyncedEvent, fallback: Color = WF.ink3) -> EventChipPaint {
        EventChipPaint(color(for: e, fallback: fallback), style: style)
    }
}

/// The readable-ink rule for **solid** chips, ported 1:1 from the web's `solidChipInk`
/// (`apps/web/src/lib/event-color.ts`). A solid chip fills with the event's color, so the
/// text can't be a fixed white: white clears WCAG AA (4.5:1) on only one of the eight
/// preset member colors — gold sits at 2.2:1 and teal at 2.5:1, illegible from across a
/// kitchen. Black or white always works though: wherever white falls short the fill is
/// light enough that black clears it (the crossover is at luminance ≈0.179, where both
/// give 4.58:1). So each chip takes the winning ink **for the fill it actually gets**,
/// which differs by theme — dark mixes the fill toward black first.
///
/// Kept as pure hex→hex functions (rather than folded into the `UIColor` math) so the
/// tests can assert the web function's exact output for every swatch; a drift on either
/// platform then fails on one side.
enum EventChipInk {
    /// Dark mode mixes the fill toward black; keep in step with the web's `SOLID_DARK_MIX`
    /// and the matching rule in `apps/web/src/styles/waffled.css`.
    static let solidDarkMix = 0.82

    static let white = "#FFFFFF"
    static let black = "#000000"

    /// The fill a solid chip actually gets in that theme, as `#RRGGBB`. nil if malformed.
    static func solidFill(_ hex: String, dark: Bool) -> String? {
        guard let rgb = components(hex) else { return nil }
        guard dark else { return format(rgb) }
        return format(rgb.map { ($0 * solidDarkMix).rounded() })
    }

    /// WCAG contrast ratio between two `#RRGGBB` colors (1–21); 1 for malformed input,
    /// which makes an unparseable color fall through to the same answer on both sides.
    static func contrastRatio(_ a: String, _ b: String) -> Double {
        guard let ca = components(a), let cb = components(b) else { return 1 }
        let (hi, lo) = (max(luminance(ca), luminance(cb)), min(luminance(ca), luminance(cb)))
        return (hi + 0.05) / (lo + 0.05)
    }

    /// Black or white — whichever reads better on this color's fill, per theme.
    static func ink(for hex: String) -> (light: String, dark: String) {
        (light: inkFor(solidFill(hex, dark: false) ?? hex),
         dark: inkFor(solidFill(hex, dark: true) ?? hex))
    }

    private static func inkFor(_ background: String) -> String {
        contrastRatio(background, white) >= contrastRatio(background, black) ? white : black
    }

    /// WCAG relative luminance of 0–255 components.
    private static func luminance(_ rgb: [Double]) -> Double {
        let c = rgb.map { v -> Double in
            let s = v / 255
            return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    }

    private static func components(_ hex: String) -> [Double]? {
        var s = hex.trimmingCharacters(in: .whitespaces)
        guard s.hasPrefix("#") else { return nil }
        s.removeFirst()
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        return [Double((v >> 16) & 0xFF), Double((v >> 8) & 0xFF), Double(v & 0xFF)]
    }

    private static func format(_ rgb: [Double]) -> String {
        String(format: "#%02X%02X%02X",
               Int(max(0, min(255, rgb[0]))), Int(max(0, min(255, rgb[1]))), Int(max(0, min(255, rgb[2]))))
    }
}

/// The two colors one event chip is painted with, resolved per theme. Mirrors the web
/// stylesheet exactly:
///
/// * **solid** — the chip fills with the event color, and the title takes the ink
///   (`#000000` or `#FFFFFF`) that stays readable on that fill — see `EventChipInk`, and
///   note this is *not* a `WF.ink` fill, so neither `WF.onInk` nor a literal `.white` is
///   right here. In dark the fill mixes 18% toward black so it keeps depth against the
///   warm charcoal card, and the ink is re-picked for that darker fill.
/// * **tinted** — a 14% (dark: 24%) wash of the color, with the text mixed 58% (dark:
///   42%) of the color into the theme's ink. Mixing against ink rather than using the raw
///   hex is what keeps a dark-ish member color legible on a dark card.
struct EventChipPaint {
    /// The event's resolved color, unstyled — what an accent bar or dot should use.
    let color: Color
    let background: Color
    let foreground: Color

    init(_ color: Color, style: EventStyle) {
        self.color = color
        let base = UIColor(color)
        switch style {
        case .solid:
            background = Color(UIColor { tc in
                tc.userInterfaceStyle == .dark
                    ? base.resolvedColor(with: tc).wfMixed(with: .black, amount: 0.18)
                    : base.resolvedColor(with: tc)
            })
            // The ink follows the *resolved* fill, so an unassigned chip painted in the
            // dynamic WF.ink3 token gets the right answer in each theme too.
            foreground = Color(UIColor { tc in
                let ink = EventChipInk.ink(for: base.resolvedColor(with: tc).wfHexString)
                let chosen = tc.userInterfaceStyle == .dark ? ink.dark : ink.light
                return chosen == EventChipInk.white ? .white : .black
            })
        case .tinted:
            background = Color(UIColor { tc in
                base.resolvedColor(with: tc)
                    .withAlphaComponent(tc.userInterfaceStyle == .dark ? 0.24 : 0.14)
            })
            foreground = Color(UIColor { tc in
                let ink = UIColor(WF.ink).resolvedColor(with: tc)
                return base.resolvedColor(with: tc)
                    .wfMixed(with: ink, amount: tc.userInterfaceStyle == .dark ? 0.58 : 0.42)
            })
        }
    }
}

extension UIColor {
    /// `color-mix(in srgb, self (1-amount), other amount)` — `amount` is the fraction of
    /// `other`. Both colors are read in the extended-sRGB space the app's hex tokens live
    /// in, so an out-of-gamut component can't wrap around into a wrong hue.
    func wfMixed(with other: UIColor, amount: Double) -> UIColor {
        var r1: CGFloat = 0, g1: CGFloat = 0, b1: CGFloat = 0, a1: CGFloat = 0
        var r2: CGFloat = 0, g2: CGFloat = 0, b2: CGFloat = 0, a2: CGFloat = 0
        guard getRed(&r1, green: &g1, blue: &b1, alpha: &a1),
              other.getRed(&r2, green: &g2, blue: &b2, alpha: &a2) else { return self }
        let t = CGFloat(max(0, min(1, amount)))
        return UIColor(red: r1 + (r2 - r1) * t, green: g1 + (g2 - g1) * t,
                       blue: b1 + (b2 - b1) * t, alpha: a1 + (a2 - a1) * t)
    }

    /// This color as a `#RRGGBB` string the server's `HEX_COLOR` guard accepts.
    ///
    /// SwiftUI's native `ColorPicker` hands back display-P3 values whose sRGB components
    /// can fall outside 0…1, and `String(format: "%02X", Int(1.02 * 255))` would produce a
    /// 3-digit component — so the components are converted to sRGB and clamped before
    /// formatting. Without this the custom swatch would post a hex the API rejects with a 400.
    var wfHexString: String {
        let srgb = cgColor.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!,
                                     intent: .defaultIntent, options: nil)
        let c = srgb?.components ?? cgColor.components ?? [0, 0, 0, 1]
        func byte(_ i: Int) -> Int {
            Int((max(0, min(1, c.count > i ? c[i] : 0)) * 255).rounded())
        }
        // A monochrome color space reports [white, alpha]; expand it to three channels.
        let (r, g, b) = c.count >= 3 ? (byte(0), byte(1), byte(2)) : (byte(0), byte(0), byte(0))
        return String(format: "#%02X%02X%02X", r, g, b)
    }
}

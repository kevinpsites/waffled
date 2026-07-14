import Foundation
import SwiftUI

/// The user's theme choice. Mirrors the web store's three states
/// (`apps/web/src/lib/theme.ts`): pin light, pin dark, or follow the device.
enum ThemePref: String, CaseIterable, Identifiable {
    case light, dark, system
    var id: String { rawValue }

    /// The SwiftUI scheme to force, or `nil` to follow the device (the "Match system" case).
    /// `nil` lets iOS re-resolve every `Color(light:dark:)` on an OS appearance flip for free.
    var colorScheme: ColorScheme? {
        switch self {
        case .light:  return .light
        case .dark:   return .dark
        case .system: return nil
        }
    }

    var label: String {
        switch self {
        case .light:  return "Light"
        case .dark:   return "Dark"
        case .system: return "System"
        }
    }
}

/// Persists the theme choice and exposes it as a `ColorScheme?` for the app root to pin.
/// Mirrors the web store: same semantics, default `system`. Because UIKit re-resolves the
/// dynamic `Color(light:dark:)` tokens on a scheme change, pinning `.preferredColorScheme`
/// at the root is the whole mechanism — no media-query plumbing.
@Observable
final class ThemeStore {
    /// The persisted key. Web uses localStorage `waffled:theme`; UserDefaults keys use the
    /// dot form `waffled.theme` (documented in DARK_MODE.md).
    static let key = "waffled.theme"

    @ObservationIgnored private let defaults: UserDefaults

    /// Setting this persists immediately and — via Observation — re-renders any view reading
    /// it, so the Settings preview highlight tracks a live change (the web `subscribe()` fix).
    var pref: ThemePref {
        didSet { defaults.set(pref.rawValue, forKey: Self.key) }
    }

    /// The scheme to pin at the app root (`nil` = follow the device).
    var colorScheme: ColorScheme? { pref.colorScheme }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // `didSet` doesn't fire from an initializer, so this read-back never writes.
        self.pref = defaults.string(forKey: Self.key).flatMap(ThemePref.init(rawValue:)) ?? .system
    }
}

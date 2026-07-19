import SwiftUI

/// Settings → Appearance. Pins Light / Dark, or follows the device ("Match system").
/// Mirrors the web `AppearancePanel` (`apps/web/src/kiosk/Settings.tsx`): two preview
/// cards + a Match-system toggle, saved per-device via `ThemeStore` (key `waffled.theme`).
struct AppearanceSettingsView: View {
    @Environment(ThemeStore.self) private var theme
    /// The *resolved* scheme actually on screen — reflects the device under "Match system"
    /// and the pinned choice otherwise. Drives which card shows the "currently applied" ✓.
    @Environment(\.colorScheme) private var resolved

    private var matchSystem: Bool { theme.pref == .system }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Theme").padding(.horizontal, 2)

                HStack(spacing: 12) {
                    ThemePreviewCard(
                        label: "Light",
                        active: resolved == .light,
                        pinned: theme.pref == .light,
                        swatch: .light
                    ) { theme.pref = .light }

                    ThemePreviewCard(
                        label: "Dark",
                        active: resolved == .dark,
                        pinned: theme.pref == .dark,
                        swatch: .dark
                    ) { theme.pref = .dark }
                }

                WaffledCard(padding: 14, radius: WF.rMD) {
                    HStack(spacing: 12) {
                        WaffledEmojiTile(emoji: "🌗")
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Match system").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                            Text("Follow your device's light/dark setting automatically.")
                                .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                        }
                        Spacer(minLength: 0)
                        // Native Toggle (reuse rule #1). Turning it ON follows the device;
                        // turning it OFF pins whatever is currently resolved — same as web.
                        Toggle("", isOn: Binding(
                            get: { matchSystem },
                            set: { on in theme.pref = on ? .system : (resolved == .dark ? .dark : .light) }
                        ))
                        .labelsHidden().tint(WF.primary)
                    }
                }
                .padding(.top, 4)

                Text("This choice is saved on this device only.")
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3)
                    .padding(.horizontal, 2).padding(.top, 8)
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(WF.canvas)
        .navigationTitle("Appearance").navigationBarTitleDisplayMode(.inline)
    }
}

/// One theme option: a mini mockup + a label. The swatch hexes are **fixed literals**
/// (not WF tokens) — the card *depicts* a theme, so it must look light/dark regardless of
/// which theme is currently active. A coral ring marks the pinned choice; the ✓ marks the
/// theme actually on screen.
private struct ThemePreviewCard: View {
    enum Swatch {
        case light, dark
        // Mirrors the web preview literals exactly.
        var bg: Color   { self == .dark ? Color(hex: 0x14110C) : Color(hex: 0xFAF7F2) }
        var card: Color { self == .dark ? Color(hex: 0x232019) : Color(hex: 0xFFFFFF) }
        var line: Color { self == .dark ? Color(hex: 0x4A453C) : Color(hex: 0xC9C3B8) }
    }

    let label: String
    let active: Bool
    let pinned: Bool
    let swatch: Swatch
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            VStack(spacing: 10) {
                // Mini mockup: a header line + two "cards" floating on the canvas.
                VStack(alignment: .leading, spacing: 7) {
                    Capsule().fill(swatch.line).frame(width: 44, height: 6)
                    RoundedRectangle(cornerRadius: 7, style: .continuous).fill(swatch.card).frame(height: 26)
                    RoundedRectangle(cornerRadius: 6, style: .continuous).fill(swatch.card).frame(width: 66, height: 16)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(height: 96)
                .background(swatch.bg)
                .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))

                HStack(spacing: 5) {
                    if active {
                        Image(systemName: "checkmark").font(.system(size: 11, weight: .heavy)).foregroundStyle(WF.primary)
                    }
                    Text(label).font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity)
            .background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: WF.rLG, style: .continuous)
                    .strokeBorder(pinned ? WF.primary : WF.hair, lineWidth: pinned ? 2 : 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label) theme")
        .accessibilityAddTraits(pinned ? [.isSelected] : [])
    }
}

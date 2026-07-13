# iOS dark-mode parity — implementation notes

**Status:** not started (web dark mode shipped first). This is the plan to bring the
iPhone/iPad app to 1:1 color + design parity with the web dark theme.

The canonical color system — every token, with one **light** and one **dark** value —
is defined for the web in `apps/web/src/styles/waffled.css` and documented in the
"Nook Tokens — Source of Truth" design file. iOS must mirror those exact values so the
two platforms read as the same product. **Do not invent iOS-only colors**; if a value
isn't in the token table below, it gets added to the source of truth first.

## The design intent (same as web)

A **warm dark, not a cold one.** Surfaces and ink invert onto warm charcoals (never pure
black / blue-grey). **Every brand, accent, and per-person hue stays exactly the same** in
both themes — that fixedness is what makes it still feel like Waffled with the lights off.
Two adjustments only:
- The pale per-person / status **tints become low-opacity washes** of the same hue
  (≈18–22% alpha) instead of solid pastels.
- **Elevation inverts:** in dark, `card` is *lighter* than `canvas` (a raised surface
  catches light); in light it's the reverse. Shadows deepen.

## Where iOS is today (audit)

- Tokens are code constants: `enum WF` in
  `Sources/Waffled/DesignSystem/Theme.swift`, built from `0xRRGGBB` via a custom
  `Color(hex: UInt32)` init that hardcodes `opacity: 1` and sRGB — **not dark-aware.**
- Per-person colors: `enum FamilyColor` (kevin/kelly/wally/lottie) with `.solid` + `.tint`.
  **Web has since renamed these tokens to slots `--person-1…4`** (blue/pink/green/purple) to
  decouple the reusable accent palette from demo-person names; for parity, rename the iOS
  `FamilyColor` cases to slots too (e.g. `person1…4`) — values are unchanged.
- The app is **forced light**: `.preferredColorScheme(.light)` in
  `Sources/Waffled/App/WaffledApp.swift` (~line 44).
- **No `success` / `danger` / `warn` / `info` tokens exist** — status color is currently
  ad-hoc (`.green/.red/.orange`, plus stray inline hexes like `0x2E7D46` in
  `Features/Pantry/CookFromPantrySheet.swift`). These must be added.
- ~27 files carry ~130 inline `Color(hex: 0x…)` literals (concentrated in
  `Features/Pantry`, `Features/Meals`, `Features/Kiosk`, `Today`, `Rewards`, `Goals`,
  `Calendar`, `Family`, `Settings`). `Color(hexString:)` (19 files) is for **real**
  `persons.color_hex` data — leave those alone.
- Asset catalog `Sources/Waffled/Resources/Assets.xcassets` exists with two single-appearance
  color sets (`AccentColor`, `LaunchBackground`) — precedent, but the `WF` tokens are not in it.
- Settings screen: `Features/Settings/SettingsView.swift` (`row(...)` list, sections
  Account / Family / System). Nav routes via `Features/Family/HubDestinations.swift`.

## Recommended approach: a dynamic `Color(light:dark:)`, keep the readable table

Two viable paths:

- **(A) Asset-catalog color sets** with Any/Dark appearances, referenced as `Color("canvas")`.
  Very Apple-native and free system integration — but it scatters the palette into JSON
  colorsets, loses the readable hex table, and drifts from the web `:root` you diff against.
- **(B) A dynamic `Color(light:dark:)` initializer** wrapping `UIColor { traitCollection }`,
  keeping the `WF` enum as the single readable table. **Recommended** — it's the smallest
  diff (each token becomes one line), keeps iOS and web token tables visually 1:1, and the
  tint-wash rule falls out as `.opacity()`.

### Step 1 — add a dark-aware initializer to `Theme.swift`

```swift
import UIKit

extension Color {
    /// A Color that resolves per appearance. Light/dark are 0xRRGGBB literals.
    init(light: UInt32, dark: UInt32, opacity: Double = 1) {
        self = Color(UIColor { tc in
            let hex = tc.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red:   CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8)  & 0xFF) / 255,
                blue:  CGFloat( hex        & 0xFF) / 255,
                alpha: CGFloat(opacity))
        })
    }
}
```

### Step 2 — restate the `WF` palette with both appearances

```swift
enum WF {
    // Surfaces — warm whites → warm charcoals; elevation inverts.
    static let canvas = Color(light: 0xFAF7F2, dark: 0x14110C)   // --bg
    static let rail   = Color(light: 0xF1ECE3, dark: 0x1B160F)
    static let panel  = Color(light: 0xF4EFE7, dark: 0x1A1710)
    static let card   = Color(light: 0xFFFFFF, dark: 0x232019)
    static let card2  = Color(light: 0xFCFAF6, dark: 0x1C1811)

    // Ink — near-black → warm off-white.
    static let ink   = Color(light: 0x1D1D1F, dark: 0xF3EEE4)
    static let ink2  = Color(light: 0x6B6B70, dark: 0xADA69A)
    static let ink3  = Color(light: 0xA6A29B, dark: 0x726B5E)

    // Borders — alpha on ink (light) / white (dark).
    static let hair  = Color(light: 0x282118, dark: 0xFFFFFF).opacity(0.08) // see note*
    static let line  = Color(light: 0x282118, dark: 0xFFFFFF).opacity(0.18)

    // Brand — hues fixed; only the shade/tint retune for dark.
    static let primary  = Color(hex: 0xEC6049)                    // same both themes
    static let primaryD = Color(light: 0xD84A33, dark: 0xF0745F)
    static let primaryT = Color(light: 0xF3E2D8, dark: 0xEC6049)  // dark: primary @ .18 — see tint note
    static let gold     = Color(hex: 0xF3A93B)                    // same
    static let ai       = Color(light: 0x6E56CF, dark: 0x8C74E8)
    static let ai2      = Color(light: 0x8C74E8, dark: 0xA48CF0)
    static let aiD      = Color(light: 0x6A3FC4, dark: 0xB9A3F5)  // AI text-on-tint

    // Status / semantic — NEW on iOS. Base for text/icons; tint for fills.
    static let success  = Color(light: 0x25A368, dark: 0x34B87A)
    static let danger   = Color(light: 0xC0392B, dark: 0xE15B4C)
    static let warn     = Color(light: 0xC77A1A, dark: 0xE8A13E)
    static let info     = Color(light: 0x2F7FED, dark: 0x4C9BFF)
}
```

**\* Alpha tints in dark are washes of the hue, not a fixed pastel.** In light, tints are the
solid pastels (`primaryT #F3E2D8`, `successT #E4F5EC`, `kevin-t #E7F0FE`, …). In dark they're
the *base hue at ~18–22% alpha*. The clean way to express that: give each tint a small helper
that returns the light pastel in light mode and `base.opacity(0.20)` in dark. Exact dark alphas
from the source of truth: primary .18, ai .20, success/danger/warn/info .18–.20, people .20–.22.

### Full token table (for reference / the tint helpers)

| Token | Light | Dark |
|---|---|---|
| bg / canvas | `#FAF7F2` | `#14110C` |
| rail | `#F1ECE3` | `#1B160F` |
| panel | `#F4EFE7` | `#1A1710` |
| card | `#FFFFFF` | `#232019` |
| card-2 | `#FCFAF6` | `#1C1811` |
| ink | `#1D1D1F` | `#F3EEE4` |
| ink-2 | `#6B6B70` | `#ADA69A` |
| ink-3 | `#A6A29B` | `#726B5E` |
| hair | ink @ .08 | white @ .10 |
| hair-2 | ink @ .045 | white @ .06 |
| line | ink @ .18 | white @ .18 |
| primary | `#EC6049` | `#EC6049` |
| primary-d | `#D84A33` | `#F0745F` |
| primary-t | `#F3E2D8` | primary @ .18 |
| gold | `#F3A93B` | `#F3A93B` |
| ai | `#6E56CF` | `#8C74E8` |
| ai-2 | `#8C74E8` | `#A48CF0` |
| ai-d | `#6A3FC4` | `#B9A3F5` |
| ai-t | `#EFEAFC` | ai-2 @ .20 |
| person-1…4 (blue/pink/green/purple) | unchanged | unchanged |
| ·-t (each person tint) | pale solid | base @ .20–.22 |
| success | `#25A368` (= wally) | `#34B87A` |
| success-t | `#E4F5EC` | success @ .20 |
| danger | `#C0392B` | `#E15B4C` |
| danger-t | `#FBE3E1` | danger @ .18 |
| warn | `#C77A1A` | `#E8A13E` |
| warn-t | `#FDF2DD` | warn @ .18 |
| info | `#2F7FED` (= kevin) | `#4C9BFF` |
| info-t | `#E7F0FE` | info @ .20 |

Shadows: light `wfShadow1/3` stay; dark deepen to ≈`0 1px 2px black@.45` / `0 12px 34px black@.6`.

### Step 3 — drive the theme from a preference (not forced light)

1. Replace the global `.preferredColorScheme(.light)` in `WaffledApp.swift` with a value
   derived from a stored preference: `Light` / `Dark` / `System`.
2. Add a tiny `ThemeStore` (`@AppStorage("waffled.theme")` or an `ObservableObject` over
   `UserDefaults`), key **`waffled.theme`**, values `light|dark|system`, default `system`
   — mirroring the web store (web persists `waffled:theme` in localStorage).
3. Apply at the root: `.preferredColorScheme(pref == .system ? nil : (pref == .dark ? .dark : .light))`.
   `nil` lets iOS follow the device automatically (the "Match system" case) — no media-query
   plumbing needed, UIKit re-resolves every `Color(light:dark:)` on the trait change for free.

### Step 4 — Settings → Appearance (parity with web)

- Add an **"Appearance"** row to `SettingsView.swift` in the **System** section (near
  AI & Capture / Permissions), pushing a new `.settingsAppearance` case added to
  `Features/Family/HubDestinations.swift`.
- The destination view mirrors the web `AppearancePanel`: two **Light / Dark preview cards**
  (fixed literal swatches — they *depict* each theme, so they must NOT be dynamic) + a
  **"Match system"** toggle. Selecting a card pins `light`/`dark`; the toggle sets/clears
  `system`. Same semantics as `apps/web/src/kiosk/Settings.tsx`.

### Step 5 — sweep the inline literals

Migrate the ~27 files' inline `Color(hex: 0x…)` theme literals to `WF.*` tokens (same
migration map as web: greens→`WF.success`, reds→`WF.danger`, ambers→`WF.warn`, blues→`WF.info`,
white *surfaces*→`WF.card`, muted greys→`WF.ink3`). **Leave `Color(hexString:)` (real person
data) and white *foreground on colored fills* (button/badge text) as-is** — same surface-vs-
foreground rule as web. The `ScreensaverView` already forces `.dark` locally; leave that.

### Verify

- `xcodegen generate` then a clean `xcodebuild` (new files/assets need the project regenerated).
- Exercise both themes in the simulator (Settings → Appearance, and Xcode's Environment
  Overrides → Interface Style) across Today / Goals / Meals / Pantry / Settings.
- Diff the on-screen result against the web dark screenshots — the two must match.

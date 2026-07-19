# Waffled iOS app — conventions & gotchas (`apps/ios`, SwiftUI)

Folder-scoped notes; loads when working under `apps/ios`. See the repo-root
`CLAUDE.md` for repo-wide workflow (worktree-first, TDD, PRs, releases).

## iOS app (SwiftUI, `apps/ios`)

### Reuse before you hand-roll (same rule as the web app)

Before building a custom view or control, use what already exists — in this order:

1. **A native SwiftUI control.** `List` + `.swipeActions` for swipe-to-edit/delete,
   `Menu` / `confirmationDialog` for actions, `.searchable`, `.refreshable`, etc. If a
   native control seems not to fit (e.g. `.swipeActions` needs a `List` but you have a
   `LazyVGrid`), first try **restructuring** — use a `List` — before writing a bespoke
   gesture or control.
2. **The app's shared components + tokens.** `Features/DesignSystem/Components.swift`,
   `PlanShared.swift`, `WaffledCard`, `SectionLabel`, the `WF.*` colors/radii. Match the
   neighbours; don't invent a parallel look. Two menu families exist by design — see the
   "iOS UI consistency" memory before adding a third.

Only hand-roll when a native/shared option genuinely can't do the job — and say **why**
in a comment. (This bit us: a custom pantry swipe-control drifted from the Lists' native
swipe until it was reworked to `List.swipeActions`.)

### Dark mode & theming — colors are dark-aware tokens, never literals

The app ships a warm dark theme (`Settings → Appearance`). Every color is a **dark-aware
token** in `DesignSystem/Theme.swift`, built on `Color(light:dark:)` (a dynamic `UIColor`
UIKit re-resolves on the appearance change). Rules:

1. **Never hardcode `Color(hex: 0x…)` for a theme color.** Use the `WF.*` tokens (surfaces
   `canvas`/`card`/`panel`, ink `ink`/`ink2`/`ink3`, status `success`/`danger`/`warn`/`info`
   + their `…T` tint washes, `primary`/`gold`/`ai`). A raw hex won't flip and goes wrong in
   one theme (a light surface stays light in dark; dark ink text goes invisible on a dark
   card). **Leave alone:** `Color(hexString:)` (real `persons.color_hex` data) and **identity
   palettes** that must stay distinct — allergen badges, per-person/per-category coding,
   reward confetti. Those are fixed by design, not theme surfaces.

2. **Text/icons on a solid `WF.ink` fill must use `WF.onInk`, never a literal `.white`.**
   `WF.ink` is near-black in light but flips to a *warm off-white* in dark, so a `.white`
   label becomes white-on-white (invisible). This bit us **twice** (selected filter pills,
   then the Cook Mode / Replace-photo buttons) — hence the semantic `WF.onInk` token (the
   inverse of ink). `.white` is only correct on a **colored** fill (coral/AI/green) that
   stays saturated in both themes.

3. **One source of truth for the scheme.** The theme is pinned by a single app-root
   `.preferredColorScheme(theme.colorScheme)` from `ThemeStore` (`@AppStorage`-style, key
   `waffled.theme`, default `system`). Don't force `.preferredColorScheme` in individual
   views — the only deliberate exception is `ScreensaverView` (always-dark).

4. **Large saturated fills deepen in dark, they don't stay neon.** A hero gradient with
   light-mode-bright stops reads as garish against the warm charcoal — make it
   `Color(light:dark:)` so it deepens (see the reward wallet hero). Decorative gradients with
   a *white* foreground can stay saturated; a gradient behind *flipping* (WF-token) text must
   flip too, or you get the light-on-light (web) / dark-on-dark clash.

Token values mirror the web `apps/web/src/styles/waffled.css` 1:1 — keep them in sync; the
full palette + rationale live in `apps/ios/DARK_MODE.md`, locked by `Tests/ThemeTests.swift`.

### Performance — two traps we've hit repeatedly

1. **Don't use `AsyncImage` for images in a `List` / `LazyVGrid`.** It re-fetches
   and re-decodes every time a cell is recreated — which happens on *every search
   keystroke and every scroll* — and saturates the main thread (felt as
   multi-second lag just tapping a search field). Use the decoded-image cache
   **`CachedImage`** (`Sources/Waffled/Features/Pantry/CachedImage.swift`):
   `NSCache`-backed, resolves OFF (absolute) + uploaded (relative) URLs via
   `MediaURL`, and serves a cache hit **synchronously at `init`** so a re-render
   doesn't reload. (`ScreensaverView` has its own `ScreensaverImageCache`.)

2. **Keep date math out of the render/sort/filter hot path.**
   `Calendar(identifier:)` allocation + `startOfDay` per call — multiplied across a
   sort comparator (O(n log n)), filters, and per-row badges, then recomputed on
   every keystroke — janks hard. Allocating a `DateFormatter` per row is the same
   trap. Precompute derived per-row data (expiry days, flags, sort keys) **once per
   data load** in the `@Observable` model (e.g. `PantryModel.daysToExpiry: [id:
   Int]`), then O(1) look it up in the view. Make `DateFormatter`s `static let`.

**General rule:** precompute per-row derived data in the model on load; don't
recompute it in computed properties the view reads N× per render.

### Project generation

The Xcode project is generated by **XcodeGen from `apps/ios/project.yml`** (the
`.xcodeproj` is gitignored). New `.swift` files are auto-included by the directory
source, **but you must run `xcodegen generate` before building** so the project
sees them. New Info.plist keys / capabilities require editing `project.yml` then
regenerating.

### Adding a restricted capability (HealthKit, etc.) — two publish gates, both hidden

A green **local** build proves nothing: the simulator enforces no entitlements and
never runs App Store static analysis. A new restricted capability fails at **two
separate Xcode Cloud gates**, both vaguely labeled by the capability:

1. **Ad-hoc/App Store export → `exit code 70`.** Apple-managed signing won't
   auto-enable a restricted capability on the App ID. Enable it in the Developer
   portal (Identifiers → `app.waffled.Waffled` → tick the capability → Save), then
   re-run. Real error lives in the export step's `IDEDistribution.standard.log`.
2. **App Store upload → `ITMS-90683: Missing purpose string`.** Static analysis
   requires **every** relevant usage string once the entitlement is present, even
   if you never call those APIs. HealthKit needs BOTH `NSHealthShareUsageDescription`
   **and** `NSHealthUpdateUsageDescription` — read-only is not an exception.

"Preparing build for App Store Connect failed" shows no detail in the UI — the real
`ITMS-xxxxx` reason arrives by **email** to the account holder. Build number is frozen
at `CURRENT_PROJECT_VERSION: 1`; every upload relies on the workflow's "Xcode Cloud
manages build number" toggle being on (else duplicate-build rejects).

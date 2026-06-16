# Nook iOS — the capture companion

Native **SwiftUI** phone app for Nook (the family hub). Plays sidekick to the
always-on kiosk: *add anything, anywhere*, with offline read/write.

## Architecture (see `docs/ARCHITECTURE.md` at the repo root)

- **SwiftUI** for all UI.
- **PowerSync Swift SDK** owns the on-device SQLite mirror of Postgres — the
  source of truth for everything that syncs (family, agenda, chores, meals,
  lists, stars). Reads are local; writes upload through our API. *(Phase 1.)*
- **SwiftData** is reserved for **device-only** state that never syncs (capture
  drafts typed offline, UI prefs, cached recipe-card photos before upload).
  It is *not* the sync layer — PowerSync is.
- Auth: a **local HS256 dev token** for now (mint via `just token` /
  `/api/powersync/token`); **Auth0** (Apple + Google) swaps in later — same JWT
  shape (`household_id` claim).

## Project layout

This is an **XcodeGen** project. The Xcode project file is generated from
`project.yml`, so we never hand-edit a `.pbxproj`:

```
apps/ios/
  project.yml          # source of truth — edit this, then regenerate
  Nook.xcodeproj/      # GENERATED (gitignored)
  Sources/Nook/
    App/               # @main entry + root tab navigation
    DesignSystem/      # Nook tokens + reusable SwiftUI components
    Features/          # one folder per tab/screen
    Support/           # sample data, helpers
```

## Develop

```bash
brew install xcodegen          # one-time
cd apps/ios
xcodegen generate              # regenerate Nook.xcodeproj after any file/yml change
open Nook.xcodeproj            # or build from the CLI:

xcodebuild -scheme Nook \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

Whenever you **add or remove a Swift file**, re-run `xcodegen generate` (sources
are folder-globbed, so you don't list files individually).

## Status

- **Phase 0 — scaffold:** app shell, Nook design system, 5-tab navigation,
  static Today screen. ← current
- **Phase 1 — sync de-risk (roadmap M4.2):** PowerSync + dev-token auth, mirror
  `persons`, Family screen from local SQLite, airplane-mode read/write/reconnect.

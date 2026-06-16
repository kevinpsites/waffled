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
brew install xcodegen           # one-time
cd apps/ios
./Scripts/vendor-powersync.sh   # one-time: fetch + patch the PowerSync SDK (see below)
xcodegen generate               # regenerate Nook.xcodeproj after any file/yml change
open Nook.xcodeproj             # or build from the CLI:

xcodebuild -project Nook.xcodeproj -scheme Nook \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

Whenever you **add or remove a Swift file**, re-run `xcodegen generate` (sources
are folder-globbed, so you don't list files individually).

### Vendored PowerSync SDK (temporary)

PowerSync 1.14.3 doesn't compile under Xcode 26.1 / Swift 6.2 (`weak let` is now a
hard error). `Scripts/vendor-powersync.sh` clones the SDK into `Vendor/`
(gitignored) and applies a two-line patch; `project.yml` points the SPM
dependency at that local copy. Revert to the remote pin once upstream fixes it.

## Run the Phase 1 sync demo

Bring up the backend (`docker compose … up -d` / `just up`), mint a dev token
(`just token` / `nook token`), then launch the app pointed at the local stack.
Config comes from the launch environment (or the in-app Sync → Connection panel):

```bash
TOKEN=$(…/mint-token.js --sub 'dev|demo')
SIMCTL_CHILD_NOOK_API_URL=http://localhost:3000 \
SIMCTL_CHILD_NOOK_DEV_TOKEN="$TOKEN" \
  xcrun simctl launch booted ai.lorebooks.nook
```

The iOS simulator reaches the host Mac on `localhost`. Open **Family → ↻ (Sync)**
to see connection state, mirrored row counts, the pending-upload queue, and an
"Add offline test event" button. Optional headless demo switches:
`NOOK_START_TAB=family`, `NOOK_OPEN_SYNC=1`, `NOOK_DEMO_ADD_EVENT=1`.

## Status

- **Phase 0 — scaffold:** app shell, Nook design system, 5-tab navigation,
  static Today screen. ✅
- **Phase 1 — sync de-risk (roadmap M4.2):** PowerSync Swift SDK + dev-token auth,
  `persons`/`events` mirrored to local SQLite, Family people-row from the mirror,
  offline read + queued write + reconnect — verified end-to-end on the iPhone 17
  Pro sim against the live stack. ✅
- **Next — Phase 2:** the "Add anything" capture flow wired to `POST /api/capture`
  (+ SwiftData for offline capture drafts).

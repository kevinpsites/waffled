---
title: iOS development
description: Build and work on the native SwiftUI app.
---

`apps/ios` is a **SwiftUI universal app** — one binary that is a *personal
planner* on iPhone and a *family-hub kiosk* on iPad, switched at runtime by
device idiom (`Sources/Waffled/App/DeviceExperience.swift`). It's the web kiosk,
native and sized up.

Key facts:

- **Deployment target:** iOS 18
- **Language mode:** Swift 5
- **Bundle id:** `app.waffled`
- **Device family:** 1, 2 (iPhone + iPad)
- **OAuth callback scheme:** `waffled`

## Build

From `apps/ios`:

```bash
brew install xcodegen                 # one-time
./Scripts/vendor-powersync.sh         # one-time: fetch + patch the PowerSync Swift SDK into Vendor/
xcodegen generate                     # REQUIRED before building (Waffled.xcodeproj is generated + gitignored)
xcodebuild -project Waffled.xcodeproj -scheme Waffled \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

You **must** run `xcodegen generate`:

- after adding or removing **any `.swift` file** (sources are folder-globbed, so
  files aren't listed individually), and
- after editing `project.yml` (new Info.plist keys, capabilities, dependencies).

`apps/ios/Vendor/powersync-swift` is **gitignored** — fetch it with
`Scripts/vendor-powersync.sh`, which clones the PowerSync Swift SDK into
`Vendor/` and applies a small patch that `project.yml`'s SPM dependency points
at.

## Project structure

Under `Sources/Waffled/`:

- **`App/`** — `WaffledApp` (`@main`), `AppRoot`, and `DeviceExperience` (the
  runtime iPhone-vs-iPad switch).
- **`DesignSystem/`** — `Components.swift`, `Theme.swift`, `FieldStyles.swift`:
  the shared `WF` namespace and components. **REUSE these — don't hand-roll**
  tiles, pills, badges, or buttons.
- **`Features/`** — one folder per screen: Calendar, Chores, Rewards, Goals,
  Meals, Lists, Pantry, Photos, Family, Settings, Today, Kiosk, Capture, …
- **`Sync/`** — the data layer:
  - `WaffledAPI.swift` — the REST client.
  - `SyncManager.swift` — drives the PowerSync local SQLite mirror + upload
    queue.
  - plus `WaffledConnector`, `SyncSchema`, `Session`, `AuthTokens`,
    `TokenRefresher`, `AppConfig`, `MediaUpload`, `Capture/CaptureHeuristic`,
    `KioskDevice`/`KioskMode`, `NotificationManager`.

**PowerSync owns everything that syncs** — reads come from the local SQLite
mirror, writes upload through the API. **SwiftData** is only for device-only
state that never syncs. Auth uses a **local HS256 dev token** today; the real
auth uses the same JWT shape with a `household_id` claim.

## Run against your local server

Point the simulator at your local API with launch-environment variables:

```bash
SIMCTL_CHILD_WAFFLED_API_URL=http://localhost:3000 \
SIMCTL_CHILD_WAFFLED_DEV_TOKEN="$TOKEN" \
  xcrun simctl launch booted app.waffled
```

Get `$TOKEN` from `./waffled token` (see [Local development](/developer/local-development/)).

## Tests

Swift Testing tests live in `apps/ios/Tests`:

```bash
xcodebuild test -project Waffled.xcodeproj -scheme Waffled \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

## Performance traps (always avoid)

These two have bitten repeatedly:

1. **Never use `AsyncImage` in a `List` / `LazyVGrid`.** It re-decodes on every
   scroll and every keystroke, saturating the main thread. Use the
   `NSCache`-backed **`CachedImage`** instead.
2. **Keep date math out of render / sort / filter hot paths.**
   `Calendar` / `startOfDay` allocations and per-row `DateFormatter`s in a sort
   comparator or filter jank hard. Precompute per-row derived data **once** in
   the `@Observable` model, and make `DateFormatter`s `static`.

## CI (Xcode Cloud)

iOS ships via **Xcode Cloud**, not GitHub Actions, path-filtered to `apps/ios`.
The generated Xcode project is gitignored, but the **shared `Waffled` scheme is
committed** — Xcode Cloud discovers schemes from the repo, so removing it would
break the build. `ci_scripts/ci_post_clone.sh` runs on every Xcode Cloud build:
it installs XcodeGen, runs `Scripts/vendor-powersync.sh`, and `xcodegen
generate` before archiving.

## See also

- [Architecture](/developer/architecture/) — the big picture
- [Local development](/developer/local-development/) — the backend stack
- [Building a module](/concepts/extensibility/) — adding a feature
- [Contributing](/developer/contributing/) — commits, tests, and PRs

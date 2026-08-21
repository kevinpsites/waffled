# Waffled Android — conventions & gotchas

Folder-scoped notes, loaded when you work under `apps/android/`. Repo-wide rules
(worktree-first, TDD, one PR per batch, docs in the same PR) still apply — see the root
`CLAUDE.md`. The port plan is `docs/product/android-port-plan.md`.

## Toolchain — all of this is verified, and several bits are NOT the obvious default

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"   # JBR 21
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools                 # NOT ~/Library/Android/sdk
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

- **There is no JDK on `PATH`.** `/usr/bin/java` is the macOS stub. Homebrew has
  `openjdk` **26** (too new for AGP) and a keg-only `openjdk@17` that Gradle cannot
  auto-detect — hence `jvmToolchain(21)` and the Studio JBR.
- **`local.properties` is gitignored and the SDK path is non-standard**, so every fresh
  worktree needs it before Gradle will run:
  ```bash
  echo "sdk.dir=/opt/homebrew/share/android-commandlinetools" > apps/android/local.properties
  ```
- **AGP 9 has built-in Kotlin.** Adding `org.jetbrains.kotlin.android` is a hard error.
- **AGP 8.x cannot run on Gradle ≥ 9.6** — the wrapper is pinned on purpose. Use
  `./gradlew`, never the Homebrew `gradle`.
- **Compose needs `org.jetbrains.kotlin.plugin.compose` explicitly**, at the same version
  as Kotlin. `buildFeatures { compose = true }` alone fails.
- **compileSdk 37** (Compose BOM 2026.08.00 requires it). API 37.1 is installed.
- **No Hilt, no KSP.** KSP's newest release lags Kotlin 2.4.10, and annotation processors
  are the first thing to break on a bleeding-edge Kotlin. DI is the hand-rolled
  `AppContainer`; ViewModels take dependencies as constructor arguments.

## Build & test

```bash
cd apps/android
./gradlew test                 # all JVM unit tests — the pre-PR gate
./gradlew assembleDebug        # build the APK
./gradlew :feature:x:test      # one module
```

**`npm test` does not cover Android.** The repo gate for any change here is
`./gradlew test` **and** `./gradlew assembleDebug`, both green, before the PR.

Emulator: AVD `vpac` (Pixel 8, API 36, arm64).
```bash
$ANDROID_HOME/emulator/emulator -avd vpac &
adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n app.waffled.debug/app.waffled.android.MainActivity
adb exec-out screencap -p > /tmp/shot.png     # verify by eye, both themes
adb shell cmd uimode night yes                # check dark mode too
```
The emulator has **no `curl`** — probe the server through the app, not the shell.

**Two shell gotchas that waste time:** the `rtk` shim can mangle `grep` output (printing
`N matches in 0 files` with no content) — use `Read`, `sed -n` or `awk` instead, or
`rtk proxy grep`. And the worktree guard rejects compound one-liners it can't verify
(`cd X && grep …`), so split them into separate commands.

## Reaching the server

**`localhost` from an emulator is the emulator.** The host Caddy is **`10.0.2.2:8080`**
(the debug `DEFAULT_SERVER_URL`); from a physical phone it's the Mac's LAN IP.

Two more, both of which have bitten this repo before:
- **`./waffled up` must run from `~/dev/nook`, never from a worktree** — compose bind
  mounts bake the working directory into the running stack.
- **PowerSync can fail while REST works.** The `powerSyncUrl` is issued by the *server*
  (`POWERSYNC_PUBLIC_URL`); if it advertises a `localhost`, the device can't reach it and
  sync sits silently at "Offline". It currently advertises the LAN IP, which is correct —
  watch for DHCP drift.

## What Phase 0 gives you — use it, don't reinvent it

Every one of these exists because a feature would otherwise hand-roll it N times.

| Need | Use |
|---|---|
| Colours, radii, spacing, type | `WF.colors` / `WF.radius` / `WF.spacing` / `WF.type` |
| Serif heading | `WF.type.hero/title/sectionTitle`, or `WF.type.serif(size)` |
| Caption over a **photo** | `WF.colors.onMedia` on a `WF.colors.scrim` gradient — *not* white, *not* `onInk` |
| Cards, empty/loading states, CTAs, chips, avatars, badges | the components in `core:design` |
| Images | `AsyncImage` — the shared loader is installed by `app`; build requests with `WaffledImages.request(ctx, url, cacheKey)` |
| Media path → URL | `MediaUrl.resolve(path, baseUrl)`; cache key via `MediaUrl.cacheKey(path)` |
| REST load state | `RestDomain` — `apply(null)` = fetch FAILED (keep prior value, mark loaded); `apply(emptyList())` = genuinely empty |
| Telling screens to re-fetch after a write | `RefreshBus.bump(domain)` |
| Server error text | `ApiErrorText.from(body, status)` — relay the server, don't guess |
| HTTP client / auth | `WaffledHttp.client(tokens, server)`, `WaffledAuth` (implements `TokenProvider`) |
| Dates | `WaffledDates` — `parseInstant`, `localDay(zone)`, cached `formatter`, `noonIso` |
| API tests | `ApiTestHarness` in `core:testing` — MockWebServer + token/server fakes |

**`refreshAccessToken(failedToken)` takes the token the failed request actually sent.**
Pass it. That is what stops a staggered 401 from burning a second rotation of a
single-use refresh token.

## The frozen surface — do not edit these in a feature branch

`core/design/**` and `gradle/libs.versions.toml` are **frozen after Phase 0**. Many
agents work in parallel; a wave that all edit the catalog or the palette is an
unresolvable merge.

**If you need a token, component or library that doesn't exist: stop and report it.**
Do not add a local one.

A feature agent owns exactly `feature/<name>/**` plus its own `…Api.kt`. Nothing else.

## Design rules

The **web CSS (`apps/web/src/styles/waffled.css`) is the source of truth** for colour;
iOS mirrors it and Android is the third mirror. Never invent a platform-only colour and
never hardcode a hex — always a `WF.*` token. `ThemeTokensTest` locks the table against
the iOS `ThemeTests.swift`.

Two literal-colour exceptions are correct: real `persons.color_hex` data (via
`colorFromHex`), and identity palettes that must stay distinct regardless of theme —
allergen badges, per-person coding, reward confetti.

**The `onInk` rule** — text on a solid `WF.colors.ink` fill uses `WF.colors.onInk`, never
literal white. `ink` flips to warm off-white in dark, so white goes invisible. This has
bitten twice on iOS. White is only correct on a *saturated coloured* fill.

Dark mode: warm, never cold. Brand/AI/person hues are **fixed** across themes; tints
become low-opacity washes; **elevation inverts** (in dark, `card` is lighter than
`canvas`).

**Reuse hierarchy, in order:** a native Material3/Foundation control → shared components
+ tokens → hand-rolled, *with a comment saying why*. The tab bar is the current
documented exception (the raised FAB must break the bar's plane).

Two menu families exist by design (`WaffledMenuPill`, `WaffledSettingsMenuLabel`). Don't
add a third.

Screens scroll **under** the tab bar, so every screen owes
`WF.spacing.tabBarClearance` as bottom padding.

## Two performance traps that will bite exactly as they did on iOS

1. **Never use a naive async image loader in a lazy list/grid.** It re-fetches and
   re-decodes on every cell recreation — every scroll, every keystroke. Use Coil with a
   real memory cache and make sure the synchronous-cache-hit path exists.
2. **Keep date math out of the render/sort/filter hot path.** Precompute per-row derived
   values in the model once per data load, then do an O(1) lookup in the view.

## TDD — the iOS tests are the spec

`apps/ios/Tests/` is 59 files / 638 cases of **pure logic** (Swift Testing), independent
of SwiftUI. For each feature: **translate the Swift test to Kotlin first, watch it fail,
then port the logic.** That gives behavioural parity rather than approximate parity.

- API layer → JVM tests + **MockWebServer**.
- Pure logic → plain JVM `kotlin.test`.
- Screens → Compose UI tests, smoke/interaction only; otherwise verified by eye like iOS.

## KEEP IN SYNC contracts Android now joins

| Here | Must match |
|---|---|
| `core/sync/WaffledSyncSchema.kt` | web `powersync/schema.ts`, `sync-config.yaml`, iOS `SyncSchema.swift` — locked by `SyncSchemaParityTest` |
| `core/design/Theme.kt` | `waffled.css`, iOS `Theme.swift` — locked by `ThemeTokensTest` |
| `core/model/Modules.kt` | `apps/api/src/platform/modules.ts`, web `can()` |
| capture parsing (Wave C) | web `capture/parse.ts`, iOS `CaptureHeuristic.swift` |

The server sends **every** column (`SELECT *`); the client schema decides what is
materialised, so an omission is silent data loss, not an error.

> Known drift, found by the parity test: **iOS is missing `goal_id`, `goal_step_id` and
> `origin_ref_id`** on `events`. Android matches web, which is the declared source of
> truth.

## Release

`./waffled release X.Y.Z` must bump **`apps/android/app/build.gradle.kts` `versionName`**
alongside api/web/compose/iOS. Miss it and the repo, images and `.env` silently disagree.

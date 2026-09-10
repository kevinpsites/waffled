# Waffled for Mac — conventions & gotchas (`apps/mac`, SwiftUI)

Folder-scoped notes; loads when working under `apps/mac`. See the repo-root `CLAUDE.md` for
repo-wide workflow (worktree-first, TDD, PRs, releases), and `README.md` here for the
dev-mode recipe.

## XcodeGen is the source of truth

`project.yml` generates `Waffled.xcodeproj`, which is **gitignored**. Edit the yml, never the
project. **Run `xcodegen generate` after adding, renaming or deleting any file under
`Sources/` or `Tests/`** — a new file that is not in the regenerated project is not compiled,
and the build stays green while your code does not exist.

## Building and testing

```sh
xcodebuild test -project Waffled.xcodeproj -scheme Waffled -destination 'platform=macOS'
```

- The destination is the **host Mac**. There is no simulator; do not copy an iOS destination.
- **Always pass `-project Waffled.xcodeproj`.** `apps/ios` has a scheme with the same name,
  and a bare `-scheme Waffled` can resolve to the iOS one.
- `TEST_HOST` points at `Waffled.app/Contents/MacOS/Waffled`. The iOS form
  (`Waffled.app/Waffled`) builds fine and then fails to launch the host.
- There is deliberately **no App Sandbox and no entitlements for the app itself**. It spawns a
  runtime that runs Postgres against a real filesystem; sandboxing it breaks the only thing it
  does. (`Entitlements/` is not that: those plists belong to individual binaries inside the
  runtime bundle — see "Signing a release".)
- **A whole app is `Scripts/build-app.sh <bundle-dir> [out-dir]`**, not a build phase. It
  builds Release and clones a ~670 MB runtime bundle into `Contents/Resources/runtime`; an
  Xcode copy-files phase would re-copy all of it on every incremental build of an eleven-file
  app. CI runs the same script, then boots what it produced.
- **`WAFFLED_DATA_DIR` is not a dev-mode variable.** `WAFFLED_RUNTIME_BIN` is what turns dev
  mode on (the app is running a runtime it did not ship with, and the menu says so); the data
  directory moves independently, and must move for any test run — the default is the
  household's real `~/Library/Application Support/Waffled`.

## The runtime is a black box behind `status --json`

The app knows three things about `waffled-runtime`: where it is, its four subcommands, and
the shape of `status --json`. It must never learn more.

- **Never poll anything heavier than `status`.** It is built to be cheap —
  `bonjour.advertised` is a pidfile check, `backups.scheduleInstalled` is a `stat`. `doctor`,
  `logs` and `backup` are clicks, never timers.
- **Decode defensively, refuse only on `schema`.** The runtime adds fields without bumping it,
  so unknown keys and absent blocks are normal; a `state` word we do not recognise reads as
  `unhealthy` rather than throwing. If you find yourself adding a required field, you are
  making this app older than the runtime it will ship beside.
- **Never auto-restart in a loop.** The runtime supervises its own children. Auto-start fires
  from `stopped` only — starting on `unhealthy` is a second supervisor fighting the first —
  and **once per launch**: the first poll that *answers* spends the attempt, whatever it
  answers, so a server stopped from Terminal an hour later stays stopped. The retry after
  that is a person clicking `Start Waffled`. The one exception is a **first run**
  (`initialized: false`), where the attempt is held open while the welcome window asks; the
  click spends it.
- **The browser opens once per process, and only when someone is waiting for it**: the end
  of a first run, or a click on `Start Waffled`. Not for the auto-start — the login item
  makes one of those at every boot, and a browser window per reboot is the opposite of the
  quiet relaunch.
- **`start` has no timeout**, by design: a first `initdb` plus every migration takes minutes.
- **Never let Sparkle relaunch over a running server** — a swap over a live one leaves the
  household on the old runtime (why: `docs/product/native-mac-plan.md`, Phase 3 item 6).
  `UpdaterDelegate` postpones the relaunch until `stop` succeeds, holds it when `stop`
  refuses — the item then reads `Install the update now`, because the postponed session
  makes a fresh check a no-op — and starts the server back up if the install aborts after
  the stop.
- **`armed` is irreversible; Quit while armed always stops the server first.** All of the
  update lives in one table (`UpdateFlow.swift`): the app latches "Sparkle holds a prepared
  installer" on the first news of it and never unlatches for an ending cycle, an abort or an
  error — `Autoupdate` completes the swap on *any* termination — so `Quit anyway (server
  keeps running)` is never offered while armed, and the latch clears only where we stopped
  the server and handed the app over. Add behaviour as a row in that table, never as a flag
  in `ServerModel`.
- **Sign the app AFTER the runtime goes into it.** `xcodebuild` seals an app with no runtime
  in it, so `codesign --verify` then fails with `SecCSResourceAdded` for all 36,478 embedded
  files and `generate_appcast` refuses to publish it. `build-app.sh` re-signs at the end —
  **shallow, never `--deep`**, which is what keeps the runtime's own manifest hashes valid.

## Signing a release

`Scripts/release-mac.sh` is the only thing that signs for real, and **CI stays ad hoc** —
the certificate, the notarytool profile and the Sparkle key live in one login Keychain, and
nothing secret goes in the repo or a workflow. What CI does hold is the two cheap guards:
`plutil -lint` over every entitlements plist and `release-mac.sh --help`.

- **The order is load-bearing, innermost first, and `--deep` is never the answer.**
  Sparkle's nested code (`Downloader.xpc`, `Installer.xpc`, `Updater.app`, `Autoupdate`,
  then the framework) → every Mach-O in `Contents/Resources/runtime` → **the bundle
  manifest** → the app, shallow. Signing rewrites bytes, so the manifest is written after
  the files it hashes, and `--deep` on the app would re-sign those files again and undo it.
- **Xcode does not sign Sparkle's nested code, whatever the build settings say.** A
  Developer ID `xcodebuild` signs `Sparkle.framework` itself and leaves `Autoupdate`,
  `Updater.app` and both XPC services `Signature=adhoc`; notarization rejects the app for
  them. `release-mac.sh` signs them and then *asserts* the authority, because the
  alternative is finding out ten minutes into a 690 MB submission.
- **Find binaries by Mach-O magic, never by extension.** Postgres ships extensions as
  `.dylib`, PowerSync's native prebuilds are `.node`, and node/caddy/waffled-runtime are
  bare names in `bin/`.
- **Entitlements: the smallest set that boots, one plist per binary that needs one, under
  `Entitlements/` named for the binary.** Today that is `node.entitlements.plist` alone —
  V8 cannot reserve its code range under the hardened runtime without
  `com.apple.security.cs.allow-jit`. Add one only after watching the unentitled binary
  actually die. **Never `disable-library-validation`**: a bundled dylib signed by another
  team is a dylib we re-sign.

## Everything the menu shows is a pure function

`MenuPresentation`, `IconAppearance` and `Lifecycle` take values and return values, which is
why the whole enabled/disabled table is tested without a menu or a process. Keep new
behaviour there rather than in the view, and put process work behind
`RuntimeProcessRunning` — **no test may spawn anything**.

## Two macOS facts that shape the UI

- A `.menu`-style `MenuBarExtra` renders only Button / Toggle / Text / Divider / Menu, and
  **`.help(_:)` tooltips do not appear on its items** — an explanation has to go in the label.
- An `LSUIElement` app has **one window: the first run / error one, owned by the model and
  built by hand** (`FirstRunWindow`, an `NSHostingController` in an `NSWindow`). There is no
  window scene to hang a sheet or a `.confirmationDialog` on, and nothing brings the app
  forward on its own — `NSApp.activate(ignoringOtherApps:)` before ordering it front, or it
  opens behind whatever the person was reading. Modal questions are `NSAlert` after the same
  call.
- Menu-bar images are **monochrome templates**: state is carried by shape (outline, cooking
  holes, fill, slash), never by colour. Colour belongs to the menu's own content. The mark is
  the waffle iron drawn in `WaffleIronIcon.swift` — no SF Symbol, no asset — and its frames
  are **cached per state, frame and point size**, because the icon is asked for twice a
  second and nothing about it changes in between.

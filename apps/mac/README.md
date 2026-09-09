# Waffled for Mac — the menu-bar app

The Mac wrapper from `docs/product/native-mac-plan.md`. **It is not the Waffled UI.** The
product is the web app the server serves; this is the thing that keeps that server running,
tells you it is running, and opens it. Plex, not Photoshop.

Everything it does, `waffled-runtime` already does from Terminal — that is deliberate
(plan §3), and it is why support can always say "open Terminal and run
`waffled-runtime status`". This app polls `status --json`, draws an icon, and shells out for
the four verbs the menu offers. It holds no state of its own and knows nothing about
Postgres, PowerSync, or migrations.

```text
apps/mac/
  project.yml            # XcodeGen — the source of truth for the Xcode project
  Scripts/
    build-app.sh         # builds Waffled.app with a runtime bundle embedded
  Sources/
    WaffledApp.swift     # the MenuBarExtra scene and the menu itself
    ServerModel.swift    # the one observable object: poll, start, back up, quit
    RuntimeClient.swift  # locating waffled-runtime and running its four subcommands
    RuntimeStatus.swift  # decoding `status --json`
    MenuPresentation.swift # icon + menu as pure functions of the last status
    WaffleIronIcon.swift # the Waffled mark, drawn in CoreGraphics as a template
    FirstLine.swift      # the one-line-for-the-menu rule, shared
    LoginItem.swift      # SMAppService.mainApp
  Tests/                 # XCTest; no test spawns a process
```

## Building the app

Two commands: a runtime bundle, then an app with that bundle inside it.

```sh
infra/native/bundle/build.sh fetch                        # once — populates the cache
infra/native/bundle/build.sh build /tmp/waffled/runtime   # ~2 min; ~670 MB
apps/mac/Scripts/build-app.sh /tmp/waffled/runtime /tmp/waffled/app
```

`build-app.sh` regenerates the Xcode project if `project.yml` is newer, builds Release,
clones the bundle into `Waffled.app/Contents/Resources/runtime`, and then makes the
**embedded** supervisor verify the **embedded** bundle — `waffled-runtime version`, then
`doctor`'s manifest check over all 36,478 files and 1,338 symlinks. It is idempotent; run it
again and it replaces the app rather than nesting a runtime inside the last one.

Out comes `/tmp/waffled/app/Waffled.app`, **671 MB**, which needs nothing else on the
machine: no Homebrew, no Node, no Docker. Run it with a scratch data directory:

```sh
WAFFLED_DATA_DIR=/tmp/waffled/data \
  /tmp/waffled/app/Waffled.app/Contents/MacOS/Waffled
```

The icon appears within a second, the server starts, and the browser opens once it is green.
A first start on an empty data directory runs `initdb` and every migration — measured at
**18 s** on an M-series Mac, minutes on a slow one.

The app is **ad-hoc signed**, which is enough here and nowhere else: copy it to another Mac
and Gatekeeper will refuse to open it, because none of it is signed with a Developer ID or
notarized. That is Phase 3 item 5. Nothing re-signs the app after the bundle goes in, and
the order matters — signing rewrites Mach-O files, so a `codesign --deep` over an embedded
runtime invalidates every hash in its manifest. See the packaging note in
[`infra/native/bundle/README.md`](../../infra/native/bundle/README.md).

CI does exactly this on every PR that touches `apps/mac/`, `apps/runtime/` or the bundle
script, and then boots the assembled app with no dev-mode variables at all —
`.github/workflows/native-runtime.yml`, the `runtime-macos` job.

## Running against a runtime you are working on (dev mode)

Setting `WAFFLED_RUNTIME_BIN` points the app at a runtime it did not ship with, which is
what dev mode is: it says so in the menu, so a scratch run is never mistaken for the
household's real server. Two variables, because `--bundle` defaults to the directory above
the binary — so a binary inside a bundle needs no third variable to find it. `open` does not
pass environment, so run the executable inside the `.app` directly.

```sh
xcodegen generate && xcodebuild build -project Waffled.xcodeproj -scheme Waffled \
  -destination 'platform=macOS' -derivedDataPath /tmp/waffled/dd

WAFFLED_RUNTIME_BIN=/tmp/waffled/runtime/bin/waffled-runtime \
WAFFLED_DATA_DIR=/tmp/waffled/data \
  /tmp/waffled/dd/Build/Products/Debug/Waffled.app/Contents/MacOS/Waffled
```

| variable | what it is | required |
|---|---|---|
| `WAFFLED_RUNTIME_BIN` | path to a `waffled-runtime` — **setting this is what turns dev mode on** | no |
| `WAFFLED_RUNTIME_BUNDLE` | a runtime bundle directory, passed as `--bundle` | no — defaults to the directory above the binary, which is right when the binary is in a bundle |
| `WAFFLED_DATA_DIR` | passed as `--data`; omit to use `~/Library/Application Support/Waffled` | no |

Two things worth knowing:

- **`WAFFLED_DATA_DIR` is not a dev-mode variable.** It moves the data, not the code, and it
  applies to an embedded runtime too — which is how the assembled app is tested without
  writing into the household's real data directory.
- **The port will not be 8080** if you have the Compose stack up. The runtime takes the next
  free one and reports it. That is the runtime working, not a fault.

## The contract it depends on

`waffled-runtime status --json`, documented in
[`apps/runtime/README.md`](../runtime/README.md#status---json). The rules this app follows:

- `schema` is the only field it insists on, and it refuses anything but `1`. Everything else
  defaults, including whole blocks (`backups`, `bonjour`) a given runtime may not write.
  The runtime **adds fields without bumping `schema`**, so a build of this app must keep
  working against a runtime newer than itself.
- A `state` word it does not recognise reads as `unhealthy` — the contract promises added
  fields, not a closed vocabulary, and the honest response to "something is happening that I
  cannot describe" is the icon that asks a person to look.
- Nothing is polled but `status`. It is deliberately cheap — `bonjour.advertised` is a
  pidfile check, `backups.scheduleInstalled` is a `stat` — and anything heavier (`doctor`,
  `logs`) is a click, never a timer.

## The menu

```text
 ● Waffled is running          status only, disabled
   Open Waffled                opens urls.local; needs a running server
   Start Waffled               appears when it is stopped, or a start refused
   ─────────
   Server address: host:port   click to copy; urls.lan, else the Bonjour host
   Start at login              SMAppService.mainApp
   Back up now                 works while stopped — backup starts Postgres itself
   Check for updates…          inert until the appcast (item 6)
   Show logs                   appears only when something has gone wrong
   ─────────
   Quit Waffled                confirms, stops the server, then quits
```

The app starts the server by itself **once** per launch: the first poll that answers spends
the attempt, whatever it answers. That is deliberately not "start it whenever it is down" —
the runtime supervises its own children, and an app that restarted a server somebody had
just stopped from Terminal would be a second supervisor fighting the first. Everything after
that one attempt is `Start Waffled`, a click.

The icon is the Waffled mark: the closed waffle iron from the logo — knob, lid, base — drawn
in CoreGraphics (`WaffleIronIcon.swift`) rather than shipped as an asset, because a menu-bar
image is a monochrome template that macOS recolours, so state has to be carried by shape.
Outlined while it is stopped; the lid's six holes fill one at a time while it starts, like a
waffle cooking; solid when it is running; slashed when it needs a person. Frames are drawn
once and cached. Colour lives in the status line's dot.

**Start at login** is wired to `SMAppService.mainApp`, and it **works in an unsigned dev
build**: measured on macOS 15.7, an ad-hoc-signed `LSUIElement` app registers successfully
from a `DerivedData` path (`notRegistered → enabled → notRegistered` across
register/unregister). Neither the ad-hoc signature nor the unusual path stops launchd
adopting it, which is worth knowing because the opposite is widely assumed.

It can still be unavailable — most often `requiresApproval`, meaning someone switched
Waffled off in System Settings → General → Login Items and no amount of registering from
here overrides that. Any reason appears **in the item's own label**, because `.help(_:)`
tooltips do not render on items in a `.menu`-style `MenuBarExtra`.

The status is re-read on every status poll: it is not the app's alone to change. A
register that *fails* leaves a working toggle with the reason beside it — one refusal from
launchd is very often transient, and a control you cannot touch cannot be retried. Only two
statuses stop being a toggle: `requiresApproval`, which becomes a button that opens Login
Items, and `notFound`, which is the one disabled case.

**Quit** uses an `NSAlert`, not a sheet: an `LSUIElement` app has no window to present one
from. It stops the server first — `Stopping…`, with the actions disabled, for as long as
that takes — and if the stop *refuses*, the app stays where it is, says why, and turns the
quit item into the second question: **Quit anyway (server keeps running)**. Exiting on a
failed stop would leave the household's server up with no icon left to explain it.

## What is not here yet

Phase 3 item numbers from `docs/product/native-mac-plan.md` §7:

| missing | item |
|---|---|
| the first-run sheet (welcome → starting → ready) and the MacBook warning | 3 |
| Developer ID signing + notarization of every embedded binary, and the DMG | 5 |
| Sparkle, and a `Check for updates…` that does something | 6 |

## Building and testing

```sh
xcodegen generate                      # after adding or removing any file under Sources/
xcodebuild build -project Waffled.xcodeproj -scheme Waffled -destination 'platform=macOS'
xcodebuild test  -project Waffled.xcodeproj -scheme Waffled -destination 'platform=macOS'
```

The destination is the host Mac — there is no simulator. Always pass
`-project Waffled.xcodeproj`: `apps/ios` has a scheme with the same name, and a bare
`-scheme Waffled` from the repo root can pick the wrong one. For a whole app rather than
just the binary, use `Scripts/build-app.sh` — a copy-files build phase would re-copy 670 MB
on every incremental build of a nine-file app.

No test spawns a process. `RuntimeProcessRunning` is the seam, and the tests assert the argv
the app would really have used — the piece whose breakage looks exactly like a broken server.

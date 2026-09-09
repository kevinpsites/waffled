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
    FirstRunPresentation.swift # the first-run window's four steps, as a value
    FirstRunWindow.swift # the NSWindow that renders it — the app's only window
    Hardware.swift       # is this Mac a laptop? (hw.model + IOKit power sources)
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

The icon appears within a second. An **empty** data directory is a first run, so the setup
window opens instead of a server (see "First run" below); point it at one you have already
set up and the server starts by itself, with no window and no browser. A first start runs
`initdb` and every migration — 5.5 s on an M1 Max, 18 s measured elsewhere, minutes on a
slow Mac.

The app is **ad-hoc signed**, which is enough here and nowhere else: copy it to another Mac
and Gatekeeper will refuse to open it, because none of it is signed with a Developer ID or
notarized. That is Phase 3 item 5. Nothing re-signs the app after the bundle goes in, and
the order matters — signing rewrites Mach-O files, so a `codesign --deep` over an embedded
runtime invalidates every hash in its manifest. See the packaging note in
[`infra/native/bundle/README.md`](../../infra/native/bundle/README.md).

CI does exactly this on every PR that touches `apps/mac/`, `apps/runtime/` or the bundle
script, and then boots the assembled app with no dev-mode variables at all —
`.github/workflows/native-runtime.yml`, the `runtime-macos` job. It boots it **twice**:
once on an empty data directory, where the assertion is that nothing started (a first run
waits for a person, and a runner has nobody to click), and again after the CLI has created
the cluster, where the app auto-starts the server and `/healthz` must answer 200.

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

Two variables is the common case — pointing at a *built bundle's* supervisor. If you are
iterating on `apps/runtime` itself, **`go build` to a path outside the bundle** and set
`WAFFLED_RUNTIME_BUNDLE` as well:

```sh
go build -o /tmp/waffled/bin/waffled-runtime ./cmd/waffled-runtime   # from apps/runtime

WAFFLED_RUNTIME_BIN=/tmp/waffled/bin/waffled-runtime \
WAFFLED_RUNTIME_BUNDLE=/tmp/waffled/runtime \
WAFFLED_DATA_DIR=/tmp/waffled/data \
  /tmp/waffled/dd/Build/Products/Debug/Waffled.app/Contents/MacOS/Waffled
```

Both halves of that matter. The bundle is verified against its `manifest.json` on every
command and the manifest has **no exemption for the supervisor's own binary** — it is a
bundled file like any other — so `go build -o <bundle>/bin/waffled-runtime` breaks the very
bundle you were testing with (`changed: bin/waffled-runtime`, and nothing starts). And a
binary built outside a bundle has no bundle above it, so the `--bundle` default has nothing
to find: `WAFFLED_RUNTIME_BUNDLE` is what tells it which runtime to drive.

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

## First run

The app has exactly one window, and a household sees it once. When the **first `status` that
answers** reports `initialized: false` — no database cluster in the data directory yet — the
window opens in front of everything (an `LSUIElement` app has to activate itself, or it opens
behind the browser someone was reading) and walks three steps:

1. **Welcome.** What is about to happen and where the data will live, and one button:
   `Set up Waffled`. The auto-start is **held** while this step is up — the button is what
   starts a first run, and it spends the one attempt. Closing this window quits the app;
   nothing has been created yet to leave behind. On a **laptop** there is a plain paragraph
   here first: closing the lid puts the server to sleep for the whole house, and a Mac mini
   or a desktop is a better home. It is a warning, not a refusal.
2. **Starting.** A tick per service as Postgres, the API, Sync and Web come up, the iron
   cooking at the same cadence as the menu-bar icon, and "First start takes about a minute."
   Closing the window here stops nothing; the menu keeps showing the same progress.
3. **Ready.** "Your server is ready", the browser opens on `urls.local`, and the window
   closes itself two seconds later.

A start that refuses replaces all of it with the error step: the runtime's own sentence,
`Try again`, and `Show logs`.

**Seeing it again** is a fresh `WAFFLED_DATA_DIR` — that is the whole trigger, so point the
app at an empty directory and the window is back. Every other launch gets **no window and no
browser**: the app starts the server if it is down, the icon goes green, and nothing takes
over the screen. The browser opens once per process and only when somebody is waiting for
it — the end of a first run, or a click on `Start Waffled` — which is what makes `Start at
login` bearable: a Mac that reboots at 3 a.m. does not come back with a browser window open.

While the welcome step waits, the menu says **`Waffled is not set up yet`** and offers
`Start Waffled`; starting from there counts as the same click.

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
on every incremental build of an eleven-file app.

No test spawns a process. `RuntimeProcessRunning` is the seam, and the tests assert the argv
the app would really have used — the piece whose breakage looks exactly like a broken server.

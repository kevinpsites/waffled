# Waffled for Mac — the menu-bar app

The Mac wrapper from `docs/product/native-mac-plan.md`. **It is not the Waffled UI.** The
product is the web app the server serves; this is the thing that keeps that server running,
tells you it is running, and opens it. Plex, not Photoshop.

Everything it does, `waffled-runtime` already does from Terminal — that is deliberate
(plan §3), and it is why support can always say "open Terminal and run
`waffled-runtime status`". This app polls `status --json`, draws an icon, and shells out for
the six subcommands the menu and its two screens need — `start`, `stop`, `status`,
`backup`, `config`, `move`. It holds no state of its own and knows nothing about Postgres,
PowerSync, or migrations.

```text
apps/mac/
  project.yml            # XcodeGen — the source of truth for the Xcode project
  Scripts/
    build-app.sh         # builds Waffled.app with a runtime bundle embedded
    make-appcast.sh      # signs a directory of releases into a Sparkle appcast
  Sources/
    WaffledApp.swift     # the MenuBarExtra scene and the menu itself
    ServerModel.swift    # the one observable object: poll, start, back up, quit
    Updater.swift        # Sparkle: the check, and the stop before the relaunch
    UpdateFlow.swift     # the update state machine — armed until we hand the app over
    Updates.swift        # which way a version crossing went; the feed-URL seam
    RuntimeClient.swift  # locating waffled-runtime and running its six subcommands
    RuntimeStatus.swift  # decoding `status --json`
    MenuPresentation.swift # icon + menu as pure functions of the last status
    FirstRunPresentation.swift # the first-run window's five steps, as a value
    FirstRunWindow.swift # the NSWindow that renders it — the app's only window
    SettingsPresentation.swift # the same rows after setup, as a value
    SetupOptions.swift   # what "Where things go" collects, and the argv it owes
    Setup.swift          # which volumes may hold a household's data
    SetupTheme.swift     # the setup window's palette and type
    QRCode.swift         # the ready step's code, via CoreImage
    LogTail.swift        # the last line of a log, for the setting-up step
    Hardware.swift       # is this Mac a laptop? (hw.model + IOKit power sources)
    WaffleIronIcon.swift # the Waffled mark, drawn in CoreGraphics as a template
    FirstLine.swift      # the one-line-for-the-menu rule, shared
    LoginItem.swift      # SMAppService.mainApp
    Assets.xcassets/     # the app icon — Finder, Dock, NSAlert and Sparkle draw it
                         # (the menu-bar glyph is not from here: see WaffleIronIcon)
                         # every slot is drawn from resources/waffled.png (1254px)
                         # onto Apple's icon grid — rounded square, inset, shadowed
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

That app is **ad-hoc signed**, which is enough here and nowhere else: copy it to another Mac
and Gatekeeper will refuse to open it. A release is `Scripts/release-mac.sh` (see
[Releasing](#releasing)), which signs the same tree with a Developer ID and notarizes it.
Either way the app is re-signed **after** the bundle goes in, and the order matters —
signing rewrites Mach-O files, so a `codesign --deep` over an embedded runtime invalidates
every hash in its manifest. See the packaging note in
[`infra/native/bundle/README.md`](../../infra/native/bundle/README.md).

CI does exactly this on every PR that touches `apps/mac/`, `apps/runtime/` or the bundle
script, and then boots the assembled app with no dev-mode variables at all —
`.github/workflows/native-runtime.yml`, the `runtime-macos` job. It boots it **twice**,
because a first run and every launch after it are now different launches. First on an empty
data directory, where the assertion is that the app starts nothing — the welcome window is
asking, and a runner has nobody to click — after which the CLI plays the button (`start`)
and `/healthz` must answer 200 with the app still watching. Then again on that same, now
set-up directory, where the app's own auto-start has to bring the server back up with no
`start` of ours.

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

Three things worth knowing:

- **`WAFFLED_DATA_DIR` is not a dev-mode variable.** It moves the data, not the code, and it
  applies to an embedded runtime too — which is how the assembled app is tested without
  writing into the household's real data directory.
- **The port will not be 8080** if you have the Compose stack up. The runtime takes the next
  free one and reports it. That is the runtime working, not a fault.
- **A dev run installs no login item and no nightly backup**, whatever the setup screen's
  toggles say. launchd holds exactly one nightly backup per Mac under a global label, so a
  run against a scratch data directory would take the household's real schedule over and
  point it at `/tmp`; a login item would register whichever build happens to be running to
  start the Mac at every login. The `config set` writes still happen — they land in the
  scratch data directory the run was given, which is where they belong.

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
   Settings…                   the options screen again; off while the first-run
                               window has the app's one window
   Check for updates…          Sparkle; stops the server before it relaunches
                               (reads `Install the update now` while one is held)
   Show logs                   appears only when something has gone wrong
   ─────────
   Quit Waffled                confirms, stops the server, then quits
                               (its words change when a stop has refused)
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
behind the browser someone was reading) and walks five steps:

1. **Welcome.** The three promises, the versions of Postgres, the server, Sync and the web
   build that are **really inside this app** — read from the bundle's own manifest by way of
   `status`, which answers with everything stopped — and three actions: `Set up Waffled`,
   `Not on this Mac`, and `Settings first…`. The auto-start is **held** while this
   step is up: the button is what starts a first run, and it spends the one attempt. Closing
   this window quits the app; nothing has been created yet to leave behind. On a **laptop**
   there is a plain paragraph here first: closing the lid puts the server to sleep for the
   whole house, and a Mac that stays awake is a better home. It is a warning, not a refusal.
2. **Where things go.** Everything on this screen is applied **before** the first `start`, so
   the first boot already uses the folder, the port and the name that were chosen. Four of
   the rows are drawers (`SettingsDrawer`): collapsed, each says what is in force;
   `Change…` opens it and becomes `Done`.
   - **Waffled's files** — a folder picker, restricted to this Mac's own **internal** disk
     and to APFS or Mac OS Extended. A removable drive, a network folder or an ExFAT volume
     is refused in the row itself, with the reason. Once a data directory has been
     initialized the row stops offering `Change…` and offers `Reveal in Finder` instead:
     moving it afterwards is a migration, and that is not in this release.
   - **Nightly backup** — on or off, one of four times, and how many to keep (7/14/30/90).
     `--keep` is passed only when it is not 14, the runtime's own default. Off installs
     nothing rather than uninstalling something (this runs on a Mac with nothing of ours on
     it yet), and `Back up now` in the menu still works.
   - **Address on your network** — this Mac's name, its IP address, or a name the household
     set up themselves, plus the preferred port. The address is always written as
     `WAFFLED_PUBLIC_HOST`, because an absent one means "keep the address this install has
     always had" and a first run has none. `HTTP_PORT` is written only when someone chose a
     port that is not the default: it is the preference for the first allocation, so an
     assignment nobody asked for would put a number on record they never chose.
   - **Smart suggestions** — a segment: Not now, Claude (`ANTHROPIC_API_KEY`),
     OpenAI-compatible (`OPENAI_API_KEY`, plus `OPENAI_BASE_URL` when it is not OpenAI) or
     Ollama (`OLLAMA_HOST`). Choosing Ollama asks `<host>/api/tags` once — never on a timer —
     and says whether it answered and with which models (`OllamaProbe`). These only make a
     provider *available*: which one a household uses is chosen in the web app.
   - **Start Waffled when this Mac starts up** — the login item.
3. **Setting up.** A tick per service as Postgres, the API, Sync and Web come up, each under
   a two-line label, with a progress bar, an elapsed clock and the last line the runtime
   wrote so that a slow start shows something moving. `Show logs` is here. The step stays up
   for **at least three seconds** even when the start beats it — a first start can finish in
   under five seconds, and a checklist that appears and vanishes inside one animation frame
   is how "nothing showed" gets reported about a setup that worked. Closing the window stops
   nothing; the menu keeps showing the same progress.
4. **Ready.** The address the runtime composed, the IP form beside it when that is something
   different to say, a QR code of the URL for a phone's camera, and — quietly, when the two
   differ — `Using port N because M was busy on this Mac`. Two buttons: `Copy address`, and
   `Open Waffled`, which is the click that opens the browser.
5. **The error sheet.** A start that refuses replaces all of it: the runtime's own sentence,
   `Try again`, and `Show logs`.

**Seeing it again** is an uninitialized data directory and nothing else, so point the app at
an empty one with `WAFFLED_DATA_DIR` and the window is back. (The environment always wins
over the folder a setup screen chose and remembered, which is what keeps a dev run off the
household's real directory.) Every other launch gets **no window and no
browser**: the app starts the server if it is down, the icon goes green, and nothing takes
over the screen. The browser opens once per process and only when somebody is waiting for
it — a click on `Open Waffled` on the ready step, or on `Start Waffled` in the menu — which
is what makes `Start at login` bearable: a Mac that reboots at 3 a.m. does not come back
with a browser window open.

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

The one exception is a refused stop with an **update already downloaded**: leaving is then
the one thing the app must not offer, because Sparkle's installer swaps `Waffled.app` the
moment this process exits, whatever the reason (see "Updates"). The item reads **Quit — stop
the server first (an update will install on quit)** and is disabled; `Install the update now`
retries the stop, and `waffled-runtime stop` in Terminal is the way out if it keeps refusing.

## Settings

`Settings…` puts the **same five rows** the first run showed back in the app's one window,
on a Mac where Waffled already lives, as its **Basic** tab. Literally the same view —
`SetupOptionRows`, bound to the same `model.setupOptions` — so there is one place where a
row's label, control and validation live. What differs is the frame (`SettingsPresentation`
rather than `FirstRunPresentation`) and what three of the rows may do.

**Advanced** and **Diagnostics** are `SettingsCatalog`: a curated list of api settings, each
one a key the runtime forwards (`services.go` `passthroughKeys`) or reads itself
(`LOG_LEVEL`, `LOG_FORMAT`). It is deliberately not a free-form `KEY=VALUE` table — a key
outside the allowlist is written to `config.env` and reaches nothing — and
`SettingsCatalogTests` reads `passthroughKeys` out of the runtime's source and fails if the
app can write a key nothing reads. Add a key to the runtime's allowlist first, then here.
Blank is the api's default (shown as the placeholder), and a cleared field writes an empty
value, which the runtime forwards as nothing. Secret fields (client secrets) behave like the
provider key: blank means unchanged, and they are never remembered.

**Only the difference is applied.** `SetupOptions.commandsForChange(from:)` diffs the
working copy against what was applied last and emits just that. The first run's
`commandsBeforeFirstStart` writes everything, which is right exactly once; doing it on every
Apply would put preferences on record that nobody expressed, and that is how `HTTP_PORT`
came to move a published port.

The rules that fall out of that, and each has a test:

- **The port is read-only here**, shown on Advanced. `HTTP_PORT` is the preference for the
  *first* allocation and nothing after it, so a field would be a control that silently did
  nothing. The row shows the running port and says where a port is really moved.
- **A blank provider-key field means "unchanged".** The key is never read back out of
  `config.env` — `config set` is write-only by design — so the field opens blank every time.
  Reading blank as a deletion would turn the suggestions off for anyone who came to change
  the backup time. Choosing **Not now** is the deletion: it clears all three credentials.
- **Every `config set` waits for a restart.** The runtime builds the api's environment when
  it starts it, and the api reads its keys once — provider keys included. Only the nightly
  backup and the login item take effect straight away.
- **`--keep` is stated only when the retention is what changed** — including a change back
  to 14, because re-installing without it keeps whatever the plist already says.
- **The backup toggle uninstalls when it goes off.** On the first run, off installs nothing
  because there is nothing of ours on the Mac yet; here there is. A dev run still touches the
  schedule in neither direction — launchd's label is global, so one Mac holds exactly one.

What was applied is remembered through the injected `UpdateMemory`, not read back from
`config.env`, and decoded field by field so preferences written before a field existed still
come back. Secrets are deliberately excluded (`SetupOptions.CodingKeys`): they belong in
owner-only `config.env`, not in the app's preferences file. The accepted cost: a value
someone hand-edits into `config.env` is not what Settings shows.

### Moving the data directory

The panel opens beside the folder Waffled is in, so the likeliest pick is that folder or its
parent — both resolve to where Waffled already is, and the drawer says so and stops nothing.
Otherwise the folder row's `Move…` is `ServerModel.moveDataDirectory(to:)`: stop, then
`waffled-runtime move --to`, then repoint the client at the new folder, then start. That
order is load-bearing — the runtime refuses to move a running cluster, and the `--data` the
move is told about is the folder being moved **from**. The destination is checked with the
same `Setup.refusal(for:)` the first run uses, because the volume rules are identical.

The runtime removes the old folder only once the copy has arrived, and the app keeps showing
the folder `status` reports rather than the one it asked for — so a move that fails leaves
both the household and the row where they were. See `apps/runtime/README.md` for what the
command itself refuses and why.

## Updates

Waffled updates as one unit, Plex-style: **Sparkle 2 swaps the whole `Waffled.app`, runtime
bundle and all** (`docs/product/native-mac-plan.md` §6). There is no separate runtime
updater, no binary-swap step and no second copy of the old bundle on disk, because **a
`start` from the newer bundle *is* the update** — the new runtime opens the existing data
directory, snapshots it, migrates it, gates on health and rolls back if that fails, all of
which it already does (`apps/runtime/README.md`).

What has to be true for that to work is the one rule this app adds:

```text
check → download → ask → STOP THE SERVER → swap the .app → relaunch → auto-start migrates
```

A relaunch over a *running* server would leave the household on the old runtime, and the
relaunched app would never notice (why, at length: `docs/product/native-mac-plan.md`,
Phase 3 item 6). The updater therefore **postpones Sparkle's relaunch until
`waffled-runtime stop` succeeds**, and if the stop *refuses*, the relaunch is held: the icon slashes, the menu says
`Could not stop Waffled: …`, and the update item becomes **`Install the update now`**, which
tries the stop again with the install Sparkle handed over. (It has to be that item rather
than an ordinary check: Sparkle counts the postponed session as still in progress, so
`Check for updates…` would do nothing until the app relaunches.) It is
the same rule as quit, for the same reason. Quit obeys it too, and has to: once the
installer has been prepared it finishes the swap when this process exits, for **any**
reason, so with an update armed a refused stop disables quitting outright rather than
offering "Quit anyway".

**"Armed" is decided by Sparkle, not by what the app is holding.** The moment Sparkle has
extracted and validated the new app, `Autoupdate` has done stage 1 and is listening for this
process to exit; from then on it finishes the swap on *any* termination — an abort, the
alert's **Install on Quit**, a crash, a force quit. So the app latches "armed" on the
earliest news of it (`didExtractUpdate`) and never unlatches: not for an ending cycle, not
for an abort, not for an error. It clears in one place, once the server is really down and
the app has been handed over. All of that is one state machine, `UpdateFlow.swift`, whose
(phase, event) table is the whole rule. If the install aborts
*after* that stop — a signature that does not check out, an authorisation someone declined —
the app starts the server back up and says why, rather than leaving the household with
neither a server nor an update.

The feed is `https://github.com/kevinpsites/waffled/releases/latest/download/appcast.xml` —
GitHub serves the latest release's assets at that stable path, so the URL never names a
version. Checks run daily and on the menu item; **installing always asks**, because it stops
the household's server for as long as the swap and the migrations take.

**The version Sparkle compares is `CFBundleVersion`**, not the marketing string, so this
app's `CFBundleVersion` follows `MARKETING_VERSION` (`project.yml`), which `./waffled
release` bumps along with api, web, compose and iOS. It refuses to release while any of
them disagree, and `release-mac.sh` refuses to build a DMG whose name does not match this
file — a release Sparkle cannot tell from the last one is the failure both of those exist
to prevent.

After an update the menu says so once — `Updated to 0.15.0`, or `Rolled back to 0.14.3` if
you re-installed an older DMG, which is the supported way back from a bad release. The
direction is worked out from `bundle.previousVersion` in `status --json`; the runtime
deliberately reports no direction of its own.

### The signing key

Updates are trusted by **EdDSA signature, not by URL**: the public half is `SUPublicEDKey`
in `project.yml`, and the private half lives in one person's login Keychain.

> **Back it up.** `generate_keys -x <file>`, to somewhere outside this repo. Losing that key
> strands every installed copy of Waffled on the version it already has — the app will
> refuse anything it cannot verify, and no new key can rescue an app that has shipped.

`generate_keys` and `generate_appcast` ship inside the Sparkle package, so resolving it once
puts them in DerivedData:
`~/Library/Developer/Xcode/DerivedData/*/SourcePackages/artifacts/sparkle/Sparkle/bin/`.

### The appcast itself

```sh
apps/mac/Scripts/make-appcast.sh <dir-of-dmgs-or-zips> [out]
```

It finds `generate_appcast`, refuses early if the Keychain has no key, and signs every
archive in the directory into `appcast.xml`. Set `WAFFLED_DOWNLOAD_URL_PREFIX` to the URL
the archives will live at. `Scripts/release-mac.sh` calls this with the release's own
GitHub download prefix; nothing in CI does.

Expect **~3 minutes** per release: it extracts and hashes the whole 671 MB archive. Two
things that happened while it was first used here, in case they happen to you:

- The first run signed with no interruption; later ones **stopped dead at 0% CPU** with
  nothing on stdout and a `SecurityAgent` process alive beside them. That is what a Keychain
  authorisation dialog looks like from a terminal — so if it hangs, go and look at the
  screen. A headless shell cannot answer one.
- **Killing it mid-extraction poisons its cache.** The next run dies in `ditto` with
  `No such file or directory`; `rm -rf ~/Library/Caches/Sparkle_generate_appcast` and start
  again.

It also refuses an app that fails Apple's code-signing checks — which is why `build-app.sh`
**re-signs the app after embedding the runtime**. `xcodebuild` sealed an app that did not
contain a runtime yet, so its `CodeResources` listed none of those 36,478 files and
`codesign --verify` failed with `SecCSResourceAdded` for every one. The re-sign is shallow
on purpose: it rewrites the app's own executable and `_CodeSignature` and leaves the
Mach-O files inside `Resources/runtime` — and their manifest hashes — alone.

### Trying an update without publishing one

`WAFFLED_APPCAST_URL` overrides the feed for one run. It is honoured in every build, not
just a debug one, because it is **not** a security boundary — the EdDSA key is, and an
update from any URL still has to satisfy it.

```sh
S=/tmp/waffled           # scratch: bundle, both apps, the feed
infra/native/bundle/build.sh build $S/runtime

apps/mac/Scripts/build-app.sh $S/runtime $S/a                        # version A (current)
WAFFLED_APP_VERSION=0.15.0 apps/mac/Scripts/build-app.sh $S/runtime $S/b   # version B

mkdir -p $S/feed && ditto -c -k --keepParent $S/b/Waffled.app $S/feed/Waffled-0.15.0.zip
WAFFLED_DOWNLOAD_URL_PREFIX=http://127.0.0.1:8117/ \
  apps/mac/Scripts/make-appcast.sh $S/feed
( cd $S/feed && python3 -m http.server 8117 )   # in another terminal

WAFFLED_APPCAST_URL=http://127.0.0.1:8117/appcast.xml \
WAFFLED_DATA_DIR=$S/data \
  $S/a/Waffled.app/Contents/MacOS/Waffled
```

Then `Check for updates…` in the menu. `Waffled: Sparkle found version 0.15.0 in the
appcast` in the app's output — and a `GET /appcast.xml` in the http.server log — is the
check working; the rest is Sparkle's own dialog. Installing from it is the step worth
watching by hand: the server stops, the app is replaced, and the relaunched app brings the
*new* runtime up against the *same* data directory.

`WAFFLED_APP_VERSION` is only for this: it overrides `MARKETING_VERSION` for one
`build-app.sh` run. The real version lives in `project.yml` and is bumped by
`./waffled release`.

## Releasing

Two commands, in this order, and the second only runs on the Mac that holds the keys.

```sh
./waffled release 0.15.0                 # anywhere: versions, changelog, tag, push
apps/mac/Scripts/release-mac.sh 0.15.0   # the signing Mac: DMG, notarization, upload
```

`./waffled release` bumps `project.yml`'s `MARKETING_VERSION` (which `CFBundleVersion`
follows, which is what Sparkle compares) alongside api, web, compose and iOS, and refuses to
release while any of them disagree. Then `release-mac.sh` asserts that version against
`project.yml`, builds the runtime bundle and the app, signs everything, notarizes and
staples the app **and** the DMG, generates the appcast, and uploads both to the GitHub
Release the tag created — waiting for that Release to exist, since the tag push is what
makes it. Options: `--no-upload`, `--no-notarize`, and `--adhoc` for an unsigned DMG you
can only test locally. `--help` lists them.

Signing settings come from **`~/.config/waffled/signing.conf`** — see
[`signing.example.conf`](signing.example.conf). It holds names only (the identity, the team,
the notarytool profile); the certificate's private key, the notarization password and the
Sparkle EdDSA key all live in the login Keychain, which is why this is a local command and
not a workflow. Environment variables of the same name override the file, and with neither
the build is ad hoc — which is what CI does, deliberately.

**The first `codesign` of a session may raise a Keychain dialog.** A headless shell cannot
answer one, so a run that appears to hang at 0% CPU is a dialog waiting on the screen. Click
*Always Allow* once.

`dist/` (gitignored) holds `runtime/` (the bundle this release was built from), `app/`
(the signed, notarized, stapled `Waffled.app` and its DerivedData) and `release/v<version>/`
— the two files that get uploaded, `Waffled-<version>.dmg` and `appcast.xml`. One directory
per version: `make-appcast.sh` signs a whole directory, so a shared one would re-point every
DMG it ever built at the current tag. Every step replaces what it wrote last time *for that
version*, so a run that failed at notarization can simply be run again.

The signing order is not adjustable; the reasoning is in
[`CLAUDE.md`](CLAUDE.md#signing-a-release).

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

The **first** build after a clean checkout resolves Sparkle from GitHub (~20 s; XcodeGen
only writes the package reference — `xcodegen generate` itself downloads nothing). Pass
`-clonedSourcePackagesDirPath` to share one checkout between several `-derivedDataPath`s.

No test spawns a process, and none of them touch Sparkle. `RuntimeProcessRunning` is the
seam, and the tests assert the argv the app would really have used — the piece whose
breakage looks exactly like a broken server.

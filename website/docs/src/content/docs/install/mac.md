---
title: Mac install
description: Download Waffled for Mac, run the family server natively, and keep it updated — no Docker, no Terminal.
---

**Waffled for Mac** is the whole server in one download. Drag it to Applications, open it,
and a menu-bar icon runs Postgres, the api, PowerSync and Caddy for you — no Docker, no
Homebrew, no Terminal. The app is *not* the Waffled interface: the interface is the web app
it serves, exactly as it is on a Docker install. Think Plex.

Everything the app does you can also do from Terminal (`waffled-runtime status`), and
everything the [Docker install](/install/docker/) does, this does — same api, same
migrations, same PowerSync, same web build. Only the packaging differs.

## Requirements

- **A Mac with Apple silicon** (M1 or later). There is no Intel build yet.
- **macOS 14 Sonoma or later.**
- **~1 GB of disk** for the app — a ~300 MB download that unpacks to ~700 MB, because it
  carries Postgres, Node, Caddy and PowerSync inside it — plus room for your household's
  data and backups.
- **A Mac that stays awake.** This is a server: the kitchen tablet and everyone's phone
  reach it whenever it is on. A **Mac mini or a desktop** is the right home. A MacBook works
  and the app will let you use one, but closing the lid puts the household's server to sleep
  — the first-run window says so on a laptop.

## Download and install

1. **[Download Waffled for Mac](https://github.com/kevinpsites/waffled/releases/latest/download/Waffled.dmg)**
   — always the latest version. Older versions are on the
   [releases page](https://github.com/kevinpsites/waffled/releases).
2. Open it and drag **Waffled** onto the **Applications** folder in the same window.
3. Open Waffled from Applications.

The app is signed with a Developer ID and notarized by Apple, so there is **no Gatekeeper
warning** — no "unidentified developer", no right-click-Open trick, no
`xattr -d com.apple.quarantine`. macOS may say "Waffled is an app downloaded from the
Internet. Are you sure you want to open it?" the first time, which is the ordinary
first-launch question and takes one click.

## First run

A menu-bar icon appears within a second — the Waffled iron, outlined while nothing is
running. Because there is no household yet, a **setup window** opens in front of everything
and asks before it sets one up.

### 1. Welcome

What Waffled is, which versions of the database, the server, sync and the web app are
already inside the download, and three ways on: **Set up Waffled**, **Settings first…**,
or **Not on this Mac**. Closing this window quits — no database, no household. On a
laptop there is a paragraph about the lid here: close it and the household's server sleeps
with it.

The defaults are sensible, so **Set up Waffled** is a fine answer: Waffled's files in
`~/Library/Application Support/Waffled`, a nightly backup at 3:00 AM, this Mac's IP address
as the address, port 8080, and Waffled starting whenever the Mac does. **Settings first…**
is how you change any of that — or anything else `Settings…` has — first.

### 2. Where things go

The same three tabs as `Settings…`: **Basic** (the rows below), and **Advanced** and
**Diagnostics** — sign-in, calendar sync, AI limits, rate limits and logging, described in
[Changing settings later](#changing-settings-later). Everything on all three is applied
**before** the first start, so that start already uses it — nothing to restart into
afterwards. On Basic, each row says what is in force; **Change…** opens it and **Done**
closes it again.

- **Waffled's files.** Where the database, your photos and every backup live. It has to be a
  folder on this Mac's own internal disk, formatted APFS or Mac OS Extended — an external
  drive somebody can unplug, or a network folder, is not somewhere a running database can
  live, and the window says so if you pick one — as it does if it cannot write there.
  Waffled makes a **Waffled** folder inside whatever you pick, so choosing your Documents
  folder does not scatter a database through it. Wandered off to another folder and want
  the default back? **Use the default folder** does that — the folder window cannot show
  it, because macOS hides `~/Library`. You can move it later from `Settings…` — see
  [Moving Waffled's files](#moving-waffleds-files) — but picking it now avoids the copy.
- **Nightly backup.** On, at 3:00 AM, unless you say otherwise — 1:00 AM, 3:00 AM, 5:00 AM
  or noon — noon is there for a Mac that sleeps at night. **Keep the last** 7, 14, 30 or 90
  backups (14 unless you change it); the oldest goes when a new one arrives. Switching it
  off schedules nothing; **Back up now** in the menu still works whenever you want it. A
  backup holds the database — your photos stay in Waffled's folder.
- **Address on your network** — how the kitchen tablet and everyone's phones reach this Mac.
  - **Its IP address**, the default: it works on every network. If your router hands this
    Mac a different one later, devices need the new address — a DHCP reservation on the
    router keeps it the same.
  - **This Mac's name**, a `.local` name that stays put when the IP changes, but some
    networks do not resolve `.local` names.
  - **A name I've set up myself**, such as `waffled.home`. You have to have made that name
    point at this Mac yourself — a DNS entry on your router, or a real domain aimed at this
    Mac's address. Waffled does not create it.
  - **Port**, 8080 unless you change it. Waffled *prefers* the port you name and takes the
    next free one if something else on this Mac already answers there. Pick 1024 or above
    — ports below that need an administrator, and Waffled does not run as one.

  Whichever you pick, Waffled serves plain **HTTP** on your own network. A nicer name is a
  nicer address, not HTTPS — there is no certificate, and none of this puts Waffled on the
  public internet.
- **AI settings** *(optional)* — meal ideas and week planning, from a provider you
  choose: **Not now** (Waffled's built-in parser, no account needed), **Claude** (an
  Anthropic key), **OpenAI-compatible** (a key, plus a server address if it is not OpenAI
  itself — LM Studio, vLLM and the like), or **Ollama** (its address; Waffled checks
  whether Ollama answers there and lists the models it has). The key is stored on this Mac
  only, in Waffled's own config. Adding one makes that provider *available*; you pick which
  one Waffled uses in the web app, under **Settings → AI & Capture**.
- **Start Waffled when this Mac starts up.** On, and worth leaving on: the tablet and the
  phones expect the server to be there.

### 3. Setting up

A tick per service as the database, the server, sync and the web app come up, with a
progress bar and the last line of the log underneath. The first start creates the database
and runs every migration, so **give it a minute** — longer on an older Mac. You can close
this window: it carries on without it, and the menu-bar icon shows the same progress.

### 4. Ready

The address to type into the kitchen tablet, a **QR code** to point a phone's camera at,
and — when you chose a name rather than the IP address — the plain IP address underneath,
which is the one to use if a device cannot find the name. If the port you asked for was
busy, a line here says which port Waffled took instead.

**Copy address** puts it on the clipboard. **Open Waffled** opens the web app in your
browser, where Waffled's own setup wizard creates your household and the first adult,
exactly as on Docker.

### If a start goes wrong

The window says what happened in the runtime's own words, and offers **Try again** and
**Show logs**.

Every launch after that gets **no window and no browser**. The app finds the existing data
directory, brings the server back up, and the icon goes solid.

## The menu

| Item | What it does |
|---|---|
| ● *status line* | Running, starting, stopped, or the runtime's own words when something needs a person. |
| **Open Waffled** | Opens the web app. |
| **Start Waffled** | Appears when the server is down, or when a start refused. |
| **Server address** | `host:port` for the kitchen tablet and the iOS app — click to copy. |
| **Start at login** | Brings the server back after a reboot, with no browser window. |
| **Back up now** | A `pg_dump` into `backups/`. Works even while the server is stopped. See [Backups](#backups). |
| **Settings…** | The setup screen again, plus Advanced and Diagnostics. See [Changing settings later](#changing-settings-later). |
| **Check for updates…** | See [Updating](#updating). |
| **Show logs** | Appears only when something has gone wrong. |
| **Quit Waffled** | Confirms, **stops the server**, then quits. |

Quitting stops the household's server — that is what the confirmation is about. If you want
the server up without the icon, leave the app running; that is what `Start at login` is for.

## Where your data lives

```text
~/Library/Application Support/Waffled/
  config.env      your secrets, 0600 — the same variables as a Docker .env
  postgres/       the database
  media/          uploaded photos and files
  backups/        pg_dump output
  logs/           one file per service
```

Three things worth knowing:

- **`postgres/` is excluded from Time Machine**, deliberately: restoring a live database
  directory file-by-file corrupts it. `backups/` **is** backed up, which is the copy you
  would actually restore from.
- **The folder is chosen at setup and can be moved afterwards**, from `Settings…` →
  *Move…*. Everything above moves with it. See [Moving Waffled's files](#moving-waffleds-files).
- Everything lives under your own user account — nothing is installed system-wide, and
  nothing asks for an admin password. Turn FileVault on if it isn't already; that is what
  protects `config.env` on a machine somebody could walk off with.

## Changing settings later

`Settings…` in the menu opens on a Mac where Waffled is already running, in three tabs
with one **Apply** between them. Only what you actually changed is applied, so opening the
screen and closing it does nothing at all.

**Basic** is the setup screen's rows again:

| | Takes effect |
|---|---|
| **Nightly backup** — on or off, the hour, and how many to keep | Straight away. Turning it off removes the scheduled job. |
| **Address on your network** — its IP, this Mac's name, or a name you set up | After a restart. |
| **AI settings** — the provider, its key or address | After a restart. The key field is always blank when the screen opens — Waffled never reads your key back out of `config.env` — so leaving it blank means "don't change it", not "delete it". Choosing **Not now** is how you remove saved keys. |
| **Start when this Mac starts up** | Straight away. |
| **Waffled's files** | See [below](#moving-waffleds-files). |

**Advanced** is for households running their own sign-in, calendar sync or AI. Leave a
field blank and Waffled uses the default shown in it; each field shows the `config.env`
variable it writes, matching the [environment variables](/install/environment-variables/)
Docker uses.

- **AI model and limits** — the default model for each provider (the web app can still
  choose another per household), how long to wait for an answer, and how many times to retry.
- **Calendar sync** — your own Google and Microsoft OAuth apps: client ID, client secret
  (never shown back) and the redirect address registered on the app.
- **Sessions and sign-in** — how long sign-in tokens last, how many days people stay signed
  in, the break-glass **Always show the password form**, the address single sign-on
  returns to, and the app's sign-in callback.
- **Rate limits** — how many tries the sensitive routes allow (setup, sign-in, single
  sign-on, kiosk pairing, photo uploads) before they make someone wait. The time windows
  are built in; only the counts change.
- **Address and ports** — the address and the port in use, shown but not changeable (see
  below).

**Diagnostics** sets how much the server writes to `api.log` — everything, normal,
warnings, or errors only — and in which format: structured JSON, or readable text (easier
to scan, but its lines carry no timestamp). **Show logs** opens the logs folder.

Everything on Advanced and Diagnostics takes effect **after a restart**. Whenever something
you applied is waiting for one, the screen says so and **Apply** becomes **Restart
Waffled** — nothing is lost by waiting, and anything already pointed at this Mac keeps
working.

**The port is shown but cannot be changed here.** Waffled picked it at setup and every
phone, tablet and bookmark in the house points at it, so moving it is a job that has to
tell them first. To move it deliberately, quit Waffled and edit `ports.public` in
`runtime.json` in the folder above.

Some things you may have seen in a design for this screen are **not here yet**, because
nothing would act on them: a separate folder for photos or for backups, copying backups
offsite from the Mac, OpenTelemetry, and a beta update channel. On a Mac, copy `backups/`
somewhere else yourself for now.

## Moving Waffled's files

`Settings…` → *Move…* takes everything — the database, your photos and every backup — to
another folder on this Mac. Like every other setting, choosing the folder changes nothing
yet: the row says where it will go, **Keep it where it is** changes your mind, and
**Apply** does it — any other settings you changed first, then Waffled stops the server,
copies, and starts it again. The window says **Moving…** while it works and "Moved, and
Waffled restarted." when it is done. Once it lives anywhere but
`~/Library/Application Support/Waffled`, *Move to the default folder* appears beside it,
with that path underneath, and chooses it the same way — the folder window cannot, because
macOS hides `~/Library`.

Four things to know before you click it:

- **The new folder must be empty and on a disk that stays plugged in**, formatted APFS or
  Mac OS Extended. An external drive that could be unplugged, or a network folder, would
  mean no server; Waffled refuses those — and a folder with anything in it — as soon as you
  choose one, before anything stops.
- **Nothing is deleted until the copy has arrived.** If anything goes wrong — the disk
  fills up, the drive disappears — your household is still in the old folder, untouched.
- **It needs room for a second copy** while it runs, plus a little headroom. Waffled
  checks first and tells you if there isn't enough.
- **The nightly backup moves with it**, at the same time and keeping the same number. If it
  cannot — or the old folder cannot be removed — the window says so beside "Moved".

If you would rather do it from Terminal, it is the same command underneath:

```sh
/Applications/Waffled.app/Contents/Resources/runtime/bin/waffled-runtime move \
  --to /Volumes/Big/Waffled --dry-run
```

Drop `--dry-run` to do it. Quit Waffled first — it refuses to move a running server.

## Backups

Waffled backs up **every night** — at 3:00 AM unless you chose another time during setup —
into `backups/`. `Back up now` in the menu writes one on demand, and works even while the
server is stopped. Waffled also takes one **before every migration**, so an update that goes
wrong has something to roll back to.

To change the time or how many it keeps, or to switch it back on, use **Settings…** —
**Nightly backup** on the Basic tab — and **Apply**. From Terminal it is:

```sh
/Applications/Waffled.app/Contents/Resources/runtime/bin/waffled-runtime backup \
  --install-schedule --at 01:00
```

`--at` is 24-hour local time and defaults to `03:00`; add `--keep 30` to keep the last 30
instead of 14. Leaving either flag out keeps what the installed schedule already says, so
running this again changes only what you name. `--uninstall-schedule` removes the schedule.
One Mac keeps one nightly backup. Settings does not see a change made from Terminal, and
**Back up now** keeps the number Settings shows, even with the nightly backup off — so if
you use the app, change the number there. `waffled-runtime backup` on its own keeps the same
number the nightly backup does.

A backup on the same Mac survives a mistake, not a fire. Copy `backups/` somewhere else —
another disk, or a cloud folder — yourself; the Mac app does not upload backups anywhere.
A backup holds the database only, so copy `media/` too if your photos matter.

### Restoring a backup

There is no menu item for this yet — it is one command, and it **replaces everything in
the database** with the backup:

```sh
/Applications/Waffled.app/Contents/Resources/runtime/bin/waffled-runtime restore \
  ~/Library/Application\ Support/Waffled/backups/waffled-20260901-030000.dump
```

It asks you to type `restore` before it touches anything, stops the server itself, loads
the backup, and starts the server again — any migrations a newer Waffled needs run on the
way back up, and phones and the tablet re-sync on their own. It takes a `.dump` from this
app or a `.sql.gz` from a [Docker install's backups](/operations/backup/). It refuses a
backup taken by a *newer* Waffled than the one installed — update first — and needs
Waffled to have started once on this Mac. Add `--data DIR` if you moved Waffled's files.

## Updating

Waffled updates **as one unit**: the app, the runtime, Postgres, the api and the web build
are all one download, and a new version's first start migrates your existing data (taking a
snapshot first, and rolling back if the new version cannot come up healthy).

`Check for updates…` in the menu asks before it installs anything, because installing stops
the household's server for as long as the swap and the migrations take. It also checks once
a day on its own. Everything happens in place: the app stops the server, replaces itself,
relaunches, and the new runtime brings your existing household back up.

**Quit Waffled before replacing the app by hand.** If you download a newer DMG and drag it
over a copy that is currently running, macOS keeps the running server on the *old* code
until it is stopped — you get a new app talking to an old server, with nothing to tell you.
Quit from the menu first (which stops the server), then replace the app, then open it. Using
`Check for updates…` avoids the whole problem: it does the stop for you.

If an update cannot come up healthy it **restores its own snapshot and refuses to start**,
naming the file, rather than leaving you with a half-migrated database.

To go back to an older version deliberately, quit, install the older DMG, and open it. It
will refuse to serve data a newer version has already migrated — a database is not
downgradable by reading it more carefully — and tell you which snapshot to restore and how.

## When something is wrong

The menu's status line says what the runtime sees, and **Show logs** appears there when
something has gone wrong; **Settings… → Diagnostics → Show logs** opens the same folder
any time. From Terminal:

```sh
R=/Applications/Waffled.app/Contents/Resources/runtime/bin/waffled-runtime
$R status          # what is running, on which ports
$R doctor          # checks a server that will not start; exits non-zero on a problem
$R logs api -n 100 # also postgres, migrate, powersync, caddy, bonjour, runtime; -f follows
```

Inside the web app, **Settings → System Health** reports the same things it does on a
Docker install. The symptoms on [Troubleshooting](/operations/troubleshooting/) are the
same on a Mac, but its fixes are written for Docker — use the commands above in place of
`./waffled doctor`, `status` and `logs`.

## Uninstalling

Nothing is installed outside your home folder, and **nothing is deleted for you** — a data
directory with your household in it is not something an uninstaller should guess about.

1. Turn **Start at login** off in the menu (or remove Waffled from System Settings →
   General → Login Items).
2. **Quit Waffled** from the menu. This stops the server — dragging the app to the Trash
   would not.
3. Let the runtime clean up after itself. It removes the nightly backup job, any pidfiles,
   the Bonjour advertisement and the Postgres socket directory, and **keeps your data**,
   printing where it is and how big it is:

   ```sh
   /Applications/Waffled.app/Contents/Resources/runtime/bin/waffled-runtime uninstall
   ```

   Add `--dry-run` first if you want to read the plan before anything happens.
4. Drag `/Applications/Waffled.app` to the Trash.
5. Optional leftovers, both tiny: `~/Library/Preferences/app.waffled.mac.plist` (the
   updater's own settings) and `~/Library/Caches/app.waffled.mac/`.
6. **Your data is still there**, at `~/Library/Application Support/Waffled/`, and that is
   your household. Copy `backups/` and `media/` somewhere safe if you might want them, then
   delete the folder — or let step 3 do it by passing `--delete-data`.

⚠️ **`--delete-data` cannot be undone.** It takes `config.env` with it, and the secrets in
there exist nowhere else — back up first if you might ever come back.

*(A **Remove Waffled…** item in the menu is still to come; for now step 3 is the command.)*

## How this relates to the Docker install

They are the same server. Pick by machine, not by feature:

| | Mac app | [Docker Compose](/install/docker/) |
|---|---|---|
| Runs on | Apple silicon Mac, macOS 14+ | Linux, NAS, Raspberry Pi, VPS, or a Mac with Docker |
| Install | Download a DMG | `git clone` + `./waffled up` |
| Updates | `Check for updates…` in the menu | `./waffled upgrade` |
| Config | `config.env` in Application Support | `infra/compose/.env` |
| Same api, migrations, PowerSync, web app | ✅ | ✅ |

You do not need both, and you should not point both at the same data. If you already run
the Compose stack and just want it on a Mac desktop, Compose keeps working — the Mac app is
for households that would rather not meet Docker at all.

Ports work the same way, with one addition: the setup screen lets you name the port you
would rather have. Waffled takes it if it is free and the next free one if it is not, and
the menu's **Server address** always tells you which. See
[Requirements](/install/requirements/) for the full port table.

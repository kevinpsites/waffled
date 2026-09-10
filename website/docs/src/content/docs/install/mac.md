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

1. Download **`Waffled-<version>.dmg`** from the
   [latest release](https://github.com/kevinpsites/waffled/releases/latest).
2. Open it and drag **Waffled** onto the **Applications** folder in the same window.
3. Open Waffled from Applications.

The app is signed with a Developer ID and notarized by Apple, so there is **no Gatekeeper
warning** — no "unidentified developer", no right-click-Open trick, no
`xattr -d com.apple.quarantine`. macOS may say "Waffled is an app downloaded from the
Internet. Are you sure you want to open it?" the first time, which is the ordinary
first-launch question and takes one click.

## First run

A menu-bar icon appears within a second — the Waffled iron, outlined while nothing is
running. Because there is no data yet, a **setup window** opens in front of everything and
asks before it creates anything.

### 1. Welcome

What Waffled is, which versions of the database, the server, sync and the web app are
already inside the download, and three ways on: **Set up Waffled**, **Choose where things
go…**, or **Not on this Mac**. Closing this window quits — nothing has been created. On a
laptop there is a paragraph about the lid here: close it and the household's server sleeps
with it.

The defaults are sensible, so **Set up Waffled** is a fine answer: Waffled's files in
`~/Library/Application Support/Waffled`, a nightly backup at 3:00 AM, this Mac's own name
as the address, port 8080, and Waffled starting whenever the Mac does. **Choose where things
go…** is how you change any of that first.

### 2. Where things go

Everything on this screen is applied **before** anything is created, so the first start
already uses it.

- **Waffled's files.** Where the database, your photos and every backup live. It has to be a
  folder on this Mac's own internal disk, formatted APFS or Mac OS Extended — an external
  drive somebody can unplug, or a network folder, is not somewhere a running database can
  live, and the window says so if you pick one. **Decide this now if you are going to**:
  moving it afterwards is not something this version does for you.
- **Nightly backup.** On, at 3:00 AM, unless you say otherwise — 1:00 AM, 3:00 AM, 5:00 AM
  or noon — noon is there for a Mac that sleeps at night. Switching it off schedules
  nothing; **Back up now** in the menu still works whenever you want it.
- **Address on your network** — how the kitchen tablet and everyone's phones reach this Mac.
  - **This Mac's name**, a `.local` name phones and tablets discover on their own. The
    default, and the right answer on most home networks.
  - **Its IP address**, for networks where `.local` names do not resolve.
  - **A name I've set up myself**, such as `waffled.home`. You have to have made that name
    point at this Mac yourself — a DNS entry on your router, or a real domain aimed at this
    Mac's address. Waffled does not create it.
  - **Port**, 8080 unless you change it. Waffled *prefers* the port you name and takes the
    next free one if something else on this Mac already answers there.

  Whichever you pick, Waffled serves plain **HTTP** on your own network. A nicer name is a
  nicer address, not HTTPS — there is no certificate, and none of this puts Waffled on the
  public internet.
- **Smart suggestions** *(optional)*. An Anthropic or OpenAI key turns on meal ideas and
  week planning. It is stored on this Mac only, in Waffled's own config, and you can add it
  later instead — nothing else depends on it.
- **Start Waffled when this Mac starts up.** On, and worth leaving on: the tablet and the
  phones expect the server to be there.

### 3. Setting up

A tick per service as the database, the server, sync and the web app come up, with a
progress bar and the last line of the log underneath. The first start creates the database
and runs every migration, so **give it a minute** — longer on an older Mac. You can close
this window: it carries on without it, and the menu-bar icon shows the same progress.

### 4. Ready

The address to type into the kitchen tablet, a **QR code** to point a phone's camera at,
and — when it is different from the name — the plain IP address underneath, which is the one
to use if a device cannot find the name. If the port you asked for was busy, a line here
says which port Waffled took instead.

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
- **The folder is chosen once**, on the setup window's *Where things go* screen, and
  everything above moves with it. Picking a different folder afterwards is not something
  this version does for you — so choose it while Waffled is asking.
- Everything lives under your own user account — nothing is installed system-wide, and
  nothing asks for an admin password. Turn FileVault on if it isn't already; that is what
  protects `config.env` on a machine somebody could walk off with.

## Backups

Waffled backs up **every night** — at 3:00 AM unless you chose another time during setup —
into `backups/`. `Back up now` in the menu writes one on demand, and works even while the
server is stopped. Waffled also takes one **before every migration**, so an update that goes
wrong has something to roll back to.

To change the time later, or to schedule a nightly backup if you switched it off, one
Terminal command does it:

```sh
/Applications/Waffled.app/Contents/Resources/runtime/bin/waffled-runtime backup \
  --install-schedule --at 01:00
```

`--at` is 24-hour local time and defaults to `03:00`; `--uninstall-schedule` removes the
schedule. One Mac keeps one nightly backup, so running this again simply moves the time.

A backup on the same Mac survives a mistake, not a fire. Copy `backups/` somewhere else —
another disk, or a cloud folder — the same advice as the
[Docker backup guide](/operations/backup/), which explains restores in full.

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

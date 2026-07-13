---
title: FAQ
description: Common questions about running, using, and extending Waffled.
---

Short answers to the questions that come up most. Deeper answers link out to the relevant page.

## General

### What is Waffled?
A **self-hosted family hub** — one household, one source of truth for your calendar, chores &
stars, goals, meals & recipes, lists & groceries, pantry, and photos. It runs on your own
hardware and drives three surfaces: an always-on kitchen **kiosk**, a full **web** dashboard,
and a native **iOS** app. See the [overview](/getting-started/overview/).

### Is it really free? What's the catch?
Yes — free and open source ([AGPL-3.0](https://github.com/kevinpsites/waffled/blob/main/LICENSE)).
The "catch" is that **you host it**: you provide an always-on machine and own your backups.
There's no subscription and no hosted version to sign up for. See the
[comparison](/overview/comparison/).

### Do I need to be technical?
You need to be comfortable running two or three terminal commands (`git clone`, `./waffled up`)
and keeping a machine on. If you've ever run any Docker app, you're overqualified. The
[quick start](/getting-started/quick-start/) is the whole install.

### Does my data leave my house?
Only if you opt in. Everything lives in your Postgres database on your machine. Outbound
connections happen **only** for features you enable: AI providers (if you set a key), Google
Calendar sync (if you connect it), offsite S3 backups (if you configure them), and a once-a-day
GitHub check for "update available" (which you can turn off with `UPDATE_CHECK_ENABLED=false`).

## Installing & running

### What are the requirements?
Docker with the Compose v2 plugin, and a machine that's on when you want to use it. ~4 GB RAM is
comfortable. Images are multi-arch, so x86 or ARM (a Raspberry Pi works). Full list:
[Requirements](/install/requirements/).

### Can I run it on a Raspberry Pi / old laptop / NAS?
Yes — anything that runs Docker and stays on. The images are built for both `amd64` and `arm64`.

### How do I access it from a tablet or phone?
Run `./waffled setup` (it auto-detects your LAN IP) so the sync URL isn't `localhost`, then open
`http://<your-machine-ip>:8080` on the device. Skipping this is the #1 cause of a tablet showing
"Offline." Details: [Reverse proxy & TLS](/install/reverse-proxy/) and the quick start's
["Accessing it from other devices"](/getting-started/quick-start/#accessing-it-from-other-devices).

### How do I upgrade?
`./waffled upgrade` — it fast-forwards the repo, bumps the pinned version, snapshots the DB,
pulls the new images, and re-runs migrations in one step. The app also flags "Update available"
in Settings → System Health. See [Upgrading](/operations/upgrading/).

## Accounts & family

### How do family members sign in?
The first account (created in the setup wizard) is the household owner/admin. Add people in
**Settings → Family & people**; give each a login (email + optional password), or let them use
**SSO** once you've configured OIDC. See [Users & members](/administration/users/).

### Can kids use it without an email?
Yes. People can exist as **profiles** without a login, and on a paired kiosk they tap their face
in the profile picker (with an optional PIN) to act as themselves. See
[Kiosk & devices](/administration/kiosk/).

### What can kids do vs. parents?
Waffled gates only what touches currency or someone else's record; everything collaborative is
open (and attributed). Roles (adult / teen / kid) carry a per-capability grid the owner can tune.
See [Permissions & roles](/concepts/permissions/).

### I'm locked out / forgot the admin password.
Break-glass from the host: `./waffled admin reset-password` (also `make-admin`, `list-members`).
See [Troubleshooting → Locked out](/operations/troubleshooting/#locked-out--forgot-admin-password).

## Features & integrations

### Does it replace Google Calendar?
No — it **syncs two-way** with it. Connect per person in Settings → Calendars; Waffled pulls
Google events and pushes the ones it authors. See [Google Calendar](/administration/google-calendar/).

### Do I need to buy a special display (like a Skylight)?
No. Any tablet you already own — a spare iPad or Android tablet — becomes the always-on kitchen
kiosk in fullscreen/PWA mode, with an ambient photo screensaver when it's idle. There's no
dedicated hardware to buy and no screen locked behind a subscription. See
[Kiosk & devices](/administration/kiosk/).

### Do I need an AI subscription for the "Add anything" bar?
No. With no provider configured, capture still works via an on-device heuristic. Add a key
(Anthropic, any OpenAI-compatible endpoint, or a local Ollama model) to make it smarter. Keys
live only on the server. See [AI providers](/administration/ai-providers/).

### Can I run the AI locally / offline?
Yes — point `OLLAMA_HOST` at a local Ollama and pick it per household. A 7–8B model is
meaningfully better than a 3B one. See [AI providers](/administration/ai-providers/).

### What's a "module"? Why is Pantry (or Family Night) missing?
Optional features ship **off by default** and are toggled per household in Settings → Modules.
Pantry and Family Night are opt-in; Calendar and Today are always on. See
[Modules](/administration/modules/).

### Does the iOS app work offline?
The **calendar** does — it mirrors to on-device SQLite via PowerSync and queues writes. Other
areas (chores, lists, meals…) are online REST for now. See [Mobile app](/features/mobile/).

## Data & safety

### How are backups handled?
A backup sidecar dumps Postgres **nightly** out of the box. Point it at a host folder and/or an
S3-compatible bucket, and optionally include media. Restore is `./waffled restore <file>`. See
[Backup & restore](/operations/backup/).

### ⚠️ Can I ever delete a Docker volume to "start fresh"?
**No — never `docker volume rm` or `down -v`.** `pgdata` and `waffled_media` are irreplaceable,
and the database holds *encrypted* Google/OIDC refresh tokens that can't be recovered, only
re-consented. If any guide tells you to wipe a volume, stop. Restore from a backup instead.

### Everything shows "Offline" — what's wrong?
Almost always one of two things: a missing `POWERSYNC_JWT_PRIVATE_KEY` on an older/manual
installation, or a `POWERSYNC_PUBLIC_URL` that clients can't actually reach (e.g. `localhost`).
See [Troubleshooting → PowerSync offline](/operations/troubleshooting/#powersync-offline-banner).

## Contributing & project

### Is there a public API?
Yes — the whole app is a REST API under `/api`, and you can mint scoped **API keys** for
external tools. See the [API reference](/reference/api/).

### How do I add a feature?
Most features are built-in toggle **modules**. The end-to-end recipe is in
[Building a module](/concepts/extensibility/) and the [architecture](/developer/architecture/) docs.

### How can I help without writing code?
Star the repo, file good bug reports, and tell other families. More in
[Support the project](/overview/support/).

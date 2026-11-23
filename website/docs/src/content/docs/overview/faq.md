---
title: FAQ
description: Common questions about running, using, and extending Waffled.
---

Short answers to the questions that come up most. Deeper answers link out to the relevant page.

## General

### What is Waffled?
A **self-hosted family hub** — one household, one source of truth for your calendar, chores &
stars, goals, meals & recipes, lists & groceries, pantry, and photos. It runs on your own
hardware and drives two surfaces: an always-on kitchen **kiosk** and a full **web** dashboard (which
installs to a phone as a PWA). See the [overview](/getting-started/overview/).

### Is it really free? What's the catch?
Yes — free and open source ([AGPL-3.0](https://github.com/evan-ribbey/waffled-remix/blob/main/LICENSE)).
The "catch" is that **you host it**: you provide an always-on machine and own your backups.
There's no subscription and no hosted version to sign up for. See the
[comparison](/overview/comparison/).

### Do I need to be technical?
Less than you might think. You need to be comfortable running a few terminal commands
(download `compose.yaml`, `docker compose up -d`) and keeping a machine on; if you've ever run
any Docker app, you're overqualified. The [quick start](/getting-started/quick-start/) is the
whole install.

### Does my data leave my house?
Only if you opt in. Everything lives in your Postgres database on your machine. Outbound
connections happen **only** for features you enable: AI providers (if you set a key), Google
Calendar sync (if you connect it), offsite S3 backups (if you configure them), and a once-a-day
check for a newer version on GitHub, which you can turn off with
`UPDATE_CHECK_ENABLED=false`.

## Installing & running

### What are the requirements?
A machine that's on when you want to use it, running **Docker with the Compose v2.24+
plugin**. ~2 GB RAM is comfortable. Images are multi-arch, so x86 or ARM (a Raspberry Pi works).
Full list: [Requirements](/install/requirements/).

### Can I run it on a Raspberry Pi / old laptop / NAS?
Yes — anything that runs Docker and stays on. The images are built for both `amd64` and `arm64`,
so Intel and Apple silicon Macs work through Docker too.

### How do I access it from a tablet or phone?
Open `http://<your-machine-ip>:8080` on the device. For a hostname or HTTPS, put a reverse
proxy in front and set `PUBLIC_BASE_URL` (and `TRUST_PROXY=true` behind a proxy you control).
Details: [Reverse proxy & TLS](/install/reverse-proxy/) and the quick start's
["Accessing it from other devices"](/getting-started/quick-start/#accessing-it-from-other-devices).

### How do I upgrade?
`docker compose pull && docker compose up -d`. Migrations run on start; there is no automatic
backup first. The app also flags "Update available" in Settings → System Health. See
[Upgrading](/operations/upgrading/). Coming from the old `./waffled` install? See
[Migrating from the ./waffled CLI](/install/migrating-from-waffled-cli/).

## Accounts & family

### How do family members sign in?
The first account (created in the setup wizard) is the household owner/admin. Add people in
**Settings → Family & People**; give each a login (email + optional password), or let them use
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
Break-glass from the host: `docker compose exec -u node waffled node dist/admin.js reset-password`
(also `make-admin`, `list-members`). See [Troubleshooting → Locked out](/operations/troubleshooting/#locked-out--forgot-admin-password).

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

### What's a "module"? Why is Pantry (or Family Night, or Rhythms) missing?
Optional features ship **off by default** and are toggled per household in Settings → Modules.
Pantry, Family Night and [Rhythms](/features/rhythms/) are opt-in; Calendar and Today are
always on. See [Modules](/administration/modules/).

### Is there a Mac or iOS app?
No. The native apps and offline sync were removed in 0.16. The web app works on a phone and can
be installed to the home screen. See [Phone & PWA](/features/mobile/).

## Data & safety

### How are backups handled?
Backups are optional and off by default. Start the backup service with
`docker compose --profile backup up -d` (and set `BACKUP_ENABLED=true`) and a sidecar dumps
Postgres nightly; point it at a host folder and/or an S3-compatible bucket, and optionally
include media. Restore uses `docker compose run --rm --no-deps backup restore <file>`. See
[Backup & restore](/operations/backup/).

### ⚠️ Can I ever delete a Docker volume to "start fresh"?
**No — never `docker volume rm` or `down -v`.** `waffled_pgdata`, `waffled_waffled_media` and `waffled_waffled_data` are irreplaceable,
and the database holds *encrypted* Google/Outlook/OIDC refresh tokens that can't be recovered, only
re-consented. If any guide tells you to wipe a volume, stop. Restore from a backup instead.

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

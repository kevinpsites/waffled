---
title: Move Waffled to new hardware
description: Migrate your household to a new machine without losing data.
---

You'll end up with Waffled running on a **new machine** with all your data and
connected accounts intact — clients re-sync automatically once it's up.

:::danger[Carry over your `.env` — this is the one that bites]
The single most important thing to migrate is **`infra/compose/.env`**. It holds
your secrets, including **`TOKEN_ENCRYPTION_KEY`**. Without that *exact* key, the
encrypted Google / OIDC refresh tokens in your database are **unrecoverable** —
you'd have to re-consent every connected account. Copy the file; don't
regenerate it.
:::

## 1. On the OLD machine — back up + copy secrets

Take a fresh backup. If you rely on uploaded photos, set
`BACKUP_INCLUDE_MEDIA=true` first and re-run so media travels too:

```bash
./waffled backup
./waffled backup list   # note the dump filename
```

Copy **both** off the machine to somewhere safe:

- the dump from `./waffled backup list`
- a copy of **`infra/compose/.env`**

See [Backup & restore](/operations/backup/) for what's in a dump.

## 2. On the NEW machine — clone + restore your secrets

Install Docker + the Compose v2 plugin, then clone the repo:

```bash
git clone https://github.com/kevinpsites/waffled.git waffled && cd waffled
```

Put your saved **`infra/compose/.env`** in place. This keeps the **same
secrets** (same `TOKEN_ENCRYPTION_KEY`) and the **same `WAFFLED_VERSION`**, so
the schema matches the dump you're about to restore. Full var reference:
[Environment variables](/install/environment-variables/).

## 3. Bring it up, then restore your data

```bash
./waffled up                       # builds the stack, creates fresh volumes
./waffled restore <your-dump>.sql.gz   # loads your data over the empty DB
```

If you restored an **older** dump, the one-shot `migrate` service catches its
schema up to the pinned version automatically. See
[Upgrading](/operations/upgrading/) for how versions and migrations line up.

## 4. Fix device reachability for the new address

The new machine has a new IP/hostname, so update the sync address:

```bash
./waffled setup   # new LAN IP or hostname
./waffled up      # apply it
```

This sets `POWERSYNC_PUBLIC_URL` correctly so tablets and the iOS app can find
the new host. Hostname/HTTPS details:
[Reverse proxy & TLS](/install/reverse-proxy/).

## Verify

```bash
./waffled doctor   # should be all green
```

Then open the app and confirm your data is there. Connected clients **re-sync
from PowerSync automatically** and reconnect — no per-device reset needed. See
[System health](/administration/system-health/).

## Notes

- **Never** `docker volume rm` or `down -v` on the **old** machine before you've
  confirmed the new one is healthy — and **never as a "reset"** at all.
- If you moved to a **new hostname/IP**, your connected Google Calendar **redirect
  URIs** may need updating at Google (and `GOOGLE_CALENDAR_REDIRECT_URI` /
  `PUBLIC_BASE_URL` in the env). See
  [Environment variables](/install/environment-variables/).

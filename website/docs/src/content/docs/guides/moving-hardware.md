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

The new machine has a new IP/hostname, so update the public address:

```bash
./waffled setup   # new LAN IP or hostname
./waffled up      # apply it
```

Sync itself needs no help — a device is told to sync at whatever address it used
to reach the server, so pointing the tablet and the iOS app at the new host is
enough. `setup` fixes `PUBLIC_BASE_URL`, which calendar and sign-in redirects
depend on. Hostname/HTTPS details:
[Reverse proxy & TLS](/install/reverse-proxy/).

## Verify

```bash
./waffled doctor   # should be all green
```

Then open the app and confirm your data is there. Connected clients **re-sync
from PowerSync automatically** and reconnect — no per-device reset needed. See
[System health](/administration/system-health/).

## Moving Waffled for Mac to another Mac

The steps above are for Docker. With [Waffled for Mac](/install/mac/) the idea is the same —
a backup, your photos, and the one secret that matters — just without `./waffled`. Waffled's
folder is `~/Library/Application Support/Waffled` unless you moved it.

On the **old** Mac:

1. **Back up now** from the menu. The newest `waffled-….dump` in `backups/` is the one to take.
2. **Quit Waffled**, which stops the server. Copy three things from Waffled's folder to a
   drive or the new Mac: that `.dump`, the `media/` folder, and `config.env`.

On the **new** Mac:

3. [Install Waffled](/install/mac/#download-and-install) — the same version or newer, since a
   restore refuses a backup from a newer Waffled — and let **Set up Waffled** finish. Don't
   bother creating a household in the browser; the restore replaces it.
4. **Quit Waffled.** Carry the old encryption key across — the value of the
   `TOKEN_ENCRYPTION_KEY=` line in the old `config.env` — and your photos:

   ```sh
   R=/Applications/Waffled.app/Contents/Resources/runtime/bin/waffled-runtime
   $R config set 'TOKEN_ENCRYPTION_KEY=<the old value>'
   cp -R /path/to/old/media/ ~/Library/Application\ Support/Waffled/media/
   ```

5. Restore the database. It asks you to type `restore`, then starts the server:

   ```sh
   $R restore /path/to/waffled-20260901-030000.dump
   ```

6. Open Waffled, and point the tablet and phones at the new **Server address** in its menu.

AI keys and calendar OAuth settings live in `config.env`, not in the backup — enter them
again in **Settings…**. Coming from a **Docker** install instead? The same steps work with
the `.sql.gz` from `./waffled backup`, the `TOKEN_ENCRYPTION_KEY` from `infra/compose/.env`,
and your photos from a `BACKUP_INCLUDE_MEDIA` archive unpacked into `media/`.

## Notes

- **Never** `docker volume rm` or `down -v` on the **old** machine before you've
  confirmed the new one is healthy — and **never as a "reset"** at all.
- If you moved to a **new hostname/IP**, your connected Google Calendar **redirect
  URIs** may need updating at Google (and `GOOGLE_CALENDAR_REDIRECT_URI` /
  `PUBLIC_BASE_URL` in the env). See
  [Environment variables](/install/environment-variables/).

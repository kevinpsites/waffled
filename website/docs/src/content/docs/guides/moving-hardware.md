---
title: Move Waffled to new hardware
description: Migrate your household to a new machine without losing data.
---

You'll end up with Waffled running on a **new machine** with all your data and
connected accounts intact.

:::danger[Carry over your secrets — this is the one that bites]
The single most important thing to migrate is your **`TOKEN_ENCRYPTION_KEY`**. It lives in
`/data/secrets.json` (the `waffled_data` volume) unless you set it in `.env`. Without that
*exact* key, the encrypted Google / Outlook / OIDC tokens in your database are
**unrecoverable**: you'd have to re-consent every connected account. Copy the key (and
`LOCAL_JWT_SECRET`); don't regenerate them.
:::

## 1. On the OLD machine — back up + copy secrets

Turn backups on if they aren't already (`docker compose --profile backup up -d`). If you rely
on uploaded photos, set `BACKUP_INCLUDE_MEDIA=true` in `.env` first and recreate the backup
service so media travels too. Then take a fresh backup and read the secrets:

```bash
docker compose exec -u postgres backup waffled-backup
docker compose exec backup ls -lh /backups                 # note the dump filename
docker compose exec waffled cat /data/secrets.json          # your two keys
```

Copy these off the machine to somewhere safe:

- the dump (and the media archive, if you made one) from `/backups`, for example with
  `docker compose cp backup:/backups/<file> .`
- the contents of `secrets.json`, plus your `.env` if you have one

See [Backup & restore](/operations/backup/) for what's in a dump.

## 2. On the NEW machine — compose file + secrets

Install Docker with Compose v2.24+, then:

```bash
mkdir waffled && cd waffled
curl -fsSLO https://raw.githubusercontent.com/evan-ribbey/waffled-ng/main/compose.yaml
```

Put your saved `.env` beside it (if you had one), and add the two keys from `secrets.json`:

```bash
LOCAL_JWT_SECRET=...
TOKEN_ENCRYPTION_KEY=...
```

Values in `.env` win over generated ones, so this keeps the **same** keys. Set
`WAFFLED_VERSION` to the version you ran before, so the schema matches the dump you're about to
restore. Full var reference: [Environment variables](/install/environment-variables/).

## 3. Bring it up, then restore your data

```bash
docker compose --profile backup up -d        # creates fresh volumes; the app starts on an empty DB
docker compose cp ./waffled-<timestamp>.sql.gz backup:/backups/
docker compose stop waffled
docker compose run --rm --no-deps backup restore waffled-<timestamp>.sql.gz
docker compose start waffled
```

If you restored an **older** dump, the app catches its schema up automatically when it starts.
See [Upgrading](/operations/upgrading/) for how versions and migrations line up.

If you took a media archive, unpack it into the media volume:

```bash
docker run --rm -v waffled_waffled_media:/media -v "$PWD":/in alpine \
  tar -xzf /in/waffled-media-<timestamp>.tar.gz -C /media
```

## 4. Update the public address

The new machine has a new IP or hostname. Point the tablet and phones at it, and if you use a
hostname behind a [reverse proxy](/install/reverse-proxy/), set `PUBLIC_BASE_URL` (calendar and
sign-in redirects depend on it), then `docker compose up -d`.

## Verify

```bash
docker compose ps    # waffled and postgres healthy
```

Then open the app, confirm your data is there, and check **Settings → System Health**. See
[System health](/administration/system-health/).

## Notes

- **Never** `docker volume rm` or `down -v` on the **old** machine before you've
  confirmed the new one is healthy — and **never as a "reset"** at all.
- If you moved to a **new hostname/IP**, your connected Google Calendar **redirect
  URIs** may need updating at Google (and `GOOGLE_CALENDAR_REDIRECT_URI` /
  `PUBLIC_BASE_URL` in `.env`). See
  [Environment variables](/install/environment-variables/).

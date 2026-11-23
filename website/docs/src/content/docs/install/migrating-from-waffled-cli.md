---
title: Migrating from the ./waffled CLI
description: Switch an existing Waffled install to the two-container compose setup without losing data.
---

Waffled 0.16 replaced the `./waffled` helper, Caddy and PowerSync with a single `waffled`
container plus Postgres. The new compose file keeps the **same volume names**, so your
database and uploaded media are found in place. The switch is four steps.

> **Back up first.** Run `./waffled backup` on the old stack and keep the file somewhere
> safe. Never run `docker volume rm` or `docker compose down -v`.

## 1. Stop the old stack

From your old checkout:

```bash
./waffled down
```

This stops everything, including PowerSync, so its replication slot is inactive. Your
volumes are kept.

## 2. Put the new `compose.yaml` where the old one was and create a `.env`

Download the new `compose.yaml` into an empty folder (or replace the old checkout):

```bash
mkdir waffled && cd waffled
curl -fsSLO https://raw.githubusercontent.com/evan-ribbey/waffled-ng/main/compose.yaml
```

Then copy these values from your old `infra/compose/.env` into a new `.env` **beside**
`compose.yaml`:

```bash
POSTGRES_USER=...
POSTGRES_PASSWORD=...
POSTGRES_DB=...
LOCAL_JWT_SECRET=...
TOKEN_ENCRYPTION_KEY=...
```

Values in `.env` win over the app's generated secrets, so signed-in sessions and stored
calendar tokens keep working. Carry over any other settings you customised (AI keys, Google
or Microsoft OAuth, `PUBLIC_BASE_URL`, backup settings); see the
[environment variable reference](/install/environment-variables/).

> **Do not lose `TOKEN_ENCRYPTION_KEY`.** If the new install starts without the old key,
> it generates a fresh one and the stored Google and Outlook calendar tokens can no longer be
> decrypted. You would have to re-link each calendar in **Settings → Calendars**.

If you served Waffled through Caddy on another port or hostname, set `HTTP_PORT` or point your
own reverse proxy at port 8080; see [Reverse proxy & TLS](/install/reverse-proxy/).

## 3. Start it

> **Nightly backups are now off unless you turn them on.** The old stack backed up every
> night by default; the new one does not. To keep backups, add `BACKUP_ENABLED=true` to
> `.env` and start with the backup profile instead:
>
> ```bash
> docker compose --profile backup up -d
> ```
>
> Use `--profile backup` on every later `pull` and `up` too. See
> [Backup & restore](/operations/backup/).

```bash
docker compose up -d
```

Migrations run on start and clean up PowerSync (they drop its publication and replication
slot). Open `http://localhost:8080`: your data is all there. The Mac and iOS apps no longer
connect; use the web app, or install it to a phone's home screen as a PWA.

## 4. Optional cleanup

Once you are happy, you can reclaim space from the old pieces:

```bash
docker compose exec postgres psql -U waffled -c 'DROP DATABASE powersync_storage;'
```

Use your own `POSTGRES_USER` if you changed it. You can also remove the old Caddy and
PowerSync volumes (`docker volume ls` shows them) and the old checkout. The compose file
keeps `wal_level=logical` for 0.16.x so the upgrade can read existing replication state; a
later release drops it.

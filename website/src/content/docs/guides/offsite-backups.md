---
title: Offsite backups (3-2-1)
description: Push nightly database dumps to S3-compatible storage.
---

You'll end up with nightly database dumps kept **locally AND copied offsite** to
an S3-compatible bucket — the "1 offsite" leg of a 3-2-1 backup strategy.

Waffled already backs up the database nightly, out of the box, with no setup — see
[Backup & restore](/operations/backup/). This guide adds the **offsite copy** on
top of that.

## 1. Create a bucket + access key

Create a bucket at any **S3-compatible** provider and generate an access key:

- **AWS S3**
- **Backblaze B2**
- **Cloudflare R2**
- **Self-hosted MinIO**

## 2. Configure the offsite copy

In `infra/compose/.env`, set the S3 vars. Each nightly dump is uploaded **in
addition to** the local copy:

```bash
BACKUP_S3_BUCKET=s3://my-bucket/waffled
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
BACKUP_S3_REGION=us-east-1
BACKUP_S3_ENDPOINT=        # set for B2 / R2 / MinIO; leave EMPTY for real AWS

# Optional extras:
BACKUP_INCLUDE_MEDIA=true  # also archive uploaded photos / recipe images
BACKUP_HOST_PATH=/mnt/backups   # also write local dumps to a mounted drive
```

Then recreate the backup service:

```bash
./waffled up
```

Full variable reference: [Environment variables](/install/environment-variables/).

## 3. Set offsite retention

`BACKUP_RETENTION_DAYS` only prunes **local** files. For the offsite copy, set a
**bucket lifecycle rule** at your provider (e.g. "expire objects after 30 days")
so the bucket doesn't grow forever.

## Verify

Run a backup out of band and check it landed:

```bash
./waffled backup        # run one now
./waffled backup list   # confirm the new dump is listed
```

Then check the **backup line** in `./waffled doctor` or **Settings → System
Health** — it goes **degraded** if the last backup failed or is more than ~48h
old. See [System health](/administration/system-health/).

Periodically do a **test restore** of a recent dump into a throwaway
environment, so you know it works before you need it:

```bash
./waffled restore <a-recent-dump>.sql.gz
```

## Why 3-2-1

Keep **3** copies on **2** kinds of media with **1** offsite:

- The local volume (or `BACKUP_HOST_PATH` drive) gives you **fast local
  restores**.
- `BACKUP_S3_*` gives you the **offsite copy** that survives losing the machine.
- Turn on `BACKUP_INCLUDE_MEDIA` if you rely on uploaded photos / recipe images —
  otherwise only the database travels offsite.

To "reset" or reclaim space, prune old dumps or use a lifecycle rule. **Never
wipe a Docker volume** to reset — that's your local backup store (and more). See
[Backup & restore](/operations/backup/) for restore mechanics.

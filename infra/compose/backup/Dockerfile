# Waffled backup sidecar — scheduled Postgres (and optional media) backups, local + S3.
#
# Based on the same postgres major as the DB so `pg_dump` matches the server exactly
# (a mismatched pg_dump refuses to dump a newer server). Adds:
#   - awscli  → optional upload to S3 / any S3-compatible store (Backblaze B2, R2, MinIO)
#   - a tiny bash scheduler (entrypoint.sh) — no external cron binary to download at build
FROM postgres:16-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends awscli ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY backup.sh     /usr/local/bin/waffled-backup
COPY entrypoint.sh /usr/local/bin/waffled-backup-entrypoint
RUN chmod +x /usr/local/bin/waffled-backup /usr/local/bin/waffled-backup-entrypoint \
    && mkdir -p /backups \
    && chown postgres:postgres /backups

# Runs the scheduler loop; `docker exec waffled-backup waffled-backup` triggers one on demand.
USER postgres
ENTRYPOINT ["/usr/local/bin/waffled-backup-entrypoint"]

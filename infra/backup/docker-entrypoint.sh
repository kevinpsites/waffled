#!/bin/sh
# Bind mounts (BACKUP_HOST_PATH) and volumes from older images may be root-owned;
# fix /backups once, then run as postgres. gosu ships in the postgres base image.
set -eu

if [ "$(id -u)" = "0" ]; then
  mkdir -p /backups
  if [ "$(stat -c %U /backups)" != "postgres" ]; then
    echo "[waffled-backup] setting /backups ownership to postgres"
    chown -R postgres:postgres /backups
  fi
  exec gosu postgres /usr/local/bin/waffled-backup-entrypoint "$@"
fi

exec /usr/local/bin/waffled-backup-entrypoint "$@"

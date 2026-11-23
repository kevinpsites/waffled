#!/usr/bin/env bash
# Restore a .sql.gz (sidecar) or .dump (pg_dump -Fc) into DATABASE_URL. Destructive.
#   docker compose stop waffled
#   docker compose run --rm --no-deps backup restore waffled-20260101-020000.sql.gz
#   docker compose start waffled
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"

die() { echo "[waffled-restore] ERROR: $*" >&2; exit 1; }
log() { echo "[waffled-restore] $*"; }

[ $# -eq 1 ] || die "usage: restore <file.sql.gz|file.dump> (a bare name is looked up in ${BACKUP_DIR})"
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set"

FILE="$1"
case "$FILE" in
  */*) ;;
  *) FILE="${BACKUP_DIR}/${FILE}" ;;
esac
[ -f "$FILE" ] || die "no such file: $FILE"

case "$FILE" in
  *.sql.gz|*.dump) ;;
  *) die "unsupported file type: $FILE (expected .sql.gz or .dump)" ;;
esac

pg_isready -q -d "$DATABASE_URL" || die "Postgres is not reachable at DATABASE_URL"

# The app sets no application_name, so any other client session on the target DB counts.
OTHERS="$(psql "$DATABASE_URL" -qtAX -v ON_ERROR_STOP=1 -c \
  "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'")"
if [ "$OTHERS" != "0" ]; then
  die "${OTHERS} other session(s) are connected to the database. Stop the app first: docker compose stop waffled"
fi

# Emit the dump as plain SQL so both formats share one path.
dump_sql() {
  case "$FILE" in
    *.sql.gz) gunzip -c "$FILE" ;;
    *.dump) pg_restore --no-owner --no-privileges -f - "$FILE" ;;
  esac
}

# Reset the whole schema first, in the same transaction as the load: tables newer than the
# dump would otherwise survive with stale migration records. Extensions (pgcrypto) come back
# from the dump; the app's migrations bring an older dump up to date on next start.
log "restoring $FILE"
{
  echo 'DROP SCHEMA public CASCADE;'
  echo 'CREATE SCHEMA public;'
  dump_sql
} | psql "$DATABASE_URL" -qX -v ON_ERROR_STOP=1 --single-transaction >/dev/null
log "done. Start the app again: docker compose start waffled"

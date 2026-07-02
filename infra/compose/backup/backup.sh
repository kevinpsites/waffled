#!/usr/bin/env bash
# One backup run: pg_dump the Nook database (gzipped, plain SQL so restore is a simple
# `gunzip | psql`), optionally tar the media dir, optionally upload to S3, prune old
# local files, and record the outcome in the backup_runs table so `/api/health` and
# `./nook doctor` can report "last backup: ok/failed, N hours ago".
#
# Intentionally NOT `set -e`: a failure must be recorded in the DB, not crash the loop.
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
INCLUDE_MEDIA="${BACKUP_INCLUDE_MEDIA:-false}"
MEDIA_DIR="${MEDIA_DIR:-/data/media}"
S3_BUCKET="${BACKUP_S3_BUCKET:-}"      # e.g. s3://my-bucket/nook  (empty → local only)
S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"  # set for B2 / R2 / MinIO; empty → real AWS

log() { echo "[nook-backup] $(date -u +%FT%TZ) $*"; }
now_ms() { echo $(( $(date +%s%N) / 1000000 )); }

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%d-%H%M%S)"
DUMP_FILE="$BACKUP_DIR/nook-$TS.sql.gz"
MEDIA_FILE=""
DEST="local"; [ -n "$S3_BUCKET" ] && DEST="local+s3"
START_MS=$(now_ms)

# psql helper against the app DB (DATABASE_URL is injected by compose). -q so command
# output doesn't leak into captured values.
psql_do() { psql "$DATABASE_URL" -qtAX -v ON_ERROR_STOP=1 -c "$1"; }
# Escape a value for a single-quoted SQL literal (double embedded single quotes). We
# inline values rather than use psql :'var' interpolation, which this image's psql
# doesn't apply. RUN_ID is a generated UUID and sizes/durations are integers, so only
# free-text (file names, error messages) needs escaping.
sql_str() { printf "%s" "$1" | sed "s/'/''/g"; }

# Open a 'running' row; capture its id so we can finalize it. Best-effort — if the DB is
# unreachable the dump will fail below anyway and we log it.
RUN_ID="$(psql_do "insert into backup_runs (status, kind, destination) values ('running','database','$DEST') returning id" 2>/dev/null)"

finish_ok() {
  local size="$1" file="$2" dur=$(( $(now_ms) - START_MS ))
  [ -n "${RUN_ID:-}" ] && psql_do \
    "update backup_runs set status='success', finished_at=now(), file_name='$(sql_str "$file")', size_bytes=$size, duration_ms=$dur where id='$RUN_ID'" >/dev/null 2>&1 || true
  log "OK — $file (${size} bytes, ${dur}ms, dest=$DEST)"
}

fail() {
  local msg="$1" dur=$(( $(now_ms) - START_MS ))
  log "FAILED — $msg"
  [ -n "${RUN_ID:-}" ] && psql_do \
    "update backup_runs set status='failed', finished_at=now(), error='$(sql_str "$msg")', duration_ms=$dur where id='$RUN_ID'" >/dev/null 2>&1 || true
  exit 1
}

# --- Database dump ---------------------------------------------------------------
# --clean --if-exists → restore drops+recreates objects cleanly; --no-owner/-privileges
# → restore works under any role. pipefail makes a pg_dump failure fail the pipe.
log "dumping database → $DUMP_FILE"
if ! pg_dump "$DATABASE_URL" --clean --if-exists --no-owner --no-privileges | gzip > "$DUMP_FILE"; then
  rm -f "$DUMP_FILE"
  fail "pg_dump failed"
fi
SIZE="$(stat -c %s "$DUMP_FILE" 2>/dev/null || echo 0)"
[ "$SIZE" -gt 0 ] || fail "dump file is empty"

# --- Optional media archive ------------------------------------------------------
if [ "$INCLUDE_MEDIA" = "true" ]; then
  if [ -d "$MEDIA_DIR" ]; then
    MEDIA_FILE="$BACKUP_DIR/nook-media-$TS.tar.gz"
    log "archiving media → $MEDIA_FILE"
    tar -czf "$MEDIA_FILE" -C "$MEDIA_DIR" . || { log "media archive failed (continuing with DB backup)"; MEDIA_FILE=""; }
  else
    log "BACKUP_INCLUDE_MEDIA=true but $MEDIA_DIR not mounted — skipping media"
  fi
fi

# --- Optional S3 upload ----------------------------------------------------------
if [ -n "$S3_BUCKET" ]; then
  aws_args=(s3 cp); [ -n "$S3_ENDPOINT" ] && aws_args+=(--endpoint-url "$S3_ENDPOINT")
  log "uploading to $S3_BUCKET"
  aws "${aws_args[@]}" "$DUMP_FILE" "$S3_BUCKET/" || fail "S3 upload failed (check BACKUP_S3_* creds/endpoint)"
  [ -n "$MEDIA_FILE" ] && { aws "${aws_args[@]}" "$MEDIA_FILE" "$S3_BUCKET/" || log "media S3 upload failed (DB dump uploaded OK)"; }
fi

# --- Local retention (S3 retention → use a bucket lifecycle rule) -----------------
find "$BACKUP_DIR" -maxdepth 1 -name 'nook-*.sql.gz'     -type f -mtime "+$RETENTION_DAYS" -delete 2>/dev/null || true
find "$BACKUP_DIR" -maxdepth 1 -name 'nook-media-*.tar.gz' -type f -mtime "+$RETENTION_DAYS" -delete 2>/dev/null || true

finish_ok "$SIZE" "$(basename "$DUMP_FILE")"

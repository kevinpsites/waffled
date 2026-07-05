#!/usr/bin/env bash
# Scheduler loop for the Waffled backup sidecar. Runs one backup per day at BACKUP_TIME
# (container timezone — set TZ to change it). Deliberately dependency-free (no cron
# binary): a plain sleep-until-next-run loop is easy to reason about and survives
# restarts. `docker exec waffled-backup waffled-backup` runs one immediately, out of band.
set -uo pipefail

BACKUP_TIME="${BACKUP_TIME:-02:00}"          # daily HH:MM (24h)
BACKUP_ON_START="${BACKUP_ON_START:-false}"  # also run once right after the container starts

log() { echo "[waffled-backup] $(date -u +%FT%TZ) $*"; }

if [ "$BACKUP_ON_START" = "true" ]; then
  log "BACKUP_ON_START=true → running an initial backup"
  /usr/local/bin/waffled-backup || log "initial backup failed (continuing to schedule)"
fi

log "scheduler up — daily backup at ${BACKUP_TIME} ($(date +%Z)); retention ${BACKUP_RETENTION_DAYS:-14}d"
while true; do
  now=$(date +%s)
  target=$(date -d "today ${BACKUP_TIME}" +%s 2>/dev/null) || {
    log "invalid BACKUP_TIME='${BACKUP_TIME}' (want HH:MM) — sleeping 1h and retrying"; sleep 3600; continue
  }
  # If today's slot already passed, aim for tomorrow's.
  [ "$target" -le "$now" ] && target=$(date -d "tomorrow ${BACKUP_TIME}" +%s)
  sleep_for=$(( target - now ))
  log "next backup in ${sleep_for}s"
  sleep "$sleep_for"
  /usr/local/bin/waffled-backup || log "scheduled backup failed (will retry at next ${BACKUP_TIME})"
done

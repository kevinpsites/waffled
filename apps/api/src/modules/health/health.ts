// Deep health report for self-host operators. `GET /api/health` (admin) returns a
// per-component status the in-app System Health panel and `./waffled doctor` render;
// buildHealthReport() is exported so the doctor CLI can call it directly in-process
// (no HTTP/token). Every check is independent and best-effort — a failing check is
// captured, never thrown, so the report always renders.
import createAPI from 'lambda-api'
import { readdirSync } from 'node:fs'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getPool, query } from '../../platform/db'
import { jobSnapshots } from '../../platform/jobs'
import { version } from '../../platform/version'
import { adminRoute } from '../../platform/route-guards'

type Api = ReturnType<typeof createAPI>

export type Status = 'ok' | 'degraded' | 'down'
export interface HealthReport {
  status: Status
  version: typeof version
  generatedAt: string
  checks: Record<string, { status: Status } & Record<string, unknown>>
}

function mediaDir(): string {
  return process.env.MEDIA_DIR || '/data/media'
}

// Count available .sql migrations from whichever dir exists (container cwd is /app;
// tests run from apps/api). Returns null if none found (don't false-alarm).
function availableMigrations(): number | null {
  for (const dir of [resolve(process.cwd(), 'migrations'), '/app/migrations']) {
    try {
      return readdirSync(dir).filter((f) => f.endsWith('.sql')).length
    } catch {
      /* try next */
    }
  }
  return null
}

async function checkDb(): Promise<{ status: Status } & Record<string, unknown>> {
  try {
    await query('select 1')
    const pool = getPool()
    return { status: 'ok', total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
  } catch (err) {
    return {
      status: 'down',
      error: err instanceof Error ? err.message : String(err),
      hint: 'Postgres is unreachable. Check it is running: `./waffled logs postgres` (and that DATABASE_URL is set).',
    }
  }
}

async function checkMigrations(): Promise<{ status: Status } & Record<string, unknown>> {
  try {
    const { rows } = await query<{ count: string }>('select count(*)::int as count from pgmigrations')
    const applied = Number(rows[0]?.count ?? 0)
    const available = availableMigrations()
    const behind = available != null && applied < available
    const status: Status = behind ? 'degraded' : 'ok'
    return { status, applied, available, ...(behind ? { hint: 'Schema is behind. Apply pending migrations: `./waffled migrate` (or `./waffled up`).' } : {}) }
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message : String(err) }
  }
}

// Degraded if any scheduler's last run errored. (A never-run job is fine — the
// interval may simply not have elapsed, or the feature isn't configured.)
function checkSchedulers(): { status: Status } & Record<string, unknown> {
  const jobs = jobSnapshots()
  const anyError = jobs.some((j) => j.lastError)
  const out: { status: Status } & Record<string, unknown> = { status: anyError ? 'degraded' : 'ok', jobs }
  if (anyError) {
    const failed = jobs.filter((j) => j.lastError).map((j) => j.name).join(', ')
    out.hint = `Background job(s) erroring: ${failed}. See the job's lastError above and \`./waffled logs api\`.`
  }
  // Job state is in-memory per process. `./waffled doctor` runs a separate process so
  // it sees none; the live server (this same report via GET /api/health, shown in
  // Settings → System Health) has the real run history.
  if (jobs.length === 0) out.note = 'no run history in this process (see Settings → System Health for live jobs)'
  return out
}

// Google calendar push backlog — a stuck push (push_failed) is worth surfacing.
async function checkCalendar(): Promise<{ status: Status } & Record<string, unknown>> {
  try {
    const { rows } = await query<{ sync_state: string; count: string }>(
      `select sync_state, count(*)::int as count from events
        where sync_state in ('pending_push','push_failed') group by sync_state`
    )
    const pending = Number(rows.find((r) => r.sync_state === 'pending_push')?.count ?? 0)
    const failed = Number(rows.find((r) => r.sync_state === 'push_failed')?.count ?? 0)
    const { rows: stale } = await query<{ count: string }>(
      `select count(*)::int as count from calendars
        where sync_token is not null and last_synced_at < now() - interval '1 hour'`
    )
    const staleCalendars = Number(stale[0]?.count ?? 0)
    const status: Status = failed > 0 || staleCalendars > 0 ? 'degraded' : 'ok'
    const hint =
      failed > 0 || staleCalendars > 0
        ? 'Google sync is failing — almost always an expired/revoked Google sign-in (invalid_grant). Reconnect each account in Settings → Calendars; the backlog drains on the next sync. (Tip: a Google OAuth consent screen in "Testing" mode expires refresh tokens after 7 days — publish it to avoid repeats.)'
        : undefined
    return { status, pendingPush: pending, failedPush: failed, staleCalendars, ...(hint ? { hint } : {}) }
  } catch (err) {
    // Calendar tables always exist post-migrate; a query error is a real problem.
    return { status: 'down', error: err instanceof Error ? err.message : String(err) }
  }
}

// Writability of the media volume — uploads (photos, recipe images, chore proofs)
// all depend on it. Probe with a temp write+unlink.
function checkStorage(): { status: Status } & Record<string, unknown> {
  const dir = mediaDir()
  const probe = join(dir, `.health-${process.pid}`)
  try {
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return { status: 'ok', dir, writable: true }
  } catch (err) {
    // Degraded (not down): a dev box without the volume mounted still "works".
    return {
      status: 'degraded',
      dir,
      writable: false,
      error: err instanceof Error ? err.message : String(err),
      hint: `Media dir ${dir} is not writable — uploads will fail. Check the waffled_media volume mount (MEDIA_DIR).`,
    }
  }
}

// Last automatic backup — degraded if the most recent run failed, or if the newest
// successful dump is older than ~2 daily cycles (48h). Off cleanly when BACKUP_ENABLED
// is false, or before the first run / migration (never a false alarm).
async function checkBackup(): Promise<{ status: Status } & Record<string, unknown>> {
  if ((process.env.BACKUP_ENABLED ?? 'true') === 'false') {
    return { status: 'ok', enabled: false, note: 'Automatic backups are disabled (BACKUP_ENABLED=false).' }
  }
  try {
    const { rows } = await query<{
      status: string
      finished_at: string | null
      file_name: string | null
      size_bytes: string | null
      error: string | null
      age_hours: number | null
    }>(
      `select status, finished_at, file_name, size_bytes, error,
              extract(epoch from (now() - finished_at)) / 3600 as age_hours
         from backup_runs
        where status in ('success','failed')
        order by finished_at desc nulls last
        limit 1`
    )
    if (rows.length === 0) {
      return {
        status: 'ok',
        enabled: true,
        lastBackupAt: null,
        note: 'No backup has run yet — the first runs on schedule (BACKUP_TIME). Run one now: `./waffled backup`.',
      }
    }
    const last = rows[0]
    if (last.status === 'failed') {
      return {
        status: 'degraded',
        enabled: true,
        lastStatus: 'failed',
        lastBackupAt: last.finished_at,
        error: last.error ?? undefined,
        hint: 'The last backup failed. Check `./waffled logs backup` (disk space, or BACKUP_S3_* credentials/endpoint).',
      }
    }
    const ageHours = last.age_hours == null ? null : Math.round(last.age_hours)
    const stale = ageHours != null && ageHours > 48
    return {
      status: stale ? 'degraded' : 'ok',
      enabled: true,
      lastStatus: 'success',
      lastBackupAt: last.finished_at,
      lastFile: last.file_name ?? undefined,
      lastSizeBytes: last.size_bytes != null ? Number(last.size_bytes) : undefined,
      ...(stale ? { hint: `Last successful backup was ${ageHours}h ago (a daily backup is expected). Check \`./waffled logs backup\`.` } : {}),
    }
  } catch {
    // backup_runs missing (pre-0071) or unreadable — don't false-alarm the operator.
    return { status: 'ok', enabled: true, note: 'backup_runs not found yet — run `./waffled migrate`.' }
  }
}

function aggregate(checks: HealthReport['checks']): Status {
  const states = Object.values(checks).map((c) => c.status)
  if (states.includes('down')) return 'down'
  if (states.includes('degraded')) return 'degraded'
  return 'ok'
}

export async function buildHealthReport(): Promise<HealthReport> {
  const [db, migrations, calendar, backup] = await Promise.all([
    checkDb(),
    checkMigrations(),
    checkCalendar(),
    checkBackup(),
  ])
  const checks: HealthReport['checks'] = {
    db,
    migrations,
    schedulers: checkSchedulers(),
    calendar,
    storage: checkStorage(),
    backup,
  }
  return { status: aggregate(checks), version, generatedAt: new Date().toISOString(), checks }
}

export function registerHealthRoutes(api: Api): void {
  // Admin-gated: the report carries operational counts, not for non-admins. Always
  // HTTP 200 — the status lives in the body so the panel renders even when degraded.
  api.get('/api/health', adminRoute(async () => buildHealthReport()))
}

// Programmatic migration runner — used by tests and importable elsewhere.
// The CLI path (`npm run migrate` → node-pg-migrate) is what runs against the
// live stack; this wrapper points the same migrations at an arbitrary database
// (e.g. a Testcontainers Postgres).
import { runner } from 'node-pg-migrate'
import { Client, type ClientConfig } from 'pg'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Default location of the .sql migrations, relative to this module. This branch
// only runs under tsx/vitest (real ESM, so import.meta.url is valid). The bundled
// CJS CLI (dist/migrate.js) passes an explicit dir instead, because esbuild's CJS
// output leaves import.meta empty — see scripts/migrate-cli.ts.
function defaultMigrationsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
}

// Migrations run while the previous api + PowerSync may still hold connections. A
// queued ACCESS EXCLUSIVE request stalls every later query on that table, so migrate
// gives up on a lock quickly and retries rather than waiting (and stalling) forever.
// statement_timeout stays unset: long backfills are legitimate.
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000
const DEFAULT_LOCK_RETRIES = 3
const DEFAULT_LOCK_BACKOFF_MS = 2_000
const APPLICATION_NAME = 'waffled-migrate'
const LOCK_NOT_AVAILABLE = '55P03'

export type MigrateOptions = {
  /** Per-lock wait before Postgres cancels the statement. 0 waits forever. */
  lockTimeoutMs?: number
  /** Extra attempts after a lock timeout. Ignored when `count` is finite. */
  retries?: number
  /** Delay before retry n is n × backoffMs. */
  backoffMs?: number
  log?: (message: string) => void
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, min: 60_000, h: 3_600_000 }
const MAX_LOCK_TIMEOUT_MS = 2_147_483_647

// MIGRATE_LOCK_TIMEOUT: a bare number is milliseconds (as in Postgres), or a number
// with a Postgres time unit. Anything else throws so a typo can't silently mean "default".
export function parseLockTimeout(raw: string | undefined): number {
  const value = raw?.trim() ?? ''
  if (value === '') return DEFAULT_LOCK_TIMEOUT_MS
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h)?$/.exec(value)
  if (!match) {
    throw new Error(
      `MIGRATE_LOCK_TIMEOUT must be milliseconds or a duration like 500ms, 15s or 2min (got "${raw}")`
    )
  }
  const amount = Number(match[1])
  const ms = Math.round(amount * UNIT_MS[match[2] ?? 'ms'])
  // 0 means "wait forever", so a tiny non-zero value must not round into it; above
  // INT_MAX Postgres refuses the startup option and every connection fails.
  if ((ms === 0 && amount !== 0) || ms > MAX_LOCK_TIMEOUT_MS) {
    throw new Error(
      `MIGRATE_LOCK_TIMEOUT must be 0, or between 1ms and ${MAX_LOCK_TIMEOUT_MS}ms (got "${raw}")`
    )
  }
  return ms
}

// `count` limits how many *pending* migrations to apply (default: all). Tests use
// it to migrate up to just before a new migration, seed legacy-shaped data, then
// run the remaining migration(s) to exercise a backfill.
export async function runMigrations(
  databaseUrl: string,
  migrationsDir = defaultMigrationsDir(),
  count = Infinity,
  // node-pg-migrate takes a *cluster-wide* advisory lock (a fixed lock id) while it
  // migrates, so two migrate runs against the same Postgres instance serialize even
  // when they target different databases. That lock guards the live stack (the compose
  // migrate one-shot could race a restart), so it stays ON by default. But the test
  // harness gives every file its own freshly-created, single-writer database, so the
  // lock only throttles parallelism there with nothing to protect — the shared-Postgres
  // vitest run opts out via WAFFLED_TEST_SHARED_PG so migrations run truly concurrently.
  noLock = process.env.WAFFLED_TEST_SHARED_PG === '1',
  options: MigrateOptions = {}
): Promise<void> {
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  // A retry re-counts pending migrations, so after a partial apply it would overshoot a finite count.
  const retries = Number.isFinite(count) ? 0 : (options.retries ?? DEFAULT_LOCK_RETRIES)
  const backoffMs = options.backoffMs ?? DEFAULT_LOCK_BACKOFF_MS
  const log = options.log ?? (() => {})

  const watch = lockTimeoutMs > 0 ? await watchLockWaits(databaseUrl, lockTimeoutMs) : null
  try {
    for (let attempt = 1; ; attempt++) {
      watch?.reset()
      try {
        await runner({
          // Startup options make lock_timeout a session default, so it holds inside every
          // per-migration BEGIN/COMMIT and survives a rolled-back one (a SET would not).
          // Each attempt gets a fresh connection, which also drops the advisory lock.
          databaseUrl: sessionConfig(databaseUrl, lockTimeoutMs),
          dir: migrationsDir,
          direction: 'up',
          migrationsTable: 'pgmigrations',
          count,
          noLock,
          // Tolerate out-of-order application. Feature branches are developed in parallel,
          // so a DB can legitimately have a later-sorted migration applied while an earlier
          // one is still pending (e.g. two branches each add a migration, then one deploys
          // first). Strict ordering wedges that DB with "Not run migration X is preceding
          // already run migration Y"; with checkOrder off, the pending ones just run. The
          // CI duplicate-number guard + the CLAUDE.md rule keep numbering collisions out in
          // the first place — this is the safety net for a DB that already diverged.
          checkOrder: false,
          log: () => {}, // quiet; the CLI is the verbose path
        })
        return
      } catch (err) {
        if (!isLockTimeout(err)) throw err
        const wait = watch?.latest() ?? null
        if (attempt > retries) throw lockTimeoutError(err, wait, lockTimeoutMs, attempt)
        const delayMs = backoffMs * attempt
        log(
          `${describeWait(wait, lockTimeoutMs)} (attempt ${attempt}/${retries + 1}); retrying in ${delayMs}ms`
        )
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
  } finally {
    await watch?.stop()
  }
}

function sessionConfig(databaseUrl: string, lockTimeoutMs: number): ClientConfig {
  return {
    connectionString: databaseUrl,
    application_name: APPLICATION_NAME,
    options: `-c lock_timeout=${lockTimeoutMs}`,
  }
}

function isLockTimeout(err: unknown): boolean {
  for (let e = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === LOCK_NOT_AVAILABLE) return true
  }
  return false
}

type Blocker = {
  pid: number
  usename: string | null
  application_name: string | null
  state: string | null
  age: string | null
  query: string | null
}
type LockWait = { relation: string | null; mode: string | null; locktype: string | null; blockers: Blocker[] }

// Once Postgres cancels the waiting statement its session no longer shows who blocked
// it, so a side connection samples pg_blocking_pids while the migrate session waits.
async function watchLockWaits(databaseUrl: string, lockTimeoutMs: number) {
  const intervalMs = Math.min(1_000, Math.max(25, Math.floor(lockTimeoutMs / 4)))
  const client = new Client({
    connectionString: databaseUrl,
    application_name: `${APPLICATION_NAME}-diagnostics`,
  })
  let connected = true
  client.on('error', () => {})
  await client.connect().catch(() => {
    connected = false
  })

  let latest: LockWait | null = null
  let stopped = false
  let inFlight: Promise<void> = Promise.resolve()
  let timer: NodeJS.Timeout | undefined

  const sample = async () => {
    const { rows } = await client.query<LockWaitRow>(
      `select wl.relation::regclass::text as relation, wl.mode, wl.locktype,
              b.pid as blocker_pid, b.usename, b.application_name, b.state,
              date_trunc('second', now() - coalesce(b.xact_start, b.query_start))::text as age,
              left(b.query, 200) as query
         from pg_stat_activity w
         join lateral (select * from pg_locks l where l.pid = w.pid and not l.granted limit 1) wl on true
         cross join lateral unnest(pg_blocking_pids(w.pid)) as bp(pid)
         join pg_stat_activity b on b.pid = bp.pid
        where w.application_name = $1 and w.datname = current_database()`,
      [APPLICATION_NAME]
    )
    if (rows.length === 0) return
    latest = {
      relation: rows[0].relation,
      mode: rows[0].mode,
      locktype: rows[0].locktype,
      blockers: rows.map((r) => ({
        pid: r.blocker_pid,
        usename: r.usename,
        application_name: r.application_name,
        state: r.state,
        age: r.age,
        query: r.query,
      })),
    }
  }
  const tick = () => {
    if (stopped) return
    inFlight = sample()
      .catch(() => {})
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs)
      })
  }
  if (connected) tick()

  return {
    latest: () => latest,
    reset: () => {
      latest = null
    },
    stop: async () => {
      stopped = true
      clearTimeout(timer)
      await inFlight
      if (connected) await client.end().catch(() => {})
    },
  }
}
type LockWaitRow = Omit<LockWait, 'blockers'> & Omit<Blocker, 'pid'> & { blocker_pid: number }

function describeWait(wait: LockWait | null, lockTimeoutMs: number): string {
  const target = wait?.relation
    ? `${wait.mode ?? 'a lock'} on "${wait.relation}"`
    : wait
      ? `${wait.mode ?? 'a lock'} (${wait.locktype ?? 'unknown'} lock)`
      : 'a lock'
  return `lock timeout: ${target} was not granted within ${lockTimeoutMs}ms`
}

function lockTimeoutError(
  cause: unknown,
  wait: LockWait | null,
  lockTimeoutMs: number,
  attempts: number
): Error {
  const blockers = wait?.blockers.length
    ? wait.blockers
        .map(
          (b) =>
            `  pid ${b.pid}  user=${b.usename ?? '?'}  app=${b.application_name || '?'}  ` +
            `state=${b.state ?? '?'}  age=${b.age ?? '?'}  query: ${oneLine(b.query)}`
        )
        .join('\n')
    : '  (could not identify the blocking session)'
  return new Error(
    `${describeWait(wait, lockTimeoutMs)}; gave up after ${attempts} attempt(s).\n` +
      `Blocking sessions:\n${blockers}\n` +
      'Stop the app services (api, powersync) so migrations can take their locks, then run ' +
      'migrate again. MIGRATE_LOCK_TIMEOUT raises the per-lock wait.',
    { cause }
  )
}

function oneLine(query: string | null): string {
  return (query ?? '').replace(/\s+/g, ' ').trim() || '?'
}

// Lazily-created pg connection pool. The pool isn't opened until the first query,
// so DB-free routes (/healthz, /api/me) and the e2e container (no DATABASE_URL)
// never touch Postgres.
import { Pool, types, type QueryResult, type QueryResultRow } from 'pg'
import { traceDb } from './telemetry'
import { log } from './logger'

// A `date` column is a bare calendar day — a birthday, a goal's deadline, the day a
// meal is planned for. By default pg turns one into a JS Date at THIS SERVER's local
// midnight, which JSON then serializes as a UTC instant: "2026-09-30" leaves as
// "2026-09-30T07:00:00.000Z". Every client then re-reads that instant in its own
// timezone and can land on the day before — and on a server east of UTC the day is
// already wrong before it leaves. A day has no time and no zone, so hand it over
// exactly as Postgres wrote it and let each client treat it as a day.
//
// This is registered here rather than per-query because the alternative can't cover
// everything: the persons roster is read with `select *`, and a wildcard has nowhere
// to put a cast. Only 1082 (DATE) is touched — `timestamptz` columns are real
// instants and must keep arriving as Date objects (kiosk PIN lockouts do date math on
// them). The explicit `::text` / `to_char` casts already in the queries are now
// redundant but harmless, and they still say what they mean at the call site.
types.setTypeParser(types.builtins.DATE, (v) => v)

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL is not set')
    pool = new Pool({ connectionString })
    // A connection can die while it is sitting IDLE in the pool — Postgres restarts,
    // an operator runs pg_terminate_backend, a proxy reaps the socket. pg-pool reports
    // that by emitting 'error' on the Pool, and Pool is an EventEmitter: with no listener
    // the emit THROWS, from inside a socket callback, which is an uncaught exception that
    // takes the whole API process down. There is nothing to recover here — pg-pool has
    // already discarded the dead client, so the next query dials a fresh one — but the
    // failure must be logged rather than fatal.
    pool.on('error', (err) => {
      log.error('idle postgres connection died', { err })
    })
  }
  return pool
}

export function query<T extends QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  // traceDb wraps the query in an OTEL span when tracing is active; otherwise it
  // just runs the thunk (negligible overhead).
  return traceDb(text, () => getPool().query<T>(text, params as unknown[]))
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

// Lazily-created pg connection pool. The pool isn't opened until the first query,
// so DB-free routes (/healthz, /api/me) and the e2e container (no DATABASE_URL)
// never touch Postgres.
import { Pool, type QueryResult, type QueryResultRow } from 'pg'
import { traceDb } from './telemetry'
import { log } from './logger'

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

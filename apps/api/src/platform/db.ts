// Lazily-created pg connection pool. The pool isn't opened until the first query,
// so DB-free routes (/healthz, /api/me) and the e2e container (no DATABASE_URL)
// never touch Postgres.
import { Pool, type QueryResult, type QueryResultRow } from 'pg'
import { traceDb } from './telemetry'

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL is not set')
    pool = new Pool({ connectionString })
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

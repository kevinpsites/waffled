// Lazily-created pg connection pool. The pool isn't opened until the first query,
// so DB-free routes (/healthz, /api/me) and the e2e container (no DATABASE_URL)
// never touch Postgres.
import { Pool, type QueryResult, type QueryResultRow } from 'pg'

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
  return getPool().query<T>(text, params as unknown[])
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

// A pooled connection can die while it is sitting IDLE in the pool: Postgres restarts,
// an operator runs pg_terminate_backend, a proxy reaps the socket. pg-pool answers that
// by emitting 'error' on the Pool itself (its `makeIdleListener`). Pool is an EventEmitter,
// so with no 'error' listener that emit THROWS — an uncaught exception that kills the API
// process in production, and in CI an "unhandled error" that fails the whole vitest run
// even though every assertion passed (run 31459685295: 1013 passed, job still red).
//
// Our own test harness pulls that trigger on every file: test/helpers/pg.ts `stop()` runs
// pg_terminate_backend on whatever sessions are left before dropping the database.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client, type Pool } from 'pg'

let pg: StartedPostgreSqlContainer
let url: string
let query: <T extends Record<string, unknown>>(t: string, p?: unknown[]) => Promise<{ rows: T[] }>
let getPool: () => Pool
let closePool: () => Promise<void>

beforeAll(async () => {
  // No migrations needed — this file only ever asks Postgres for `select 1`.
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  process.env.DATABASE_URL = url
  const db = await import('../src/platform/db')
  query = db.query
  getPool = db.getPool
  closePool = db.closePool
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

// Kill every backend on this test's database except our own — precisely what an operator,
// a `pg_ctl restart`, or our own helpers/pg.ts teardown does.
async function terminateOtherBackends(): Promise<number> {
  const dbName = new URL(url).pathname.slice(1)
  const admin = new Client({ connectionString: url })
  await admin.connect()
  try {
    const res = await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
        where datname = $1 and pid <> pg_backend_pid()`,
      [dbName]
    )
    return res.rowCount ?? 0
  } finally {
    await admin.end()
  }
}

describe('the connection pool when a backend dies underneath it', () => {
  it('does not let the failure escape as an uncaught exception', async () => {
    await query('select 1') // warm the pool — this client is now idle inside it

    const escaped: unknown[] = []
    const onUncaught = (e: unknown) => escaped.push(e)
    process.on('uncaughtException', onUncaught)
    try {
      expect(await terminateOtherBackends()).toBeGreaterThan(0)
      // Let the FATAL packet land on the idle client's socket and be parsed.
      await new Promise((r) => setTimeout(r, 300))
    } finally {
      process.off('uncaughtException', onUncaught)
    }

    expect(escaped).toEqual([])
  })

  it('recovers on the next query instead of staying poisoned', async () => {
    // pg-pool discards the dead client before it reports the error, so the pool should
    // simply dial a fresh connection. Nothing should need to restart.
    const res = await query<{ ok: number }>('select 1 as ok')
    expect(res.rows[0].ok).toBe(1)
  })

  it('has an error listener attached from the moment the pool is created', () => {
    // The contract behind both tests above, stated directly: a Pool with zero 'error'
    // listeners is one `emit` away from taking the process down.
    expect(getPool().listenerCount('error')).toBeGreaterThan(0)
  })
})

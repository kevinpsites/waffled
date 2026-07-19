// PowerSync consumes a Postgres logical-replication publication. This asserts the
// migration sets that up: a `powersync` publication covering the synced tables,
// each with REPLICA IDENTITY FULL (so updates/deletes carry the whole old row).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import { runMigrations } from '../src/migrate'

let pg: StartedPostgreSqlContainer
let url: string

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
})

afterAll(async () => {
  await pg?.stop()
})

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe('powersync replication setup', () => {
  it('creates a publication named powersync', async () => {
    const res = await withClient((c) =>
      c.query(`select pubname from pg_publication where pubname = 'powersync'`)
    )
    expect(res.rowCount).toBe(1)
  })

  it('publishes the synced tables (households, persons, events, event_participants, event_occurrences)', async () => {
    const res = await withClient((c) =>
      c.query<{ tablename: string }>(
        `select tablename from pg_publication_tables where pubname = 'powersync'`
      )
    )
    expect(res.rows.map((r) => r.tablename).sort()).toEqual([
      'event_occurrences',
      'event_participants',
      'events',
      'households',
      'persons',
    ])
  })

  it('sets REPLICA IDENTITY FULL on the synced tables', async () => {
    const res = await withClient((c) =>
      c.query<{ relname: string; relreplident: string }>(
        `select relname, relreplident from pg_class
          where relname in ('households','persons','events','event_participants','event_occurrences') and relkind = 'r'`
      )
    )
    // 'f' = FULL
    expect(res.rows.every((r) => r.relreplident === 'f')).toBe(true)
    expect(res.rows).toHaveLength(5)
  })
})

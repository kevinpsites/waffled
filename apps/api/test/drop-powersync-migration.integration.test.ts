// 0107 removes the PowerSync publication, idle replication slots and REPLICA IDENTITY FULL.
// Replication slots are cluster-wide and need wal_level=logical, so this file runs its own
// Postgres instead of using the shared one.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations } from '../src/migrate'

const MIGRATIONS = join(__dirname, '..', 'migrations')
const TABLES = ['events', 'event_participants', 'event_occurrences', 'households', 'persons']

let pg: StartedPostgreSqlContainer
let adminUrl: string
let dirBefore0107: string

function urlFor(db: string): string {
  const u = new URL(adminUrl)
  u.pathname = `/${db}`
  return u.toString()
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

async function createDb(name: string): Promise<string> {
  await withClient(adminUrl, (c) => c.query(`create database ${name}`))
  return urlFor(name)
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').withCommand(['postgres', '-c', 'wal_level=logical']).start()
  adminUrl = pg.getConnectionUri()
  dirBefore0107 = await mkdtemp(join(tmpdir(), 'waffled-pre-0107-'))
  for (const f of await readdir(MIGRATIONS)) {
    if (f.endsWith('.sql') && f < '0107') await copyFile(join(MIGRATIONS, f), join(dirBefore0107, f))
  }
}, 120_000)

afterAll(async () => {
  await rm(dirBefore0107, { recursive: true, force: true })
  await pg?.stop()
})

describe('0107_drop_powersync', () => {
  it('drops the publication, the idle powersync slot, and resets replica identity', async () => {
    const url = await createDb('drop_ps_with_slot')
    await runMigrations(url, dirBefore0107, Infinity, true)
    await withClient(url, async (c) => {
      expect((await c.query(`select 1 from pg_publication where pubname = 'powersync'`)).rowCount).toBe(1)
      await c.query(`select pg_create_logical_replication_slot('powersync_1_test', 'pgoutput')`)
    })

    await runMigrations(url, undefined, Infinity, true)

    await withClient(url, async (c) => {
      expect((await c.query(`select 1 from pg_publication where pubname = 'powersync'`)).rowCount).toBe(0)
      expect((await c.query(`select 1 from pg_replication_slots where slot_name like 'powersync%'`)).rowCount).toBe(0)
      const { rows } = await c.query<{ relname: string; relreplident: string }>(
        `select relname, relreplident from pg_class where relname = any($1) and relkind = 'r'`,
        [TABLES]
      )
      expect(rows).toHaveLength(TABLES.length)
      for (const r of rows) expect(r.relreplident, r.relname).toBe('d')
    })
  }, 120_000)

  it('succeeds on a fresh database with no slot', async () => {
    const url = await createDb('drop_ps_no_slot')
    await runMigrations(url, undefined, Infinity, true)
    await withClient(url, async (c) => {
      expect((await c.query(`select 1 from pg_publication where pubname = 'powersync'`)).rowCount).toBe(0)
    })
  }, 120_000)
})

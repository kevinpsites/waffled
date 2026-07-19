// Integration test for the migration tooling + the identity/household schema.
// A real Postgres (Testcontainers) is migrated from empty, then we assert the
// schema, constraints, and the updated_at trigger behave as the data model says.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import { runMigrations } from '../src/migrate'

let pg: StartedPostgreSqlContainer
let url: string

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url) // migrate from empty
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

describe('migrations — identity & household', () => {
  it('is idempotent (a second run applies nothing new)', async () => {
    const count = () =>
      withClient((c) => c.query<{ n: number }>('select count(*)::int n from pgmigrations'))
    const before = (await count()).rows[0].n
    await runMigrations(url)
    const after = (await count()).rows[0].n
    expect(after).toBe(before)
    expect(before).toBeGreaterThanOrEqual(2)
  })

  it('creates households, persons, identities', async () => {
    const res = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_name = any($1)`,
        [['households', 'persons', 'identities']]
      )
    )
    expect(res.rows.map((r) => r.table_name).sort()).toEqual([
      'households',
      'identities',
      'persons',
    ])
  })

  it('rejects a person whose household_id has no household (FK)', async () => {
    await expect(
      withClient((c) =>
        c.query(`insert into persons (household_id, name, member_type) values ($1,$2,$3)`, [
          '00000000-0000-0000-0000-000000000000',
          'Orphan',
          'kid',
        ])
      )
    ).rejects.toThrow()
  })

  it('inserts the household → person → identity chain and bumps updated_at on update', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('Sites','America/Chicago') returning id`
      )
      const hid = h.rows[0].id

      const p = await c.query<{ id: string; created_at: Date; updated_at: Date }>(
        `insert into persons (household_id, name, member_type, is_admin)
         values ($1,'Kevin','adult',true) returning id, created_at, updated_at`,
        [hid]
      )
      const pid = p.rows[0].id
      expect(p.rows[0].updated_at).toEqual(p.rows[0].created_at) // equal at insert

      await c.query(
        `insert into identities (household_id, person_id, provider, auth0_user_id, email, email_verified)
         values ($1,$2,'google','auth0|kevin','kevin@lorebooks.ai',true)`,
        [hid, pid]
      )

      // owner_person_id FK (added after persons exists) round-trips
      await c.query(`update households set owner_person_id = $1 where id = $2`, [pid, hid])

      // updated_at trigger moves the timestamp forward on a later update
      await c.query(`update persons set name = 'Kevin S.' where id = $1`, [pid])
      const after = await c.query<{ created_at: Date; updated_at: Date }>(
        `select created_at, updated_at from persons where id = $1`,
        [pid]
      )
      expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThan(
        new Date(after.rows[0].created_at).getTime()
      )
    })
  })

  it('enforces unique auth0_user_id across identities', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name,timezone) values ('Dup','UTC') returning id`
      )
      const hid = h.rows[0].id
      const p = await c.query<{ id: string }>(
        `insert into persons (household_id,name,member_type) values ($1,'A','adult') returning id`,
        [hid]
      )
      const pid = p.rows[0].id
      await c.query(
        `insert into identities (household_id,person_id,provider,auth0_user_id)
         values ($1,$2,'google','dupe-sub')`,
        [hid, pid]
      )
      await expect(
        c.query(
          `insert into identities (household_id,person_id,provider,auth0_user_id)
           values ($1,$2,'apple','dupe-sub')`,
          [hid, pid]
        )
      ).rejects.toThrow()
    })
  })
})

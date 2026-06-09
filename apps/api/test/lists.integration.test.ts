// Lists domain — migration + api. This file grows across the L1a/b/c chunks;
// it shares one Postgres testcontainer + app across the describes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
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

describe('lists schema', () => {
  it('creates lists and list_items', async () => {
    const res = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema='public' and table_name = any($1)`,
        [['lists', 'list_items']]
      )
    )
    expect(res.rows.map((r) => r.table_name).sort()).toEqual(['list_items', 'lists'])
  })

  it('defaults checked to false and enforces the list_id FK', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('L','UTC') returning id`
      )
      const hid = h.rows[0].id
      const l = await c.query<{ id: string }>(
        `insert into lists (household_id, name, list_type) values ($1,'Grocery','grocery') returning id`,
        [hid]
      )
      const item = await c.query<{ checked: boolean; checked_at: Date | null }>(
        `insert into list_items (household_id, list_id, name) values ($1,$2,'Milk')
         returning checked, checked_at`,
        [hid, l.rows[0].id]
      )
      expect(item.rows[0].checked).toBe(false)
      expect(item.rows[0].checked_at).toBeNull()

      await expect(
        c.query(`insert into list_items (household_id, list_id, name) values ($1,$2,'Orphan')`, [
          hid,
          '00000000-0000-0000-0000-000000000000',
        ])
      ).rejects.toThrow()
    })
  })
})

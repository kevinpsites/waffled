// Chores domain — migration + api. Shares one Postgres testcontainer + app.
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

describe('chores schema', () => {
  it('creates chores, chore_instances, ledger_entries + the balances view', async () => {
    const tables = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema='public' and table_name = any($1)`,
        [['chores', 'chore_instances', 'ledger_entries']]
      )
    )
    expect(tables.rows.map((r) => r.table_name).sort()).toEqual([
      'chore_instances',
      'chores',
      'ledger_entries',
    ])
    const view = await withClient((c) =>
      c.query(`select table_name from information_schema.views where table_name='v_person_balances'`)
    )
    expect(view.rowCount).toBe(1)
  })

  it('enforces one instance per chore per day and derives star balances', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('C','UTC') returning id`
      )
      const hid = h.rows[0].id
      const p = await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type) values ($1,'Kid','kid') returning id`,
        [hid]
      )
      const pid = p.rows[0].id
      const ch = await c.query<{ id: string }>(
        `insert into chores (household_id, title, person_id, reward_currency, reward_amount)
         values ($1,'Dishes',$2,'stars',5) returning id`,
        [hid, pid]
      )
      const cid = ch.rows[0].id

      await c.query(
        `insert into chore_instances (household_id, chore_id, person_id, due_on) values ($1,$2,$3,'2026-06-08')`,
        [hid, cid, pid]
      )
      // same chore + same day → unique violation
      await expect(
        c.query(
          `insert into chore_instances (household_id, chore_id, person_id, due_on) values ($1,$2,$3,'2026-06-08')`,
          [hid, cid, pid]
        )
      ).rejects.toThrow()

      await c.query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason) values
         ($1,$2,'stars',5,'chore_completed'), ($1,$2,'stars',3,'bonus')`,
        [hid, pid]
      )
      const bal = await c.query<{ balance: string }>(
        `select balance from v_person_balances where person_id=$1 and currency='stars'`,
        [pid]
      )
      expect(Number(bal.rows[0].balance)).toBe(8)
    })
  })
})

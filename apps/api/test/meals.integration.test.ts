// Meals domain — migration + api. Shares one Postgres testcontainer + app.
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

describe('meals schema', () => {
  it('creates recipes, meal_plans, meal_plan_entries', async () => {
    const res = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema='public' and table_name = any($1)`,
        [['recipes', 'meal_plans', 'meal_plan_entries']]
      )
    )
    expect(res.rows.map((r) => r.table_name).sort()).toEqual([
      'meal_plan_entries',
      'meal_plans',
      'recipes',
    ])
  })

  it('enforces one entry per plan/date/meal_type and links a recipe', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('M','UTC') returning id`
      )
      const hid = h.rows[0].id
      const r = await c.query<{ id: string; servings: number }>(
        `insert into recipes (household_id, title) values ($1,'Salmon') returning id, servings`,
        [hid]
      )
      expect(r.rows[0].servings).toBe(4) // default
      const mp = await c.query<{ id: string }>(
        `insert into meal_plans (household_id, start_date, end_date) values ($1,'2026-06-08','2026-06-14') returning id`,
        [hid]
      )
      const planId = mp.rows[0].id

      await c.query(
        `insert into meal_plan_entries (household_id, meal_plan_id, date, meal_type, recipe_id)
         values ($1,$2,'2026-06-08','dinner',$3)`,
        [hid, planId, r.rows[0].id]
      )
      await expect(
        c.query(
          `insert into meal_plan_entries (household_id, meal_plan_id, date, meal_type)
           values ($1,$2,'2026-06-08','dinner')`,
          [hid, planId]
        )
      ).rejects.toThrow()
    })
  })
})

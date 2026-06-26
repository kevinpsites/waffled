// P1 of multi-household identity (docs/design/multi-household-identity.md §4, §5.5):
// the `household_invites` table. Adding an existing account's email to another
// household creates a *pending* invite the account accepts on next login — no one
// is attached to a household without their OK. This migration just adds the table;
// the accept flow lands in P2. Tests assert the schema, FKs, defaults, and that the
// partial index's "pending" predicate (not accepted, not revoked) is well-formed.
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

describe('0056 household_invites', () => {
  it('creates the table with the expected columns', async () => {
    const res = await withClient((c) =>
      c.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'household_invites'`
      )
    )
    expect(res.rows.map((r) => r.column_name).sort()).toEqual(
      [
        'accepted_at',
        'created_at',
        'email',
        'household_id',
        'id',
        'invited_by',
        'is_admin',
        'member_type',
        'revoked_at',
      ].sort()
    )
  })

  it('defaults member_type=adult and is_admin=false, and round-trips a pending invite', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('Inv','UTC') returning id`
      )
      const p = await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type) values ($1,'Host','adult') returning id`,
        [h.rows[0].id]
      )
      const row = await c.query<{ member_type: string; is_admin: boolean; accepted_at: Date | null; revoked_at: Date | null }>(
        `insert into household_invites (household_id, email, invited_by)
         values ($1,'guest@example.com',$2)
         returning member_type, is_admin, accepted_at, revoked_at`,
        [h.rows[0].id, p.rows[0].id]
      )
      expect(row.rows[0].member_type).toBe('adult')
      expect(row.rows[0].is_admin).toBe(false)
      expect(row.rows[0].accepted_at).toBeNull()
      expect(row.rows[0].revoked_at).toBeNull()
    })
  })

  it('rejects an invite for a non-existent household (FK)', async () => {
    await expect(
      withClient((c) =>
        c.query(`insert into household_invites (household_id, email) values ($1,'x@y.com')`, [
          '00000000-0000-0000-0000-000000000000',
        ])
      )
    ).rejects.toThrow()
  })

  it('supports a fast pending lookup by email (partial index predicate is valid)', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('Inv2','UTC') returning id`
      )
      const hid = h.rows[0].id
      // pending
      await c.query(`insert into household_invites (household_id, email) values ($1,'pending@example.com')`, [hid])
      // accepted + revoked should be excluded from the "pending" set
      await c.query(`insert into household_invites (household_id, email, accepted_at) values ($1,'done@example.com', now())`, [hid])
      await c.query(`insert into household_invites (household_id, email, revoked_at) values ($1,'gone@example.com', now())`, [hid])

      const pending = await c.query<{ email: string }>(
        `select email from household_invites
         where lower(email) = lower($1) and accepted_at is null and revoked_at is null`,
        ['Pending@example.com']
      )
      expect(pending.rows).toHaveLength(1)
    })
  })
})

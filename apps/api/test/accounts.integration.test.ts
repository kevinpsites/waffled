// P1 of multi-household identity (docs/design/multi-household-identity.md): the
// additive `accounts` layer + backfill. These tests prove the migration (a) adds
// the schema without touching existing behaviour and (b) backfills a 1:1 account
// for every legacy credential / SSO identity. To exercise the backfill we migrate
// up to *just before* this migration, seed legacy-shaped rows, then apply it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { runMigrations } from '../src/migrate'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const MIGRATION = '0055_accounts'

// Number of migrations that precede the accounts migration (so we can stop right
// before it). Derived from the directory so it stays correct as files are added.
function migrationsBefore(name: string): number {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const idx = files.findIndex((f) => f.startsWith(name))
  if (idx < 0) throw new Error(`migration ${name} not found`)
  return idx
}

describe('0055 accounts — additive schema', () => {
  let pg: StartedPostgreSqlContainer
  let url: string

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16').start()
    url = pg.getConnectionUri()
    await runMigrations(url) // full migrate from empty
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

  it('creates the accounts table with the expected columns', async () => {
    const res = await withClient((c) =>
      c.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'accounts'`
      )
    )
    const cols = res.rows.map((r) => r.column_name).sort()
    expect(cols).toEqual(
      ['created_at', 'deleted_at', 'email', 'id', 'last_household_id', 'password_hash', 'updated_at'].sort()
    )
  })

  it('adds account_id to persons and identities', async () => {
    const res = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.columns
         where table_schema = 'public' and column_name = 'account_id'
           and table_name in ('persons','identities')`
      )
    )
    expect(res.rows.map((r) => r.table_name).sort()).toEqual(['identities', 'persons'])
  })

  it('enforces one active account per email (case-insensitive)', async () => {
    await withClient(async (c) => {
      await c.query(`insert into accounts (email) values ('Dup@Example.com')`)
      await expect(c.query(`insert into accounts (email) values ('dup@example.com')`)).rejects.toThrow()
      // a soft-deleted row frees the email
      await c.query(`update accounts set deleted_at = now() where lower(email) = 'dup@example.com'`)
      await expect(c.query(`insert into accounts (email) values ('dup@example.com')`)).resolves.toBeTruthy()
    })
  })

  it('keeps an account in a household at most once', async () => {
    await withClient(async (c) => {
      const a = await c.query<{ id: string }>(`insert into accounts (email) values ('one@h.com') returning id`)
      const h = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('UQ','UTC') returning id`
      )
      const aid = a.rows[0].id
      const hid = h.rows[0].id
      await c.query(`insert into persons (household_id, name, member_type, account_id) values ($1,'A','adult',$2)`, [hid, aid])
      await expect(
        c.query(`insert into persons (household_id, name, member_type, account_id) values ($1,'B','adult',$2)`, [hid, aid])
      ).rejects.toThrow()
      // but the same account may join a *different* household
      const h2 = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('UQ2','UTC') returning id`
      )
      await expect(
        c.query(`insert into persons (household_id, name, member_type, account_id) values ($1,'C','adult',$2)`, [h2.rows[0].id, aid])
      ).resolves.toBeTruthy()
    })
  })
})

describe('0055 accounts — backfill from legacy credentials & identities', () => {
  let pg: StartedPostgreSqlContainer
  let url: string

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16').start()
    url = pg.getConnectionUri()
    // migrate up to *just before* the accounts migration, leaving legacy schema
    await runMigrations(url, migrationsDir, migrationsBefore(MIGRATION))
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

  it('backfills a 1:1 account for each credential and SSO identity', async () => {
    // Seed legacy state: one password member and one SSO-only member.
    const seeded = await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('Sites','America/Chicago') returning id`
      )
      const hid = h.rows[0].id
      // password member (credential + password identity)
      const pwPerson = await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type, is_admin) values ($1,'Kevin','adult',true) returning id`,
        [hid]
      )
      const pwPid = pwPerson.rows[0].id
      const cred = await c.query<{ id: string }>(
        `insert into credentials (household_id, person_id, email, password_hash)
         values ($1,$2,'Kevin@Lorebooks.ai','scrypt$ab$cd') returning id`,
        [hid, pwPid]
      )
      await c.query(
        `insert into identities (household_id, person_id, provider, auth0_user_id, email, email_verified)
         values ($1,$2,'password',$3,'Kevin@Lorebooks.ai',true)`,
        [hid, pwPid, cred.rows[0].id]
      )
      // SSO-only member (identity with email, no credential)
      const ssoPerson = await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type) values ($1,'Wally','adult') returning id`,
        [hid]
      )
      const ssoPid = ssoPerson.rows[0].id
      await c.query(
        `insert into identities (household_id, person_id, provider, auth0_user_id, email, email_verified)
         values ($1,$2,'google','oidc:abc:wally','wally@example.com',true)`,
        [hid, ssoPid]
      )
      // a kid with no login — must stay account-less
      const kid = await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type) values ($1,'Junior','kid') returning id`,
        [hid]
      )
      return { hid, pwPid, ssoPid, kidPid: kid.rows[0].id }
    })

    // Apply the accounts migration (runs the backfill).
    await runMigrations(url, migrationsDir)

    await withClient(async (c) => {
      // every login has exactly one account, keyed by its email
      const accts = await c.query<{ email: string }>(`select email from accounts order by lower(email)`)
      expect(accts.rows.map((r) => r.email.toLowerCase())).toEqual([
        'kevin@lorebooks.ai',
        'wally@example.com',
      ])

      // password member's person links to the account carrying their password hash
      const pw = await c.query<{ account_id: string; password_hash: string | null }>(
        `select p.account_id, a.password_hash from persons p join accounts a on a.id = p.account_id where p.id = $1`,
        [seeded.pwPid]
      )
      expect(pw.rows[0].account_id).toBeTruthy()
      expect(pw.rows[0].password_hash).toBe('scrypt$ab$cd')

      // SSO-only member's person links to an account (no password)
      const sso = await c.query<{ account_id: string; password_hash: string | null }>(
        `select p.account_id, a.password_hash from persons p join accounts a on a.id = p.account_id where p.id = $1`,
        [seeded.ssoPid]
      )
      expect(sso.rows[0].account_id).toBeTruthy()
      expect(sso.rows[0].password_hash).toBeNull()

      // the kid stays account-less
      const kid = await c.query<{ account_id: string | null }>(`select account_id from persons where id = $1`, [seeded.kidPid])
      expect(kid.rows[0].account_id).toBeNull()

      // both identities point at the matching account
      const idents = await c.query<{ n: number }>(
        `select count(*)::int n from identities where email is not null and account_id is null`
      )
      expect(idents.rows[0].n).toBe(0)
    })
  })

  it('is idempotent — re-running creates no duplicate accounts', async () => {
    const count = () => withClient((c) => c.query<{ n: number }>(`select count(*)::int n from accounts`))
    const before = (await count()).rows[0].n
    await runMigrations(url, migrationsDir)
    expect((await count()).rows[0].n).toBe(before)
  })
})

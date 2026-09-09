// Structural tenant isolation: every `persons` reference on a household-scoped table
// is a COMPOSITE (household_id, person_id) → persons (household_id, id) foreign key, so
// Postgres itself refuses a row in household A that points at a person in household B.
//
// The 2026-09-08 tenant-isolation audit found five write paths that had forgotten the
// application-layer assertion. This suite tests the database, not the application: the
// headline cases are raw SQL inserts that must fail with SQLSTATE 23503.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import { runMigrations } from '../src/migrate'
import { runner } from 'node-pg-migrate'
import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const THIS_MIGRATION = '0101_persons_household_composite_fks.sql'

/** How many migrations sort BEFORE the one under test — i.e. the "just before" state. */
function countBefore(): number {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const i = files.indexOf(THIS_MIGRATION)
  expect(i, `${THIS_MIGRATION} must exist in ${MIGRATIONS_DIR}`).toBeGreaterThan(-1)
  return i
}

/**
 * Every `persons` FK that must be composite, with the ON DELETE action it had BEFORE
 * this migration and must still have after it. Written out by hand on purpose: this is
 * the contract, and a generated expectation could only ever agree with itself.
 *
 * `col` is the referencing person column; the composite key is (household_id, col) —
 * except `households`, whose own `id` IS the household id.
 */
const EXPECTED: Array<{ table: string; col: string; onDelete: 'a' | 'c' | 'n' }> = [
  { table: 'api_keys', col: 'person_id', onDelete: 'a' },
  { table: 'calendar_accounts', col: 'person_id', onDelete: 'a' },
  { table: 'calendar_oauth_states', col: 'person_id', onDelete: 'a' },
  { table: 'calendars', col: 'person_id', onDelete: 'a' },
  { table: 'chore_instances', col: 'approved_by', onDelete: 'a' },
  { table: 'chore_instances', col: 'claimed_by', onDelete: 'a' },
  { table: 'chore_instances', col: 'completed_by', onDelete: 'a' },
  { table: 'chore_instances', col: 'person_id', onDelete: 'a' },
  { table: 'chores', col: 'person_id', onDelete: 'a' },
  { table: 'countdowns', col: 'created_by', onDelete: 'a' },
  { table: 'event_goal_logs', col: 'created_by', onDelete: 'a' },
  { table: 'event_participants', col: 'person_id', onDelete: 'a' },
  { table: 'event_suggestion_dismissals', col: 'created_by', onDelete: 'a' },
  { table: 'events', col: 'owner_person_id', onDelete: 'a' },
  { table: 'events', col: 'person_id', onDelete: 'a' },
  { table: 'family_night_assignments', col: 'person_id', onDelete: 'n' },
  { table: 'goal_list_members', col: 'person_id', onDelete: 'a' },
  { table: 'goal_logs', col: 'created_by', onDelete: 'a' },
  { table: 'goal_logs', col: 'person_id', onDelete: 'a' },
  { table: 'goal_participants', col: 'person_id', onDelete: 'a' },
  { table: 'goal_steps', col: 'done_by', onDelete: 'a' },
  { table: 'health_goal_logs', col: 'person_id', onDelete: 'c' },
  { table: 'household_invites', col: 'invited_by', onDelete: 'a' },
  { table: 'households', col: 'owner_person_id', onDelete: 'a' },
  { table: 'ics_feeds', col: 'person_id', onDelete: 'a' },
  { table: 'identities', col: 'person_id', onDelete: 'a' },
  { table: 'kiosk_devices', col: 'created_by_person_id', onDelete: 'a' },
  { table: 'kiosk_pairing_codes', col: 'created_by', onDelete: 'a' },
  { table: 'ledger_entries', col: 'created_by', onDelete: 'a' },
  { table: 'ledger_entries', col: 'person_id', onDelete: 'a' },
  { table: 'list_items', col: 'assigned_to', onDelete: 'a' },
  { table: 'list_items', col: 'checked_by', onDelete: 'a' },
  { table: 'list_items', col: 'created_by', onDelete: 'a' },
  { table: 'lists', col: 'created_by', onDelete: 'a' },
  { table: 'meal_plan_entries', col: 'cook_person_id', onDelete: 'a' },
  { table: 'meal_plans', col: 'created_by', onDelete: 'a' },
  { table: 'meals', col: 'created_by', onDelete: 'a' },
  { table: 'photos', col: 'created_by', onDelete: 'a' },
  { table: 'photos', col: 'uploaded_by', onDelete: 'a' },
  { table: 'recipe_views', col: 'person_id', onDelete: 'c' },
  { table: 'reward_redemptions', col: 'decided_by', onDelete: 'a' },
  { table: 'reward_redemptions', col: 'person_id', onDelete: 'a' },
  { table: 'reward_redemptions', col: 'requested_by', onDelete: 'a' },
  { table: 'rhythm_completions', col: 'person_id', onDelete: 'n' },
  { table: 'rhythm_skips', col: 'skipped_by', onDelete: 'n' },
  { table: 'rhythms', col: 'person_id', onDelete: 'n' },
  { table: 'waffled_bite_devices', col: 'created_by_person_id', onDelete: 'a' },
  { table: 'waffled_bite_devices', col: 'person_id', onDelete: 'a' },
  { table: 'waffled_bite_pairing_codes', col: 'created_by', onDelete: 'a' },
  { table: 'waffled_bite_pairing_codes', col: 'person_id', onDelete: 'a' },
]

/** Tables deliberately left on a single-column FK, with the reason. */
const EXEMPT = new Set(['refresh_tokens', 'auth_handoffs', 'meal_recipes'])

type Fk = { table: string; cols: string[]; refCols: string[]; onDelete: string; name: string }

async function personFks(c: Client): Promise<Fk[]> {
  const { rows } = await c.query<{
    conname: string
    child: string
    cols: string
    refcols: string
    del: string
  }>(`
    select con.conname,
           rel.relname as child,
           (select string_agg(att.attname, ',' order by k.ord)
              from unnest(con.conkey) with ordinality k(attnum, ord)
              join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum) as cols,
           (select string_agg(att.attname, ',' order by k.ord)
              from unnest(con.confkey) with ordinality k(attnum, ord)
              join pg_attribute att on att.attrelid = con.confrelid and att.attnum = k.attnum) as refcols,
           con.confdeltype as del
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_class fr on fr.oid = con.confrelid
      join pg_namespace n on n.oid = rel.relnamespace
     where con.contype = 'f' and n.nspname = 'public' and fr.relname = 'persons'
     order by rel.relname, cols`)
  return rows.map((r) => ({
    table: r.child,
    cols: r.cols.split(','),
    refCols: r.refcols.split(','),
    onDelete: r.del,
    name: r.conname,
  }))
}

/** Seeds two households, each with one person. Returns ids. */
async function seedTwoHouseholds(c: Client) {
  const a = (
    await c.query<{ id: string }>(
      `insert into households (name, timezone) values ('A','UTC') returning id`
    )
  ).rows[0].id
  const b = (
    await c.query<{ id: string }>(
      `insert into households (name, timezone) values ('B','UTC') returning id`
    )
  ).rows[0].id
  const pa = (
    await c.query<{ id: string }>(
      `insert into persons (household_id, name, member_type) values ($1,'Ava','adult') returning id`,
      [a]
    )
  ).rows[0].id
  const pb = (
    await c.query<{ id: string }>(
      `insert into persons (household_id, name, member_type) values ($1,'Ben','adult') returning id`,
      [b]
    )
  ).rows[0].id
  return { a, b, pa, pb }
}

describe('composite persons foreign keys — the database refuses cross-household refs', () => {
  let pg: StartedPostgreSqlContainer
  let url: string
  let client: Client

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16').start()
    url = pg.getConnectionUri()
    await runMigrations(url)
    client = new Client({ connectionString: url })
    await client.connect()
  })

  afterAll(async () => {
    await client?.end()
    await pg?.stop()
  })

  it('persons has the unique (household_id, id) key a composite FK needs', async () => {
    const { rows } = await client.query<{ cols: string }>(`
      select (select string_agg(att.attname, ',' order by k.ord)
                from unnest(con.conkey) with ordinality k(attnum, ord)
                join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum) as cols
        from pg_constraint con join pg_class rel on rel.oid = con.conrelid
       where rel.relname = 'persons' and con.contype = 'u'`)
    expect(rows.map((r) => r.cols)).toContain('household_id,id')
  })

  it('rejects a ledger entry stamped with one household and another household’s person', async () => {
    const { a, pb } = await seedTwoHouseholds(client)
    // This is the audit's High finding, at the database layer: household A writing
    // credit onto household B's person.
    const err = await client
      .query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason)
         values ($1,$2,'stars',999,'spot_award')`,
        [a, pb]
      )
      .then(
        () => null,
        (e) => e
      )
    expect(err, 'the insert must be refused').not.toBeNull()
    expect(err.code).toBe('23503') // foreign_key_violation
  })

  it('CONTROL: the same insert with the household’s own person succeeds', async () => {
    const { a, pa } = await seedTwoHouseholds(client)
    await expect(
      client.query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason)
         values ($1,$2,'stars',5,'chore_completed')`,
        [a, pa]
      )
    ).resolves.toBeTruthy()
  })

  it('CONTROL: a NULL person still inserts (MATCH SIMPLE keeps "unassigned" legal)', async () => {
    const { a } = await seedTwoHouseholds(client)
    const chore = (
      await client.query<{ id: string }>(
        `insert into chores (household_id, title) values ($1,'Dishes') returning id`,
        [a]
      )
    ).rows[0].id
    await expect(
      client.query(
        `insert into chore_instances (household_id, chore_id, person_id, due_on)
         values ($1,$2,null,current_date)`,
        [a, chore]
      )
    ).resolves.toBeTruthy()
  })

  it('rejects a foreign person in a nullable attribution column too', async () => {
    const { a, b, pb } = await seedTwoHouseholds(client)
    void b
    const chore = (
      await client.query<{ id: string }>(
        `insert into chores (household_id, title) values ($1,'Trash') returning id`,
        [a]
      )
    ).rows[0].id
    const err = await client
      .query(
        `insert into chore_instances (household_id, chore_id, claimed_by, due_on)
         values ($1,$2,$3,current_date)`,
        [a, chore, pb]
      )
      .then(
        () => null,
        (e) => e
      )
    expect(err).not.toBeNull()
    expect(err.code).toBe('23503')
  })

  it('rejects a household owned by another household’s person', async () => {
    const { a, pb } = await seedTwoHouseholds(client)
    const err = await client
      .query(`update households set owner_person_id = $1 where id = $2`, [pb, a])
      .then(
        () => null,
        (e) => e
      )
    expect(err).not.toBeNull()
    expect(err.code).toBe('23503')
  })

  it('still lets a household own one of its own people', async () => {
    const { a, pa } = await seedTwoHouseholds(client)
    await expect(
      client.query(`update households set owner_person_id = $1 where id = $2`, [pa, a])
    ).resolves.toBeTruthy()
  })

  it('every expected persons reference is composite, with its delete action preserved', async () => {
    const fks = await personFks(client)
    const byKey = new Map(fks.map((f) => [`${f.table}.${f.cols[f.cols.length - 1]}`, f]))
    for (const e of EXPECTED) {
      const key = `${e.table}.${e.col}`
      const fk = byKey.get(key)
      expect(fk, `missing FK for ${key}`).toBeDefined()
      const hh = e.table === 'households' ? 'id' : 'household_id'
      expect(fk!.cols, `${key} must be composite`).toEqual([hh, e.col])
      expect(fk!.refCols, `${key} must target persons (household_id, id)`).toEqual([
        'household_id',
        'id',
      ])
      expect(fk!.onDelete, `${key} delete action changed`).toBe(e.onDelete)
    }
  })

  it('leaves no household-scoped persons reference on a single-column FK', async () => {
    const fks = await personFks(client)
    const single = fks.filter((f) => f.cols.length === 1 && !EXEMPT.has(f.table))
    expect(single.map((f) => `${f.table}.${f.cols[0]}`)).toEqual([])
  })

  it('keeps the auth-internal and join-table references exempt, and only those', async () => {
    const fks = await personFks(client)
    const single = fks.filter((f) => f.cols.length === 1)
    expect(single.map((f) => f.table).sort()).toEqual([...EXEMPT].sort())
  })

  it('every composite FK composes with a NOT NULL household column (no toothless keys)', async () => {
    const fks = await personFks(client)
    const composite = fks.filter((f) => f.cols.length === 2)
    const { rows } = await client.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `select table_name, column_name, is_nullable from information_schema.columns where table_schema='public'`
    )
    const nullable = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable === 'YES']))
    const toothless = composite.filter((f) => nullable.get(`${f.table}.${f.cols[0]}`))
    expect(toothless.map((f) => `${f.table}.${f.cols[0]}`)).toEqual([])
  })
})

describe('composite persons foreign keys — the migration repairs violating rows first', () => {
  let pg: StartedPostgreSqlContainer
  let url: string
  let client: Client
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16').start()
    url = pg.getConnectionUri()
    // Migrate to the state JUST BEFORE this migration, where the single-column FKs
    // still accept a foreign person — i.e. a deployment that ran the buggy writes.
    await runMigrations(url, MIGRATIONS_DIR, countBefore())
    client = new Client({ connectionString: url })
    await client.connect()

    const { a, b, pa, pb } = await seedTwoHouseholds(client)
    Object.assign(ids, { a, b, pa, pb })

    // The audit's High finding: fabricated credit for household B's person, stamped
    // with household A. NOT NULL person column → the row itself is the forgery.
    ids.badLedger = (
      await client.query<{ id: string }>(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason)
         values ($1,$2,'stars',999,'spot_award') returning id`,
        [a, pb]
      )
    ).rows[0].id
    // A legitimate entry in the same household must survive untouched.
    ids.goodLedger = (
      await client.query<{ id: string }>(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason)
         values ($1,$2,'stars',3,'chore_completed') returning id`,
        [a, pa]
      )
    ).rows[0].id

    // A redemption pointing at the forged ledger row — proves the delete order copes
    // with reward_redemptions.ledger_id (ON DELETE NO ACTION).
    const reward = (
      await client.query<{ id: string }>(
        `insert into rewards (household_id, title, cost) values ($1,'Ice cream',10) returning id`,
        [a]
      )
    ).rows[0].id
    ids.badRedemption = (
      await client.query<{ id: string }>(
        `insert into reward_redemptions (household_id, reward_id, person_id, title, cost, ledger_id)
         values ($1,$2,$3,'Ice cream',10,$4) returning id`,
        [a, reward, pb, ids.badLedger]
      )
    ).rows[0].id
    // A redemption for the household's OWN person that happens to point at the forged
    // ledger row: it must survive with ledger_id detached, not be deleted.
    ids.goodRedemption = (
      await client.query<{ id: string }>(
        `insert into reward_redemptions (household_id, reward_id, person_id, title, cost, ledger_id)
         values ($1,$2,$3,'Ice cream',10,$4) returning id`,
        [a, reward, pa, ids.badLedger]
      )
    ).rows[0].id

    // Nullable attribution column: the row is the household's own, only the "who" is
    // foreign — the row must survive with the attribution nulled.
    const chore = (
      await client.query<{ id: string }>(
        `insert into chores (household_id, title) values ($1,'Dishes') returning id`,
        [a]
      )
    ).rows[0].id
    ids.badInstance = (
      await client.query<{ id: string }>(
        `insert into chore_instances (household_id, chore_id, person_id, claimed_by, due_on)
         values ($1,$2,$3,$3,current_date) returning id`,
        [a, chore, pb]
      )
    ).rows[0].id

    // Auth table with a NOT NULL person: household_id is a denormalized copy, so the
    // repair re-stamps it instead of revoking the key.
    ids.badApiKey = (
      await client.query<{ id: string }>(
        `insert into api_keys (household_id, person_id, name, key_hash, key_prefix)
         values ($1,$2,'HA','hash-1','waffled_x') returning id`,
        [a, pb]
      )
    ).rows[0].id

    // A household owned by a foreign person.
    await client.query(`update households set owner_person_id = $1 where id = $2`, [pb, a])

    // Now run the migration under test against this dirty database.
    await runMigrations(url, MIGRATIONS_DIR)
  })

  afterAll(async () => {
    await client?.end()
    await pg?.stop()
  })

  it('applies cleanly on a database that already holds violating rows', async () => {
    const { rows } = await client.query<{ name: string }>(
      `select name from pgmigrations where name like '0101%'`
    )
    expect(rows).toHaveLength(1)
  })

  it('deletes the fabricated ledger entry and keeps the legitimate one', async () => {
    const gone = await client.query(`select 1 from ledger_entries where id = $1`, [ids.badLedger])
    expect(gone.rowCount).toBe(0)
    const kept = await client.query(`select amount from ledger_entries where id = $1`, [
      ids.goodLedger,
    ])
    expect(kept.rowCount).toBe(1)
  })

  it('deletes the redemption filed for a foreign person', async () => {
    const gone = await client.query(`select 1 from reward_redemptions where id = $1`, [
      ids.badRedemption,
    ])
    expect(gone.rowCount).toBe(0)
  })

  it('keeps a legitimate redemption, detaching only its deleted ledger row', async () => {
    const { rows } = await client.query<{ ledger_id: string | null }>(
      `select ledger_id from reward_redemptions where id = $1`,
      [ids.goodRedemption]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].ledger_id).toBeNull()
  })

  it('nulls the foreign attribution but keeps the household’s own row', async () => {
    const { rows } = await client.query<{ person_id: string | null; claimed_by: string | null }>(
      `select person_id, claimed_by from chore_instances where id = $1`,
      [ids.badInstance]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].person_id).toBeNull()
    expect(rows[0].claimed_by).toBeNull()
  })

  it('re-stamps the API key’s household instead of revoking it', async () => {
    const { rows } = await client.query<{ household_id: string; person_id: string }>(
      `select household_id, person_id from api_keys where id = $1`,
      [ids.badApiKey]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].person_id).toBe(ids.pb)
    // household_id now agrees with the household `authenticateApiKey` already used.
    expect(rows[0].household_id).toBe(ids.b)
  })

  it('clears a household owned by a foreign person', async () => {
    const { rows } = await client.query<{ owner_person_id: string | null }>(
      `select owner_person_id from households where id = $1`,
      [ids.a]
    )
    expect(rows[0].owner_person_id).toBeNull()
  })

  it('refuses the same forged write once the constraint is in place', async () => {
    const err = await client
      .query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason)
         values ($1,$2,'stars',999,'spot_award')`,
        [ids.a, ids.pb]
      )
      .then(
        () => null,
        (e) => e
      )
    expect(err).not.toBeNull()
    expect(err.code).toBe('23503')
  })
})

describe('composite persons foreign keys — the Down migration reverses cleanly', () => {
  let pg: StartedPostgreSqlContainer
  let url: string
  let client: Client

  /** Every FK / unique / primary-key constraint in the schema, as comparable text. */
  async function constraintSnapshot(c: Client): Promise<string[]> {
    const { rows } = await c.query<{ def: string }>(`
      select rel.relname || ' :: ' || con.conname || ' :: ' || pg_get_constraintdef(con.oid) as def
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace n on n.oid = rel.relnamespace
       where n.nspname = 'public' and con.contype in ('f', 'u', 'p')
       order by 1`)
    return rows.map((r) => r.def)
  }

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16').start()
    url = pg.getConnectionUri()
    client = new Client({ connectionString: url })
    await client.connect()
  })

  afterAll(async () => {
    await client?.end()
    await pg?.stop()
  })

  it('restores every constraint definition exactly, and re-applies afterwards', async () => {
    await runMigrations(url, MIGRATIONS_DIR, countBefore())
    const before = await constraintSnapshot(client)
    // Sanity: the "before" state really is the single-column one.
    expect(before.some((d) => d.includes('FOREIGN KEY (household_id, person_id)'))).toBe(false)

    await runMigrations(url, MIGRATIONS_DIR)
    const after = await constraintSnapshot(client)
    expect(after).not.toEqual(before)

    await runner({
      databaseUrl: url,
      dir: MIGRATIONS_DIR,
      direction: 'down',
      migrationsTable: 'pgmigrations',
      count: 1,
      noLock: true,
      checkOrder: false,
      log: () => {},
    })
    // Not "it didn't error" — the exact same constraint definitions, names and delete
    // actions as before the migration ran.
    expect(await constraintSnapshot(client)).toEqual(before)

    // And it goes back up on a database that has already been down once.
    await runMigrations(url, MIGRATIONS_DIR)
    expect(await constraintSnapshot(client)).toEqual(after)
  })
})

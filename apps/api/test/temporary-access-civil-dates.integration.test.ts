import { describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runner } from 'node-pg-migrate'
import { PostgreSqlContainer } from './helpers/pg'
import { runMigrations } from '../src/migrate'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const MIGRATION = '0103_temporary_access_civil_dates'

function migrationsBefore(name: string): number {
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()
  const index = files.findIndex((file) => file.startsWith(name))
  if (index < 0) throw new Error(`migration ${name} not found`)
  return index
}

describe('0103 temporary-access civil dates', () => {
  it('fails preflight clearly and leaves the schema untouched for a legacy invalid timezone', async () => {
    const pg = await new PostgreSqlContainer('postgres:16').start()
    const client = new Client({ connectionString: pg.getConnectionUri() })
    try {
      await runMigrations(pg.getConnectionUri(), migrationsDir, migrationsBefore(MIGRATION))
      await client.connect()
      const household = await client.query<{ id: string }>(
        `insert into households (name, timezone) values ('Invalid legacy zone', 'Mars/Olympus') returning id`
      )
      await client.query(
        `insert into persons (household_id, name, member_type, access_expires_at)
         values ($1, 'Legacy helper', 'caregiver', '2099-06-16T00:00:00Z')`,
        [household.rows[0].id]
      )

      await expect(runMigrations(pg.getConnectionUri(), migrationsDir)).rejects.toThrow(
        /invalid timezone 'Mars\/Olympus'/i
      )

      const columns = await client.query(
        `select 1
           from information_schema.columns
          where table_schema = 'public'
            and table_name in ('persons', 'household_invites')
            and column_name = 'access_ends_on'`
      )
      expect(columns.rows).toHaveLength(0)
    } finally {
      await client.end().catch(() => {})
      await pg.stop()
    }
  }, 120_000)

  it('upgrades 0102 exact instants to canonical household-local dates', async () => {
    const pg = await new PostgreSqlContainer('postgres:16').start()
    const client = new Client({ connectionString: pg.getConnectionUri() })
    try {
      await runMigrations(pg.getConnectionUri(), migrationsDir, migrationsBefore(MIGRATION))
      await client.connect()
      const household = await client.query<{ id: string }>(
        `insert into households (name, timezone) values ('Legacy access', 'America/Chicago') returning id`
      )
      const householdId = household.rows[0].id

      await client.query(
        `insert into persons (household_id, name, member_type, access_expires_at) values
          ($1, 'Midnight helper', 'caregiver', '2099-06-16T05:00:00Z'),
          ($1, 'Midday helper', 'guest', '2099-06-16T12:00:00Z'),
          ($1, 'IOS end-of-day helper', 'caregiver', '2099-06-16T04:59:59Z'),
          ($1, 'Web end-of-day helper', 'guest', '2099-06-16T04:59:59.999Z'),
          ($1, 'Permanent member', 'adult', null)`,
        [householdId]
      )
      await client.query(
        `insert into household_invites (household_id, email, member_type, access_expires_at) values
          ($1, 'helper@example.com', 'caregiver', '2099-06-16T05:00:00Z'),
          ($1, 'ios-helper@example.com', 'guest', '2099-06-16T04:59:59Z'),
          ($1, 'web-helper@example.com', 'guest', '2099-06-16T04:59:59.999Z'),
          ($1, 'duplicate@example.com', 'caregiver', null),
          ($1, 'DUPLICATE@example.com', 'caregiver', null)`,
        [householdId]
      )

      await runMigrations(pg.getConnectionUri(), migrationsDir)

      const people = await client.query<{
        name: string
        access_ends_on: string | null
        access_expires_at: Date | null
      }>(
        `select name, access_ends_on::text, access_expires_at
           from persons where household_id = $1 order by name`,
        [householdId]
      )
      expect(people.rows.map((row) => ({
        ...row,
        access_expires_at: row.access_expires_at?.toISOString() ?? null,
      }))).toEqual([
        {
          name: 'IOS end-of-day helper',
          access_ends_on: '2099-06-15',
          access_expires_at: '2099-06-16T05:00:00.000Z',
        },
        {
          name: 'Midday helper',
          access_ends_on: '2099-06-15',
          access_expires_at: '2099-06-16T05:00:00.000Z',
        },
        {
          name: 'Midnight helper',
          access_ends_on: '2099-06-15',
          access_expires_at: '2099-06-16T05:00:00.000Z',
        },
        { name: 'Permanent member', access_ends_on: null, access_expires_at: null },
        {
          name: 'Web end-of-day helper',
          access_ends_on: '2099-06-15',
          access_expires_at: '2099-06-16T05:00:00.000Z',
        },
      ])

      const invites = await client.query<{ email: string; access_ends_on: string; access_expires_at: Date }>(
        `select email, access_ends_on::text, access_expires_at
           from household_invites
          where household_id = $1 and lower(email) <> 'duplicate@example.com'
          order by email`,
        [householdId]
      )
      expect(invites.rows.map((row) => ({
        ...row,
        access_expires_at: row.access_expires_at.toISOString(),
      }))).toEqual([
        { email: 'helper@example.com', access_ends_on: '2099-06-15', access_expires_at: '2099-06-16T05:00:00.000Z' },
        { email: 'ios-helper@example.com', access_ends_on: '2099-06-15', access_expires_at: '2099-06-16T05:00:00.000Z' },
        { email: 'web-helper@example.com', access_ends_on: '2099-06-15', access_expires_at: '2099-06-16T05:00:00.000Z' },
      ])

      const duplicates = await client.query<{ pending: string; revoked: string }>(
        `select count(*) filter (where revoked_at is null)::text as pending,
                count(*) filter (where revoked_at is not null)::text as revoked
           from household_invites
          where household_id = $1 and lower(email) = 'duplicate@example.com'`,
        [householdId]
      )
      expect(duplicates.rows[0]).toEqual({ pending: '1', revoked: '1' })
      await expect(client.query(
        `insert into household_invites (household_id, email, member_type)
         values ($1, 'Duplicate@example.com', 'caregiver')`,
        [householdId]
      )).rejects.toThrow()
    } finally {
      await client.end().catch(() => {})
      await pg.stop()
    }
  }, 120_000)

  it('canonicalizes both date-first and legacy-instant writes in PostgreSQL', async () => {
    const pg = await new PostgreSqlContainer('postgres:16').start()
    const client = new Client({ connectionString: pg.getConnectionUri() })
    try {
      await runMigrations(pg.getConnectionUri())
      await client.connect()
      const household = await client.query<{ id: string }>(
        `insert into households (name, timezone) values ('Canonical access', 'America/Chicago') returning id`
      )
      const householdId = household.rows[0].id

      const dateFirst = await client.query<{ access_ends_on: string; access_expires_at: Date }>(
        `insert into persons
           (household_id, name, member_type, access_ends_on, access_expires_at)
         values ($1, 'Date first', 'caregiver', '2099-06-15', '2000-01-01T00:00:00Z')
         returning access_ends_on::text, access_expires_at`,
        [householdId]
      )
      expect(dateFirst.rows[0].access_ends_on).toBe('2099-06-15')
      expect(dateFirst.rows[0].access_expires_at.toISOString()).toBe('2099-06-16T05:00:00.000Z')

      const legacy = await client.query<{ access_ends_on: string; access_expires_at: Date }>(
        `insert into household_invites
           (household_id, email, member_type, access_expires_at)
         values ($1, 'legacy@example.com', 'guest', '2099-06-16T06:00:00Z')
         returning access_ends_on::text, access_expires_at`,
        [householdId]
      )
      expect(legacy.rows[0].access_ends_on).toBe('2099-06-15')
      expect(legacy.rows[0].access_expires_at.toISOString()).toBe('2099-06-16T05:00:00.000Z')

      await expect(client.query(
        `insert into persons (household_id, name, member_type, access_ends_on)
         values ($1, 'Invalid permanent access', 'adult', '2099-06-15')`,
        [householdId]
      )).rejects.toThrow()

      await client.query(`update households set timezone = 'Pacific/Honolulu' where id = $1`, [householdId])
      const refreshed = await client.query<{ name: string; access_ends_on: string; access_expires_at: Date }>(
        `select name, access_ends_on::text, access_expires_at
           from persons where household_id = $1 and name = 'Date first'`,
        [householdId]
      )
      expect(refreshed.rows[0].access_ends_on).toBe('2099-06-15')
      expect(refreshed.rows[0].access_expires_at.toISOString()).toBe('2099-06-16T10:00:00.000Z')
    } finally {
      await client.end().catch(() => {})
      await pg.stop()
    }
  }, 120_000)

  it('waits for a concurrent timezone patch and derives from the committed zone', async () => {
    const pg = await new PostgreSqlContainer('postgres:16').start()
    const timezoneClient = new Client({ connectionString: pg.getConnectionUri() })
    const writerClient = new Client({ connectionString: pg.getConnectionUri() })
    try {
      await runMigrations(pg.getConnectionUri())
      await timezoneClient.connect()
      await writerClient.connect()
      await timezoneClient.query(`set statement_timeout = '5s'`)
      await writerClient.query(`set statement_timeout = '5s'`)
      const household = await timezoneClient.query<{ id: string }>(
        `insert into households (name, timezone) values ('Concurrent access', 'America/Chicago') returning id`
      )
      const householdId = household.rows[0].id
      const writerPid = (await writerClient.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid

      await timezoneClient.query('begin')
      await timezoneClient.query(
        `update households set timezone = 'Pacific/Honolulu' where id = $1`,
        [householdId]
      )

      const pendingWrite = writerClient.query<{ access_ends_on: string; access_expires_at: Date }>(
        `insert into persons
           (household_id, name, member_type, access_ends_on, access_expires_at)
         values ($1, 'Concurrent helper', 'caregiver', '2099-06-15', '2099-06-16T05:00:00Z')
         returning access_ends_on::text, access_expires_at`,
        [householdId]
      )

      let observedLockWait = false
      for (let attempt = 0; attempt < 100; attempt++) {
        const activity = await timezoneClient.query<{ wait_event_type: string | null }>(
          `select wait_event_type from pg_stat_activity where pid = $1`,
          [writerPid]
        )
        if (activity.rows[0]?.wait_event_type === 'Lock') {
          observedLockWait = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      await timezoneClient.query('commit')
      const inserted = await pendingWrite
      expect(observedLockWait).toBe(true)
      expect(inserted.rows[0].access_ends_on).toBe('2099-06-15')
      expect(inserted.rows[0].access_expires_at.toISOString()).toBe('2099-06-16T10:00:00.000Z')
    } finally {
      await timezoneClient.query('rollback').catch(() => {})
      await writerClient.end().catch(() => {})
      await timezoneClient.end().catch(() => {})
      await pg.stop()
    }
  }, 120_000)

  it('locks deployment parent -> invite -> person and excludes timezone writes from the backfill', async () => {
    const pg = await new PostgreSqlContainer('postgres:16').start()
    const blocker = new Client({ connectionString: pg.getConnectionUri() })
    const timezoneClient = new Client({ connectionString: pg.getConnectionUri() })
    let pendingMigration: Promise<void> | undefined
    let pendingTimezone: Promise<unknown> | undefined
    try {
      await runMigrations(pg.getConnectionUri(), migrationsDir, migrationsBefore(MIGRATION))
      await Promise.all([blocker.connect(), timezoneClient.connect()])
      await blocker.query(`set statement_timeout = '10s'`)
      await timezoneClient.query(`set statement_timeout = '10s'`)

      const household = await blocker.query<{ id: string }>(
        `insert into households (name, timezone) values ('Deploy race', 'America/Chicago') returning id`
      )
      const householdId = household.rows[0].id
      const person = await blocker.query<{ id: string }>(
        `insert into persons (household_id, name, member_type, access_expires_at)
         values ($1, 'Legacy helper', 'caregiver', '2099-06-16T05:00:00Z') returning id`,
        [householdId]
      )
      const invite = await blocker.query<{ id: string }>(
        `insert into household_invites (household_id, email, member_type, access_expires_at)
         values ($1, 'deploy-race@example.com', 'guest', '2099-06-16T05:00:00Z') returning id`,
        [householdId]
      )

      // Model the pre-0103 acceptance order: invite first, then person. The migration
      // must wait for this invite without already holding the person table.
      await blocker.query('begin')
      await blocker.query(`select id from household_invites where id = $1 for update`, [invite.rows[0].id])
      pendingMigration = runMigrations(pg.getConnectionUri(), migrationsDir)

      let migrationIsWaiting = false
      for (let attempt = 0; attempt < 200; attempt++) {
        await blocker.query(`select pg_stat_clear_snapshot()`)
        const activity = await blocker.query<{ waiting: boolean }>(
          `select exists (
             select 1 from pg_stat_activity
              where datname = current_database()
                and pid <> pg_backend_pid()
                and state = 'active'
                and wait_event_type = 'Lock'
                and query ilike '%lock table household_invites%'
           ) as waiting`
        )
        if (activity.rows[0].waiting) {
          migrationIsWaiting = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(migrationIsWaiting).toBe(true)

      // Once migration starts it holds a SHARE table lock on households, so this
      // timezone write must remain outside the entire backfill/install transaction.
      const timezonePid = (await timezoneClient.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid
      pendingTimezone = timezoneClient.query(
        `update households set timezone = 'Pacific/Honolulu' where id = $1`,
        [householdId]
      )
      let timezoneIsWaiting = false
      for (let attempt = 0; attempt < 200; attempt++) {
        await blocker.query(`select pg_stat_clear_snapshot()`)
        const activity = await blocker.query<{ wait_event_type: string | null }>(
          `select wait_event_type from pg_stat_activity where pid = $1`,
          [timezonePid]
        )
        if (activity.rows[0]?.wait_event_type === 'Lock') {
          timezoneIsWaiting = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(timezoneIsWaiting).toBe(true)

      // This is the lock-order assertion: it completes while migration waits for
      // the invite. The old persons -> invites DDL order deadlocked here.
      await blocker.query(`select id from persons where id = $1 for update`, [person.rows[0].id])
      await blocker.query('commit')

      await Promise.all([pendingMigration, pendingTimezone])
      pendingMigration = undefined
      pendingTimezone = undefined
      const canonical = await blocker.query<{
        timezone: string
        person_end: string
        person_expiry: Date
        invite_end: string
        invite_expiry: Date
      }>(
        `select h.timezone, p.access_ends_on::text as person_end,
                p.access_expires_at as person_expiry,
                hi.access_ends_on::text as invite_end,
                hi.access_expires_at as invite_expiry
           from households h
           join persons p on p.id = $2
           join household_invites hi on hi.id = $3
          where h.id = $1`,
        [householdId, person.rows[0].id, invite.rows[0].id]
      )
      expect(canonical.rows[0]).toMatchObject({
        timezone: 'Pacific/Honolulu',
        person_end: '2099-06-15',
        invite_end: '2099-06-15',
      })
      expect(canonical.rows[0].person_expiry.toISOString()).toBe('2099-06-16T10:00:00.000Z')
      expect(canonical.rows[0].invite_expiry.toISOString()).toBe('2099-06-16T10:00:00.000Z')
    } finally {
      await blocker.query('rollback').catch(() => {})
      await Promise.allSettled([pendingMigration, pendingTimezone].filter(Boolean))
      await Promise.all([blocker.end().catch(() => {}), timezoneClient.end().catch(() => {})])
      await pg.stop()
    }
  }, 120_000)

  it('rolls back the civil-date layer while preserving the 0102 expiry contract', async () => {
    const pg = await new PostgreSqlContainer('postgres:16').start()
    const client = new Client({ connectionString: pg.getConnectionUri() })
    try {
      await runMigrations(pg.getConnectionUri())
      await runner({
        databaseUrl: pg.getConnectionUri(),
        dir: migrationsDir,
        direction: 'down',
        migrationsTable: 'pgmigrations',
        count: 1,
        noLock: true,
        checkOrder: false,
        log: () => {},
      })
      await client.connect()

      const columns = await client.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'public'
            and table_name in ('persons', 'household_invites')
            and column_name in ('access_ends_on', 'access_expires_at')
          order by table_name, column_name`
      )
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'access_expires_at',
        'access_expires_at',
      ])

      const household = await client.query<{ id: string }>(
        `insert into households (name, timezone) values ('Rolled back', 'UTC') returning id`
      )
      await client.query(
        `insert into persons (household_id, name, member_type, access_expires_at)
         values ($1, 'Legacy helper', 'caregiver', '2099-06-16T00:00:00Z')`,
        [household.rows[0].id]
      )
      await expect(client.query(
        `insert into persons (household_id, name, member_type, access_expires_at)
         values ($1, 'Invalid adult', 'adult', '2099-06-16T00:00:00Z')`,
        [household.rows[0].id]
      )).rejects.toThrow()
    } finally {
      await client.end().catch(() => {})
      await pg.stop()
    }
  }, 120_000)
})

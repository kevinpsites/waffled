import { describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer } from './helpers/pg'
import { runMigrations } from '../src/migrate'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const MIGRATION = '0092_caregiver_guest_roles'

function migrationsBefore(name: string): number {
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()
  const index = files.findIndex((file) => file.startsWith(name))
  if (index < 0) throw new Error(`migration ${name} not found`)
  return index
}

describe('0092 caregiver and guest roles', () => {
  it('normalizes unconstrained legacy roles before adding role checks', async () => {
    const pg = await new PostgreSqlContainer('postgres:16').start()
    const client = new Client({ connectionString: pg.getConnectionUri() })
    try {
      await runMigrations(pg.getConnectionUri(), migrationsDir, migrationsBefore(MIGRATION))
      await client.connect()
      const household = await client.query<{ id: string }>(
        `insert into households (name, timezone) values ('Legacy', 'UTC') returning id`
      )
      const householdId = household.rows[0].id

      await client.query(
        `insert into persons (household_id, name, member_type, is_admin) values
          ($1, 'Legacy admin', 'teen', true),
          ($1, 'Unknown role', 'visitor', false)`,
        [householdId]
      )
      await client.query(
        `insert into household_invites (household_id, email, member_type, is_admin) values
          ($1, 'admin@example.com', 'kid', true),
          ($1, 'unknown@example.com', 'house-sitter', false)`,
        [householdId]
      )

      await runMigrations(pg.getConnectionUri(), migrationsDir)

      const people = await client.query<{ name: string; member_type: string; is_admin: boolean }>(
        `select name, member_type, is_admin from persons where household_id = $1 order by name`,
        [householdId]
      )
      expect(people.rows).toEqual([
        { name: 'Legacy admin', member_type: 'adult', is_admin: true },
        { name: 'Unknown role', member_type: 'guest', is_admin: false },
      ])

      const invites = await client.query<{ email: string; member_type: string; is_admin: boolean }>(
        `select email, member_type, is_admin from household_invites where household_id = $1 order by email`,
        [householdId]
      )
      expect(invites.rows).toEqual([
        { email: 'admin@example.com', member_type: 'adult', is_admin: true },
        { email: 'unknown@example.com', member_type: 'guest', is_admin: false },
      ])

      await expect(
        client.query(
          `insert into persons (household_id, name, member_type, is_admin) values ($1, 'Bad admin', 'guest', true)`,
          [householdId]
        )
      ).rejects.toThrow()
      await expect(
        client.query(
          `insert into persons (household_id, name, member_type, access_expires_at)
           values ($1, 'Bad expiry', 'adult', now() + interval '1 day')`,
          [householdId]
        )
      ).rejects.toThrow()
    } finally {
      await client.end().catch(() => {})
      await pg.stop()
    }
  }, 120_000)
})

// Weekly digest — builder content + scheduler send/idempotency against a throwaway
// Postgres, with an injected fake SMTP transport (no socket).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import { DateTime } from 'luxon'
import { runMigrations } from '../src/migrate'

let pg: StartedPostgreSqlContainer
let url: string
let closePool: () => Promise<void>
let buildWeeklyDigest: (typeof import('../src/modules/email/digest.service'))['buildWeeklyDigest']
let sendDueDigests: (typeof import('../src/modules/email/weekly-digest.service'))['sendDueDigests']
let upsertEmailSettings: (typeof import('../src/modules/email/email-settings.service'))['upsertEmailSettings']
let setTransportFactory: (typeof import('../src/platform/email'))['setTransportFactory']
let householdId = ''
const sentMail: Array<Record<string, unknown>> = []

// Monday 2026-07-06 14:00Z = 09:00 America/Chicago (CDT). weekday=1, hour=9.
const NOW = DateTime.fromISO('2026-07-06T14:00:00Z')
const WEEK_START = '2026-07-06'
const TZ = 'America/Chicago'

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.from('01234567890123456789012345678901').toString('base64')
  delete process.env.AUTH0_DOMAIN

  buildWeeklyDigest = (await import('../src/modules/email/digest.service')).buildWeeklyDigest
  sendDueDigests = (await import('../src/modules/email/weekly-digest.service')).sendDueDigests
  upsertEmailSettings = (await import('../src/modules/email/email-settings.service')).upsertEmailSettings
  setTransportFactory = (await import('../src/platform/email')).setTransportFactory
  closePool = (await import('../src/platform/db')).closePool

  setTransportFactory(() => ({
    async sendMail(opts: Record<string, unknown>) {
      sentMail.push(opts)
      return { messageId: 'test' }
    },
  }))

  // Seed a household + an adult with an emailed account, plus a week of data.
  await withClient(async (c) => {
    const h = await c.query<{ id: string }>(
      `insert into households (name, timezone) values ('Sites', $1) returning id`,
      [TZ]
    )
    householdId = h.rows[0].id
    const acct = await c.query<{ id: string }>(
      `insert into accounts (email) values ('kevin@example.com') returning id`
    )
    const kev = await c.query<{ id: string }>(
      `insert into persons (household_id, name, member_type, is_admin, account_id) values ($1,'Kevin','adult',true,$2) returning id`,
      [householdId, acct.rows[0].id]
    )
    const kevinId = kev.rows[0].id

    // Calendar event inside the window.
    await c.query(
      `insert into events (household_id, title, starts_at, timezone) values ($1,'Dentist','2026-07-07T15:00:00Z',$2)`,
      [householdId, TZ]
    )
    // Meal plan entry.
    const mp = await c.query<{ id: string }>(
      `insert into meal_plans (household_id, start_date, end_date) values ($1,$2,$3) returning id`,
      [householdId, WEEK_START, '2026-07-12']
    )
    await c.query(
      `insert into meal_plan_entries (household_id, meal_plan_id, date, meal_type, title) values ($1,$2,'2026-07-07','dinner','Tacos')`,
      [householdId, mp.rows[0].id]
    )
    // A pending chore this week.
    const chore = await c.query<{ id: string }>(
      `insert into chores (household_id, title) values ($1,'Dishes') returning id`,
      [householdId]
    )
    await c.query(
      `insert into chore_instances (household_id, chore_id, person_id, due_on, status) values ($1,$2,$3,'2026-07-08','pending')`,
      [householdId, chore.rows[0].id, kevinId]
    )
    // A grocery item.
    const list = await c.query<{ id: string }>(
      `insert into lists (household_id, name, list_type) values ($1,'Groceries','grocery') returning id`,
      [householdId]
    )
    await c.query(
      `insert into list_items (household_id, list_id, name) values ($1,$2,'Milk')`,
      [householdId, list.rows[0].id]
    )
  })
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('buildWeeklyDigest', () => {
  it('summarizes calendar, meals, chores, and grocery for the week', async () => {
    const d = await buildWeeklyDigest(householdId, WEEK_START)
    expect(d.subject).toContain('Sites')
    expect(d.html).toContain('Dentist')
    expect(d.html).toContain('Tacos')
    expect(d.html).toContain('due this week') // "1 chore due this week"
    expect(d.html).toContain('Kevin: 1')
    expect(d.html).toContain('Milk')
    expect(d.text).toContain('CALENDAR')
    // Regression guard: dates must render (pg returns Date objects, not ISO strings).
    // 2026-07-07 is a Tuesday in America/Chicago.
    expect(d.html).toContain('Tue 7')
    expect(d.html).not.toContain('Invalid DateTime')
    expect(d.html).not.toContain('undefined')
  })

  it('honors the sections filter', async () => {
    const d = await buildWeeklyDigest(householdId, WEEK_START, ['grocery'])
    expect(d.html).toContain('Milk')
    expect(d.html).not.toContain('Dentist')
  })
})

describe('sendDueDigests', () => {
  it('sends once at the configured local time and is idempotent per week', async () => {
    await upsertEmailSettings(householdId, {
      enabled: true,
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      username: 'me@gmail.com',
      password: 'app-pw',
      digestEnabled: true,
      digestDow: 1, // Monday
      digestHour: 9,
    })
    sentMail.length = 0

    const first = await sendDueDigests(NOW)
    expect(first.sent).toBe(1)
    expect(sentMail).toHaveLength(1)
    expect(sentMail[0].to).toBe('kevin@example.com')

    // Second tick in the same hour/week must NOT re-send (per-week claim).
    const second = await sendDueDigests(NOW)
    expect(second.sent).toBe(0)
    expect(sentMail).toHaveLength(1)

    const del = await withClient((c) =>
      c.query<{ n: string }>(
        `select count(*)::text as n from email_deliveries where household_id = $1 and kind = 'weekly_digest'`,
        [householdId]
      )
    )
    expect(del.rows[0].n).toBe('1')
  })

  it('does not send off-schedule (wrong weekday)', async () => {
    sentMail.length = 0
    // Tuesday
    const res = await sendDueDigests(NOW.plus({ days: 1 }))
    expect(res.sent).toBe(0)
    expect(sentMail).toHaveLength(0)
  })
})

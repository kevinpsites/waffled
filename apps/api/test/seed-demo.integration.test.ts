// Demo seed ("The Seinfelds") — guards the calendar-fill offset math the way the
// PR review asked for: after seeding, "this week" and "next week" are always
// populated regardless of the weekday the seed runs, every event lands in the
// intended rolling window, and the countdowns are seed-day-anchored so their
// "N sleeps" numbers are exact & reproducible. Own Postgres testcontainer,
// mirroring the other *.integration.test.ts harnesses.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import { runMigrations } from '../src/migrate'

let pg: StartedPostgreSqlContainer
let url: string
let closePool: () => Promise<void>

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try { return await fn(client) } finally { await client.end() }
}

// (title, is_countdown, offset-in-days-from-today of the NY-local start date)
interface Ev { title: string; is_countdown: boolean; off: number }

let events: Ev[] = []

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  const db = await import('../src/platform/db')
  closePool = db.closePool

  // Drive the real seeder against the throwaway DB, then read back what it wrote.
  const { seedBase } = await import('../scripts/seed-demo')
  await seedBase()

  const hh = await withClient((c) =>
    c.query<{ id: string }>(`select id from households where name='The Seinfelds' and deleted_at is null`))
  const householdId = hh.rows[0].id
  const rows = await withClient((c) =>
    c.query<Ev>(
      `select title, is_countdown,
              ((starts_at at time zone 'America/New_York')::date - current_date)::int as off
         from events where household_id=$1`, [householdId]))
  events = rows.rows
}, 120_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('demo seed — calendar fill', () => {
  it('seeds a batch of non-countdown calendar events', () => {
    const timed = events.filter((e) => !e.is_countdown)
    expect(timed.length).toBeGreaterThan(20)
  })

  it('always populates this week and next week (regardless of seed weekday)', () => {
    const timed = events.filter((e) => !e.is_countdown)
    // Farmers market lands at offset 6-dow ∈ [0,6] this week and 13-dow ∈ [7,13] next
    // week for every possible weekday, so both buckets are guaranteed non-empty.
    expect(timed.some((e) => e.off >= 0 && e.off <= 6)).toBe(true)
    expect(timed.some((e) => e.off >= 7 && e.off <= 13)).toBe(true)
  })

  it('keeps every non-countdown event inside the rolling ~5-week window', () => {
    const timed = events.filter((e) => !e.is_countdown)
    // Week-Sunday anchored: param days run -6..+27, minus dow (0..6) → real offsets
    // never below -13 nor above 27.
    for (const e of timed) {
      expect(e.off).toBeGreaterThanOrEqual(-13)
      expect(e.off).toBeLessThanOrEqual(27)
    }
  })

  it('anchors countdowns to the seed day so the sleeps count is exact & reproducible', () => {
    const hamptons = events.find((e) => e.title.includes('Hamptons'))
    const school = events.find((e) => e.title.includes('First day of school'))
    expect(hamptons?.is_countdown).toBe(true)
    expect(school?.is_countdown).toBe(true)
    // Exact — not week-anchored (which would drift these up to 6 days by seed weekday).
    expect(hamptons?.off).toBe(20)
    expect(school?.off).toBe(44)
  })
})

describe('demo seed — safety gate', () => {
  it('is disabled unless WAFFLED_ALLOW_DEMO_SEED is explicitly enabled', async () => {
    const { demoSeedEnabled } = await import('../scripts/seed-demo')
    expect(demoSeedEnabled({})).toBe(false)
    expect(demoSeedEnabled({ WAFFLED_ALLOW_DEMO_SEED: '' })).toBe(false)
    expect(demoSeedEnabled({ WAFFLED_ALLOW_DEMO_SEED: '0' })).toBe(false)
    expect(demoSeedEnabled({ WAFFLED_ALLOW_DEMO_SEED: 'false' })).toBe(false)
    expect(demoSeedEnabled({ WAFFLED_ALLOW_DEMO_SEED: '1' })).toBe(true)
    expect(demoSeedEnabled({ WAFFLED_ALLOW_DEMO_SEED: 'true' })).toBe(true)
    expect(demoSeedEnabled({ WAFFLED_ALLOW_DEMO_SEED: 'YES' })).toBe(true)
  })
})

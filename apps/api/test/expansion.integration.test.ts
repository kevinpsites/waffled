// Recurrence expansion worker — materializes Waffled-native masters into
// event_occurrences against a real Postgres (Testcontainers). Covers count/inherited
// fields, idempotent re-runs (stable row ids), override move + cancel, and clearing
// occurrences when a master stops recurring.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import { runMigrations } from '../src/migrate'

let pg: StartedPostgreSqlContainer
let url: string
let closePool: () => Promise<void>
let materializeHousehold: (h: string, now?: Date) => Promise<number>
let materializeMaster: (id: string, now?: Date) => Promise<number>

let hid = ''
let pid = ''
let eventId = ''

const NOW = new Date('2026-01-15T12:00:00Z')

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  const svc = await import('../src/modules/calendar/expansion.service')
  materializeHousehold = svc.materializeHousehold
  materializeMaster = svc.materializeMaster
  closePool = (await import('../src/platform/db')).closePool

  await withClient(async (c) => {
    const h = await c.query<{ id: string }>(`insert into households (name, timezone) values ('R','America/Chicago') returning id`)
    hid = h.rows[0].id
    const p = await c.query<{ id: string }>(`insert into persons (household_id, name, member_type) values ($1,'Kid','kid') returning id`, [hid])
    pid = p.rows[0].id
    // Weekly Tuesday 9am CST, bounded so the count is deterministic: Jan 6,13,20,27.
    const e = await c.query<{ id: string }>(
      `insert into events (household_id, title, location, starts_at, ends_at, timezone, person_id, rrule, recurrence_end_at)
       values ($1,'Soccer','Field','2026-01-06T15:00:00Z','2026-01-06T16:00:00Z','America/Chicago',$2,
               'FREQ=WEEKLY;BYDAY=TU','2026-01-27T23:59:59Z') returning id`,
      [hid, pid],
    )
    eventId = e.rows[0].id
  })
})

afterAll(async () => {
  await closePool?.()
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

const activeOccurrences = () =>
  withClient((c) =>
    c.query<{ original_start: Date; starts_at: Date; ends_at: Date; person_id: string; title: string; override_id: string | null; starts_on: string }>(
      `select original_start, starts_at, ends_at, person_id, title, override_id, starts_on::text as starts_on
         from event_occurrences where event_id = $1 and deleted_at is null order by starts_at`,
      [eventId],
    ).then((r) => r.rows),
  )

describe('expansion.service', () => {
  it('materializes a bounded weekly series with inherited fields', async () => {
    const n = await materializeHousehold(hid, NOW)
    expect(n).toBe(4)
    const occ = await activeOccurrences()
    expect(occ).toHaveLength(4)
    expect(occ[0].starts_at.toISOString()).toBe('2026-01-06T15:00:00.000Z')
    expect(occ[3].starts_at.toISOString()).toBe('2026-01-27T15:00:00.000Z')
    expect(occ[0].ends_at.toISOString()).toBe('2026-01-06T16:00:00.000Z') // 1h duration carried
    expect(occ[0].person_id).toBe(pid) // inherited from master
    expect(occ[0].title).toBe('Soccer')
    expect(occ[0].starts_on).toBe('2026-01-06') // local day bucket
    expect(occ[0].override_id).toBeNull()
  })

  it('is idempotent — a second run keeps the same row ids (no PowerSync churn)', async () => {
    const idsBefore = await withClient((c) =>
      c.query<{ id: string }>(`select id from event_occurrences where event_id=$1 order by original_start`, [eventId]).then((r) => r.rows.map((x) => x.id)),
    )
    await materializeMaster(eventId, NOW)
    const idsAfter = await withClient((c) =>
      c.query<{ id: string }>(`select id from event_occurrences where event_id=$1 and deleted_at is null order by original_start`, [eventId]).then((r) => r.rows.map((x) => x.id)),
    )
    expect(idsAfter).toEqual(idsBefore)
  })

  it('applies a move override (new time + override_id) keyed by original start', async () => {
    await withClient((c) =>
      c.query(
        `insert into event_overrides (household_id, event_id, original_start, starts_at, ends_at, title)
         values ($1,$2,'2026-01-13T15:00:00Z','2026-01-13T17:00:00Z','2026-01-13T18:00:00Z','Soccer (moved)')`,
        [hid, eventId],
      ),
    )
    await materializeMaster(eventId, NOW)
    const occ = await activeOccurrences()
    const moved = occ.find((o) => o.original_start.toISOString() === '2026-01-13T15:00:00.000Z')!
    expect(moved.starts_at.toISOString()).toBe('2026-01-13T17:00:00.000Z')
    expect(moved.title).toBe('Soccer (moved)')
    expect(moved.override_id).not.toBeNull()
    expect(occ).toHaveLength(4)
  })

  it('removes a cancelled occurrence and tombstones its row', async () => {
    await withClient((c) =>
      c.query(
        `insert into event_overrides (household_id, event_id, original_start, is_cancelled)
         values ($1,$2,'2026-01-20T15:00:00Z',true)`,
        [hid, eventId],
      ),
    )
    await materializeMaster(eventId, NOW)
    const occ = await activeOccurrences()
    expect(occ.map((o) => o.original_start.toISOString())).not.toContain('2026-01-20T15:00:00.000Z')
    expect(occ).toHaveLength(3)
    const tomb = await withClient((c) =>
      c.query(`select 1 from event_occurrences where event_id=$1 and original_start='2026-01-20T15:00:00Z' and deleted_at is not null`, [eventId]),
    )
    expect(tomb.rowCount).toBe(1)
  })

  it('tombstones all occurrences when the master stops recurring', async () => {
    await withClient((c) => c.query(`update events set rrule = null where id = $1`, [eventId]))
    const n = await materializeMaster(eventId, NOW)
    expect(n).toBe(0)
    const occ = await activeOccurrences()
    expect(occ).toHaveLength(0)
  })
})

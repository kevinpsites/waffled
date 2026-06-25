// Materializes Nook-native recurring masters into event_occurrences — the read
// model clients render. Calls the pure expand() engine over a rolling window and
// upserts the result, keyed by (event_id, original_start) so row ids stay stable
// (PowerSync doesn't re-stream the whole series each run). Runs on a dedicated,
// Google-independent tick (a self-hosted family with no Google still needs this)
// plus on-demand right after a master is created/edited so it appears immediately.
//
// Google-sourced recurrences are NOT handled here — Google sync expands them itself
// into individual events rows. We only touch masters where events.rrule is not null.
import { getPool, query } from '../../platform/db'
import { log } from '../../platform/logger'
import { runJob, registerJob } from '../../platform/jobs'
import { expand, localDayKey, type MasterEvent, type OverrideRow } from './recurrence'

const PAST_MONTHS = 3
const FUTURE_MONTHS = 12

interface MasterRow {
  id: string
  household_id: string
  title: string | null
  location: string | null
  starts_at: Date
  ends_at: Date | null
  all_day: boolean
  timezone: string
  rrule: string | null
  rdate: Date[] | null
  exdate: Date[] | null
  recurrence_end_at: Date | null
  person_id: string | null
}

interface OverrideDbRow {
  id: string
  original_start: Date
  is_cancelled: boolean
  starts_at: Date | null
  ends_at: Date | null
  title: string | null
  location: string | null
}

const MASTER_COLS = `id, household_id, title, location, starts_at, ends_at, all_day, timezone,
                     rrule, rdate, exdate, recurrence_end_at, person_id`

function windowFor(now: Date): { start: Date; end: Date } {
  const start = new Date(now)
  start.setUTCMonth(start.getUTCMonth() - PAST_MONTHS)
  const end = new Date(now)
  end.setUTCMonth(end.getUTCMonth() + FUTURE_MONTHS)
  return { start, end }
}

// Expand one master + upsert its occurrences for the rolling window, soft-deleting
// any in-window rows the rule no longer produces (rule edit, new exdate, etc.).
async function materializeOne(m: MasterRow, now: Date): Promise<number> {
  if (!m.rrule) return 0
  const { start, end } = windowFor(now)
  const tz = m.timezone || 'UTC'

  const { rows: ovRows } = await query<OverrideDbRow>(
    `select id, original_start, is_cancelled, starts_at, ends_at, title, location
       from event_overrides where event_id = $1 and deleted_at is null`,
    [m.id],
  )
  const overrides: OverrideRow[] = ovRows.map((o) => ({
    id: o.id,
    originalStart: o.original_start,
    isCancelled: o.is_cancelled,
    startsAt: o.starts_at,
    endsAt: o.ends_at,
    title: o.title,
    location: o.location,
  }))

  const master: MasterEvent = {
    rrule: m.rrule,
    startsAt: m.starts_at,
    endsAt: m.ends_at,
    timezone: tz,
    allDay: m.all_day,
    rdate: m.rdate,
    exdate: m.exdate,
    recurrenceEndAt: m.recurrence_end_at,
    personId: m.person_id,
    title: m.title,
    location: m.location,
  }
  const occ = expand(master, overrides, start, end)

  const client = await getPool().connect()
  try {
    await client.query('begin')
    const keep: Date[] = []
    for (const o of occ) {
      await client.query(
        `insert into event_occurrences
           (household_id, event_id, override_id, original_start, person_id, title, location,
            starts_at, ends_at, all_day, starts_on)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (event_id, original_start) do update set
           override_id = excluded.override_id, person_id = excluded.person_id,
           title = excluded.title, location = excluded.location,
           starts_at = excluded.starts_at, ends_at = excluded.ends_at,
           all_day = excluded.all_day, starts_on = excluded.starts_on, deleted_at = null`,
        [
          m.household_id,
          m.id,
          o.overrideId,
          o.originalStart,
          o.personId,
          o.title,
          o.location,
          o.startsAt,
          o.endsAt,
          o.allDay,
          localDayKey(o.startsAt, tz),
        ],
      )
      keep.push(o.originalStart)
    }
    // Tombstone in-window slots we no longer produce.
    await client.query(
      `update event_occurrences set deleted_at = now()
        where event_id = $1 and deleted_at is null
          and original_start >= $2 and original_start <= $3
          and not (original_start = any($4::timestamptz[]))`,
      [m.id, start, end, keep],
    )
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
  return occ.length
}

/** Re-expand a single master by id. If it's no longer a recurring master (deleted,
 *  or rrule cleared), tombstone its occurrences. Returns occurrences written. */
export async function materializeMaster(eventId: string, now = new Date()): Promise<number> {
  const { rows } = await query<MasterRow>(
    `select ${MASTER_COLS} from events
      where id = $1 and deleted_at is null and rrule is not null`,
    [eventId],
  )
  const m = rows[0]
  if (!m) {
    await query(`update event_occurrences set deleted_at = now() where event_id = $1 and deleted_at is null`, [eventId])
    return 0
  }
  return materializeOne(m, now)
}

/** Re-expand every recurring master in a household. */
export async function materializeHousehold(householdId: string, now = new Date()): Promise<number> {
  const { rows } = await query<MasterRow>(
    `select ${MASTER_COLS} from events
      where household_id = $1 and deleted_at is null and rrule is not null`,
    [householdId],
  )
  let total = 0
  for (const m of rows) total += await materializeOne(m, now)
  return total
}

/** Re-expand every recurring master across all households (the scheduler's unit of work). */
export async function materializeAll(now = new Date()): Promise<{ masters: number }> {
  const { rows } = await query<MasterRow>(
    `select ${MASTER_COLS} from events where deleted_at is null and rrule is not null`,
  )
  for (const m of rows) {
    try {
      await materializeOne(m, now)
    } catch (err) {
      console.error('recurrence expansion failed for event', m.id, err)
    }
  }
  return { masters: rows.length }
}

let expansionTimer: ReturnType<typeof setInterval> | null = null

// Background rolling-window refresh (server.ts only). Independent of Google config —
// Nook-native recurrences exist with or without a connected account. On-demand
// materializeMaster() handles immediacy; this just rolls the horizon forward.
// EXPANSION_INTERVAL_MS default 6h; 0 disables.
export function startExpansionScheduler(): void {
  if (expansionTimer) return
  const intervalMs = parseInt(process.env.EXPANSION_INTERVAL_MS ?? '21600000', 10)
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return
  registerJob('recurrence-expansion')
  expansionTimer = setInterval(() => {
    runJob('recurrence-expansion', () => materializeAll()).catch((err) => log.error('recurrence expansion tick failed', { err }))
  }, intervalMs)
  expansionTimer.unref?.()
  log.info('recurrence expansion scheduler started', { intervalSec: Math.round(intervalMs / 1000) })
}

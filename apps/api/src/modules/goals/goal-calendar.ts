// Calendar → goal auto-counting (Phase 1, single events). The bridge between a
// calendar event tagged with goal_id and the goal's progress log. An event is a
// *plan, not a fact*: nothing is written automatically. Once a linked, non-
// cancelled occurrence has ended we surface a "did this happen?" recap with an
// editable preview (goal · amount · who); only on confirm do we write a goal_log
// (source 'auto_calendar', ref_type 'event') and record an event_goal_logs row.
// That row is keyed on (event_id, occurrence_date, goal_id) so a sync re-run or a
// double-confirm never double-counts. See ROADMAP "auto-from-calendar bridge".
import createAPI, { type Request, type Response } from 'lambda-api'
import { getPool, query } from '../../platform/db'
import { requireTenant, type Tenant } from '../households/households'
import { logProgress } from './goals.service'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const HOUR_UNITS = new Set(['hour', 'hours', 'hr', 'hrs', 'h'])
const MIN_UNITS = new Set(['min', 'mins', 'minute', 'minutes'])

// A cancelled occurrence shouldn't ask "did this happen?" — it didn't. Google's
// event status (confirmed | tentative | cancelled) lives in events.status; a
// cancelled Google event is also soft-deleted (deleted_at), so the deleted_at
// guard below already covers the sync path — this is the belt-and-suspenders for
// a locally-cancelled-but-not-deleted row.
const SKIP_STATUSES = `('cancelled')`

interface RecapRow {
  event_id: string
  title: string
  starts_at: Date
  ends_at: Date | null
  all_day: boolean
  occurrence_date: string
  goal_id: string
  goal_title: string
  goal_emoji: string | null
  goal_type: string
  unit: string | null
  tracking_mode: string
  event_person_ids: string[]
  goal_person_ids: string[]
}

// Map an event's duration onto the goal's natural axis. Habit/Count = one
// completion (+1). Total in a time unit = the event's duration in that unit;
// a non-time Total (miles/pages — Phase 2) can't be inferred, so suggest 0 and
// let the person fill it in.
function suggestedAmount(row: RecapRow): number {
  if (row.goal_type === 'habit' || row.goal_type === 'count') return 1
  if (row.goal_type === 'total') {
    if (row.all_day || !row.ends_at) return 0
    const mins = Math.max(0, (row.ends_at.getTime() - row.starts_at.getTime()) / 60000)
    const unit = (row.unit ?? '').toLowerCase()
    if (HOUR_UNITS.has(unit)) return Math.round((mins / 60) * 100) / 100
    if (MIN_UNITS.has(unit)) return Math.round(mins)
    return 0
  }
  return 0
}

// Default attribution = event participants ∩ goal participants; if that's empty
// (e.g. the event has no one tagged), fall back to all the goal's participants.
function defaultPersonIds(row: RecapRow): string[] {
  const ev = new Set(row.event_person_ids ?? [])
  const both = (row.goal_person_ids ?? []).filter((id) => ev.has(id))
  return both.length ? both : (row.goal_person_ids ?? [])
}

// Pending recap items: linked single events whose occurrence has ended and that
// haven't been confirmed or skipped yet. Optionally scoped to one goal.
export async function recapQueue(householdId: string, goalId?: string | null) {
  const { rows } = await query<RecapRow>(
    `select e.id as event_id, e.title, e.starts_at, e.ends_at, e.all_day,
            (e.starts_at at time zone h.timezone)::date::text as occurrence_date,
            g.id as goal_id, g.title as goal_title, g.emoji as goal_emoji,
            g.goal_type, g.unit, g.tracking_mode,
            coalesce((select array_agg(ep.person_id::text)
                        from event_participants ep
                       where ep.event_id = e.id and ep.deleted_at is null), '{}') as event_person_ids,
            coalesce((select array_agg(gp.person_id::text)
                        from goal_participants gp
                       where gp.goal_id = g.id and gp.deleted_at is null), '{}') as goal_person_ids
       from events e
       join households h on h.id = e.household_id
       join goals g on g.id = e.goal_id and g.deleted_at is null and g.auto_from_calendar
       left join event_goal_logs egl
         on egl.event_id = e.id and egl.goal_id = e.goal_id
        and egl.occurrence_date = (e.starts_at at time zone h.timezone)::date
      where e.household_id = $1
        and e.deleted_at is null
        and e.goal_id is not null
        and e.rrule is null
        and coalesce(e.ends_at, e.starts_at) <= now()
        and (e.status is null or e.status not in ${SKIP_STATUSES})
        and egl.id is null
        and ($2::uuid is null or g.id = $2)
      order by coalesce(e.ends_at, e.starts_at) desc
      limit 50`,
    [householdId, goalId ?? null]
  )
  return rows.map((r) => ({
    eventId: r.event_id,
    occurrenceDate: r.occurrence_date,
    title: r.title,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    allDay: r.all_day,
    goalId: r.goal_id,
    goalTitle: r.goal_title,
    goalEmoji: r.goal_emoji,
    goalType: r.goal_type,
    unit: r.unit,
    trackingMode: r.tracking_mode,
    suggestedAmount: suggestedAmount(r),
    defaultPersonIds: defaultPersonIds(r),
    goalParticipantIds: r.goal_person_ids ?? [],
  }))
}

// Confirm a recap occurrence → write progress + the idempotency record. Returns
// 'logged' on a fresh write, 'duplicate' if it was already resolved (the unique
// key makes a re-confirm a no-op — never a double count), or null if the event/
// link no longer validates.
export async function confirmRecap(
  tenant: Tenant,
  eventId: string,
  occurrenceDate: string,
  amount: number,
  personIds: string[],
  note?: string | null
): Promise<'logged' | 'duplicate' | null> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    // The event must still exist, belong to the household, and be linked to a goal
    // that accepts calendar contributions.
    const { rows } = await client.query<{ goal_id: string }>(
      `select e.goal_id from events e
         join goals g on g.id = e.goal_id and g.deleted_at is null and g.auto_from_calendar
        where e.id = $1 and e.household_id = $2 and e.deleted_at is null and e.goal_id is not null`,
      [eventId, tenant.householdId]
    )
    const goalId = rows[0]?.goal_id
    if (!goalId) {
      await client.query('rollback')
      return null
    }
    // Claim the (event, occurrence, goal) slot first. ON CONFLICT DO NOTHING +
    // RETURNING means a second confirm gets no row back → we bail without logging.
    const claim = await client.query<{ id: string }>(
      `insert into event_goal_logs
         (household_id, event_id, occurrence_date, goal_id, status, created_by)
       values ($1,$2,$3,$4,'logged',$5)
       on conflict (event_id, occurrence_date, goal_id) do nothing
       returning id`,
      [tenant.householdId, eventId, occurrenceDate, goalId, tenant.personId]
    )
    if (claim.rowCount === 0) {
      await client.query('rollback')
      return 'duplicate'
    }
    await client.query('commit')
    // Write progress OUTSIDE the claim transaction (logProgress opens its own
    // connection). The claim row already guarantees idempotency.
    const logIds = await logProgress(tenant, goalId, amount, personIds, note ?? null, {
      source: 'auto_calendar',
      refType: 'event',
      refId: eventId,
    })
    if (logIds[0]) {
      await query(`update event_goal_logs set goal_log_id = $1 where id = $2`, [logIds[0], claim.rows[0].id])
    }
    return 'logged'
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// Skip a recap occurrence — record it as resolved so the recap stops asking,
// without writing any progress. Idempotent on the same unique key.
export async function skipRecap(tenant: Tenant, eventId: string, occurrenceDate: string): Promise<boolean> {
  const { rows } = await query<{ goal_id: string }>(
    `select goal_id from events where id = $1 and household_id = $2 and deleted_at is null and goal_id is not null`,
    [eventId, tenant.householdId]
  )
  const goalId = rows[0]?.goal_id
  if (!goalId) return false
  await query(
    `insert into event_goal_logs (household_id, event_id, occurrence_date, goal_id, status, created_by)
     values ($1,$2,$3,$4,'skipped',$5)
     on conflict (event_id, occurrence_date, goal_id) do nothing`,
    [tenant.householdId, eventId, occurrenceDate, goalId, tenant.personId]
  )
  return true
}

export function registerGoalCalendarRoutes(api: Api): void {
  // The "did these happen?" queue (Today + goal detail). Optional ?goalId scopes
  // it to one goal.
  api.get('/api/goal-calendar/recap', async (req: Request) => {
    const tenant = await requireTenant(req)
    const goalId = typeof req.query?.goalId === 'string' && UUID_RE.test(req.query.goalId) ? req.query.goalId : null
    return { items: await recapQueue(tenant.householdId, goalId) }
  })

  api.post('/api/goal-calendar/recap/confirm', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as {
      eventId?: string
      occurrenceDate?: string
      amount?: unknown
      personIds?: string[]
      note?: string | null
    }
    if (!body.eventId || !UUID_RE.test(body.eventId)) {
      return res.status(400).json({ error: 'BadRequest', message: 'eventId is required' })
    }
    if (!body.occurrenceDate || !DATE_RE.test(body.occurrenceDate)) {
      return res.status(400).json({ error: 'BadRequest', message: 'occurrenceDate (YYYY-MM-DD) is required' })
    }
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'amount must be a non-zero number' })
    }
    const personIds = Array.isArray(body.personIds) ? body.personIds.filter((p) => typeof p === 'string') : []
    const result = await confirmRecap(tenant, body.eventId, body.occurrenceDate, amount, personIds, body.note ?? null)
    if (result === null) return res.status(404).json({ error: 'NotFound', message: 'event or goal link not found' })
    return res.status(201).json({ status: result })
  })

  api.post('/api/goal-calendar/recap/skip', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as { eventId?: string; occurrenceDate?: string }
    if (!body.eventId || !UUID_RE.test(body.eventId)) {
      return res.status(400).json({ error: 'BadRequest', message: 'eventId is required' })
    }
    if (!body.occurrenceDate || !DATE_RE.test(body.occurrenceDate)) {
      return res.status(400).json({ error: 'BadRequest', message: 'occurrenceDate (YYYY-MM-DD) is required' })
    }
    const ok = await skipRecap(tenant, body.eventId, body.occurrenceDate)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'event or goal link not found' })
    return res.status(200).json({ ok: true })
  })
}

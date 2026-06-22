// Calendar — Nook-native events. Single events created here and read for the
// agenda / Calendar screen. "Today" buckets by the household's timezone so a kiosk
// shows the right local day. events.person_id is the color/owner; event_participants
// is the broader "who's involved" set. Events authored for a person who has a Google
// write-target calendar are routed there and pushed back (5.4, via calendar-sync).
import createAPI, { type Request, type Response } from 'lambda-api'
import type { PoolClient, QueryResultRow } from 'pg'
import { getPool, query } from '../../platform/db'
import { requireTenant, type Tenant } from '../households/households'
import { resolveWriteTarget, resolveWriteTargetById, pushEventNow } from '../calendar/calendar-sync.service'
import { materializeMaster } from '../calendar/expansion.service'
import { isValidRrule } from '../calendar/recurrence'
import { recordMatch, WEIGHT } from '../goals/goal-match-memory'

type Api = ReturnType<typeof createAPI>

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// camelCase API field → events column. Anything not here can't be patched.
// (person_id is set from participantIds; personId is also accepted directly.)
const UPDATABLE: Record<string, string> = {
  title: 'title',
  description: 'description',
  location: 'location',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
  allDay: 'all_day',
  personId: 'person_id',
  goalId: 'goal_id',
  goalStepId: 'goal_step_id',
  rrule: 'rrule',
  recurrenceEndAt: 'recurrence_end_at',
}

// Patch fields Google owns — a change to one of these is worth pushing back to
// Google. personId/participantIds are Nook-owned and never trigger an outbound push.
const GOOGLE_OWNED_FIELDS = ['title', 'description', 'location', 'startsAt', 'endsAt', 'allDay']

export interface Participant {
  id: string
  name: string
  colorHex: string | null
  avatarEmoji: string | null
}

export interface EventRow extends QueryResultRow {
  id: string
  title: string
  description: string | null
  location: string | null
  starts_at: Date
  ends_at: Date | null
  all_day: boolean
  person_id: string | null
  goal_id?: string | null
  goal_step_id?: string | null
  rrule?: string | null
  sync_state?: string | null
  calendar_name?: string | null
  origin?: string | null
  origin_ref_id?: string | null
  person_name?: string | null
  person_color?: string | null
  person_emoji?: string | null
  participants?: Participant[]
  // Recurrence: for a single/Google event series_id === id and occurrence_start is
  // null; for a Nook-native expanded occurrence series_id is the master, id is the
  // occurrence row, occurrence_start is the rule slot (the edit-scope handle).
  series_id?: string
  occurrence_start?: Date | null
}

export interface CreateEventInput {
  title: string
  startsAt: string
  endsAt?: string | null
  allDay?: boolean
  location?: string | null
  description?: string | null
  personId?: string | null
  participantIds?: string[]
  // Calendar → goal bridge: tag this event so its completion counts toward a goal
  // (the goal must have auto_from_calendar on). null/omitted = not linked.
  goalId?: string | null
  // For a checklist goal, which step this event is meant to complete; confirming
  // the recap ticks it. Only meaningful alongside a checklist goalId.
  goalStepId?: string | null
  timezone?: string | null
  // Explicit calendar choice (create-time picker): a calendar id to write to, or
  // null for "Nook only". Omit entirely to auto-route to the owner's ★ default.
  calendarId?: string | null
  // Recurrence (Nook-native). rrule is an RFC5545 RRULE; rdate/exdate are extra/
  // excluded occurrence instants (ISO); recurrenceEndAt is a hard stop. Omit for a
  // single event. Creating with an rrule materializes occurrences immediately.
  rrule?: string | null
  rdate?: string[] | null
  exdate?: string[] | null
  recurrenceEndAt?: string | null
}

// Replace an event's participants with the given (deduped) people.
async function replaceParticipants(
  client: PoolClient,
  householdId: string,
  eventId: string,
  personIds: string[]
): Promise<void> {
  await client.query(`delete from event_participants where event_id = $1`, [eventId])
  for (const pid of [...new Set(personIds)]) {
    await client.query(
      `insert into event_participants (household_id, event_id, person_id) values ($1,$2,$3)`,
      [householdId, eventId, pid]
    )
  }
}

export async function createEvent(tenant: Tenant, input: CreateEventInput): Promise<EventRow> {
  const personIds = input.participantIds ?? (input.personId ? [input.personId] : [])
  const primary = personIds[0] ?? input.personId ?? null
  // Pick the destination calendar: an explicit picker choice (calendarId present)
  // wins — a calendar id routes there, null means "Nook only"; when omitted, fall
  // back to auto-routing to the owner's ★ default. No target ⇒ local-only event.
  const target =
    input.calendarId !== undefined
      ? input.calendarId
        ? await resolveWriteTargetById(tenant.householdId, input.calendarId)
        : null
      : await resolveWriteTarget(tenant.householdId, primary)
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const ins = await client.query<EventRow>(
      `insert into events
         (household_id, calendar_id, title, description, location, starts_at, ends_at, all_day, timezone,
          person_id, goal_id, goal_step_id, rrule, rdate, exdate, recurrence_end_at, origin, sync_state)
       values ($1,$2,$3,$4,$5,$6,$7, coalesce($8,false),
               coalesce($9, (select timezone from households where id=$1)), $10, $11, $12,
               $13, $14::timestamptz[], $15::timestamptz[], $16, 'manual', $17)
       returning *`,
      [
        tenant.householdId,
        target?.calendarId ?? null,
        input.title,
        input.description ?? null,
        input.location ?? null,
        input.startsAt,
        input.endsAt ?? null,
        input.allDay ?? false,
        input.timezone ?? null,
        primary,
        input.goalId ?? null,
        input.goalStepId ?? null,
        input.rrule ?? null,
        input.rdate ?? null,
        input.exdate ?? null,
        input.recurrenceEndAt ?? null,
        target ? 'pending_push' : 'local_only',
      ]
    )
    const event = ins.rows[0]
    await replaceParticipants(client, tenant.householdId, event.id, personIds)
    await client.query('commit')
    // A new recurring master expands into occurrences right away (don't wait for
    // the rolling-window tick), so it appears on the calendar immediately.
    if (event.rrule) await materializeMaster(event.id)
    // A goal picked at create time is a strong human signal — teach the matcher.
    if (event.goal_id) await recordMatch(tenant.householdId, event.title, event.goal_id, WEIGHT.human)
    // Push outside the transaction; failures are recorded as push_failed (retried
    // on the next sync) and never fail the create.
    if (target) await pushEventNow(tenant.householdId, event.id)
    return event
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Reads UNION two row kinds (see EventRow): plain single/Google events
// (events.rrule is null) and materialized Nook-native occurrences (joined to their
// master m). Both expose the same columns + series_id/occurrence_start, so callers
// and the presenter don't special-case recurrence.
function participantsSub(idExpr: string): string {
  return `coalesce((
    select json_agg(json_build_object(
             'id', pp.id, 'name', pp.name, 'colorHex', pp.color_hex, 'avatarEmoji', pp.avatar_emoji)
           order by pp.sort_order, pp.created_at)
      from event_participants ep
      join persons pp on pp.id = ep.person_id and pp.deleted_at is null
     where ep.event_id = ${idExpr} and ep.deleted_at is null
  ), '[]'::json) as participants`
}

const SINGLE_SELECT = `
  select e.id as id, e.id as series_id, null::timestamptz as occurrence_start,
         e.title, e.description, e.location, e.starts_at, e.ends_at, e.all_day, e.person_id, e.goal_id, e.goal_step_id,
         e.rrule, e.sync_state, e.origin, e.origin_ref_id, c.summary as calendar_name,
         p.name as person_name, p.color_hex as person_color, p.avatar_emoji as person_emoji,
         ${participantsSub('e.id')}
    from events e
    join households h on h.id = e.household_id
    left join persons p on p.id = e.person_id and p.deleted_at is null
    left join calendars c on c.id = e.calendar_id and c.deleted_at is null
   where e.household_id = $1 and e.deleted_at is null and e.rrule is null`

const OCC_SELECT = `
  select o.id as id, m.id as series_id, o.original_start as occurrence_start,
         coalesce(o.title, m.title) as title, m.description, coalesce(o.location, m.location) as location,
         o.starts_at, o.ends_at, o.all_day, o.person_id, m.goal_id, m.goal_step_id,
         m.rrule, m.sync_state, m.origin, m.origin_ref_id, c.summary as calendar_name,
         p.name as person_name, p.color_hex as person_color, p.avatar_emoji as person_emoji,
         ${participantsSub('m.id')}
    from event_occurrences o
    join events m on m.id = o.event_id and m.deleted_at is null
    join households h on h.id = o.household_id
    left join persons p on p.id = o.person_id and p.deleted_at is null
    left join calendars c on c.id = m.calendar_id and c.deleted_at is null
   where o.household_id = $1 and o.deleted_at is null`

export async function todayEvents(householdId: string, date: string): Promise<EventRow[]> {
  const { rows } = await query<EventRow>(
    `${SINGLE_SELECT} and (e.starts_at at time zone h.timezone)::date = $2::date
     union all
     ${OCC_SELECT} and (o.starts_at at time zone h.timezone)::date = $2::date
     order by all_day, starts_at`,
    [householdId, date]
  )
  return rows
}

export async function rangeEvents(householdId: string, from: string, to: string): Promise<EventRow[]> {
  const { rows } = await query<EventRow>(
    `${SINGLE_SELECT} and (e.starts_at at time zone h.timezone)::date between $2::date and $3::date
     union all
     ${OCC_SELECT} and (o.starts_at at time zone h.timezone)::date between $2::date and $3::date
     order by starts_at`,
    [householdId, from, to]
  )
  return rows
}

// Looks up a master/single event by id (not an occurrence). The detail screen for a
// recurring occurrence fetches its series via series_id.
export async function getEventById(householdId: string, id: string): Promise<EventRow | null> {
  const { rows } = await query<EventRow>(
    `${SINGLE_SELECT.replace('and e.rrule is null', '')} and e.id = $2`,
    [householdId, id]
  )
  return rows[0] ?? null
}

export async function updateEvent(
  householdId: string,
  id: string,
  patch: Record<string, unknown>
): Promise<EventRow | null> {
  const personIds = Array.isArray(patch.participantIds)
    ? [...new Set(patch.participantIds as string[])]
    : null

  const client = await getPool().connect()
  try {
    await client.query('begin')
    const sets: string[] = []
    const values: unknown[] = []
    let i = 1
    for (const [field, column] of Object.entries(UPDATABLE)) {
      if (field === 'personId') continue // derived from participantIds (or handled below)
      if (field in patch && patch[field] !== undefined) {
        sets.push(`${column} = $${i++}`)
        values.push(patch[field])
      }
    }
    if (personIds) {
      sets.push(`person_id = $${i++}`)
      values.push(personIds[0] ?? null)
    } else if ('personId' in patch) {
      sets.push(`person_id = $${i++}`)
      values.push(patch.personId ?? null)
    }

    let event: EventRow | undefined
    if (sets.length > 0) {
      values.push(householdId, id)
      const upd = await client.query<EventRow>(
        `update events set ${sets.join(', ')}
           where household_id = $${i++} and id = $${i} and deleted_at is null
           returning *`,
        values
      )
      event = upd.rows[0]
    } else {
      const cur = await client.query<EventRow>(
        `select * from events where household_id = $1 and id = $2 and deleted_at is null`,
        [householdId, id]
      )
      event = cur.rows[0]
    }

    if (!event) {
      await client.query('rollback')
      return null
    }
    if (personIds) await replaceParticipants(client, householdId, id, personIds)
    await client.query('commit')
    // Picking a goal on an event (here or via the suggestion link) is a strong
    // human signal — teach the household matcher.
    if ('goalId' in patch && event.goal_id) await recordMatch(householdId, event.title, event.goal_id, WEIGHT.human)
    // Mirror the edit to Google only when a Google-owned field changed — person/
    // participants are Nook-owned (Google has no such field), so don't push for them.
    const touchedGoogle = GOOGLE_OWNED_FIELDS.some((f) => f in patch)
    if (event.calendar_id && touchedGoogle) await pushEventNow(householdId, id)
    // Re-expand if this is (or just became / stopped being) a recurring master, so
    // its occurrences reflect the edited rule/timing/fields.
    if (event.rrule || 'rrule' in patch) await materializeMaster(id)
    return event
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

export async function softDeleteEvent(householdId: string, id: string): Promise<boolean> {
  const { rows } = await query<{ calendar_id: string | null }>(
    `update events
        set deleted_at = now(),
            sync_state = case when calendar_id is not null then 'pending_push' else sync_state end
      where household_id = $1 and id = $2 and deleted_at is null
      returning calendar_id`,
    [householdId, id]
  )
  const row = rows[0]
  if (!row) return false
  // Mirror the deletion to Google (delete tolerates an already-gone event).
  if (row.calendar_id) await pushEventNow(householdId, id)
  return true
}

export function presentEvent(e: EventRow) {
  return {
    id: e.id,
    title: e.title,
    description: e.description ?? null,
    location: e.location,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    allDay: e.all_day,
    personId: e.person_id,
    goalId: e.goal_id ?? null,
    goalStepId: e.goal_step_id ?? null,
    rrule: e.rrule ?? null,
    // The Google calendar this event lives on (its name) + whether it's pushed —
    // drives the detail screen's "Calendar · synced from Google" row.
    calendarName: e.calendar_name ?? null,
    syncState: e.sync_state ?? null,
    origin: e.origin ?? null,
    originRefId: e.origin_ref_id ?? null,
    personName: e.person_name ?? null,
    personColor: e.person_color ?? null,
    personEmoji: e.person_emoji ?? null,
    participants: e.participants ?? [],
    // The series this row belongs to + (for a recurring occurrence) which slot —
    // the handle clients pass back for "edit this occurrence".
    seriesId: e.series_id ?? e.id,
    occurrenceStart: e.occurrence_start ?? null,
  }
}

function localToday(): string {
  return new Date().toISOString().slice(0, 10)
}

export function registerEventRoutes(api: Api): void {
  api.post('/api/events', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as Partial<CreateEventInput>
    if (!body.title || !body.title.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'title is required' })
    }
    if (!body.startsAt || Number.isNaN(Date.parse(body.startsAt))) {
      return res.status(400).json({ error: 'BadRequest', message: 'startsAt must be a valid timestamp' })
    }
    if (body.rrule && !isValidRrule(body.rrule)) {
      return res.status(400).json({ error: 'BadRequest', message: 'rrule is not a valid RFC5545 recurrence rule' })
    }
    const event = await createEvent(tenant, { ...body, title: body.title.trim() } as CreateEventInput)
    return res.status(201).json({ event: presentEvent(event) })
  })

  // Today's agenda (bucketed by household timezone).
  api.get('/api/events/today', async (req: Request) => {
    const tenant = await requireTenant(req)
    const dateParam = typeof req.query?.date === 'string' ? req.query.date : ''
    const date = DATE_RE.test(dateParam) ? dateParam : localToday()
    const events = await todayEvents(tenant.householdId, date)
    return { date, events: events.map(presentEvent) }
  })

  // Events in a date range (Calendar screen).
  api.get('/api/events', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const from = typeof req.query?.from === 'string' ? req.query.from : ''
    const to = typeof req.query?.to === 'string' ? req.query.to : ''
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      return res.status(400).json({ error: 'BadRequest', message: 'from and to (YYYY-MM-DD) are required' })
    }
    const events = await rangeEvents(tenant.householdId, from, to)
    return { from, to, events: events.map(presentEvent) }
  })

  // A single event with its full detail (rrule, calendar) — the detail screen.
  api.get('/api/events/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'event not found' })
    const event = await getEventById(tenant.householdId, id)
    if (!event) return res.status(404).json({ error: 'NotFound', message: 'event not found' })
    return { event: presentEvent(event) }
  })

  api.patch('/api/events/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'event not found' })
    const patch = (req.body ?? {}) as Record<string, unknown>
    if (typeof patch.startsAt === 'string' && Number.isNaN(Date.parse(patch.startsAt))) {
      return res.status(400).json({ error: 'BadRequest', message: 'startsAt must be a valid timestamp' })
    }
    if (typeof patch.rrule === 'string' && patch.rrule && !isValidRrule(patch.rrule)) {
      return res.status(400).json({ error: 'BadRequest', message: 'rrule is not a valid RFC5545 recurrence rule' })
    }
    const hasField = Object.keys(UPDATABLE).some((field) => field in patch) || 'participantIds' in patch
    if (!hasField) {
      return res.status(400).json({ error: 'BadRequest', message: 'no updatable fields provided' })
    }
    const event = await updateEvent(tenant.householdId, id, patch)
    if (!event) return res.status(404).json({ error: 'NotFound', message: 'event not found' })
    return { event: presentEvent(event) }
  })

  api.delete('/api/events/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'event not found' })
    const ok = await softDeleteEvent(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'event not found' })
    return res.status(204).send('')
  })
}

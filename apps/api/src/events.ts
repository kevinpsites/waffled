// Calendar — Nook-native events. Single events created here and read for the
// agenda / Calendar screen. "Today" buckets by the household's timezone so a kiosk
// shows the right local day. events.person_id is the color/owner; event_participants
// is the broader "who's involved" set. Events authored for a person who has a Google
// write-target calendar are routed there and pushed back (5.4, via calendar-sync).
import createAPI, { type Request, type Response } from 'lambda-api'
import type { PoolClient, QueryResultRow } from 'pg'
import { getPool, query } from './db'
import { requireTenant, type Tenant } from './households'
import { resolveWriteTarget, pushEventNow } from './calendar-sync'

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
  person_name?: string | null
  person_color?: string | null
  person_emoji?: string | null
  participants?: Participant[]
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
  timezone?: string | null
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
  // If the owner has a Google write-target calendar, tag the event to it and
  // queue a push; otherwise it's a local-only event.
  const target = await resolveWriteTarget(tenant.householdId, primary)
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const ins = await client.query<EventRow>(
      `insert into events
         (household_id, calendar_id, title, description, location, starts_at, ends_at, all_day, timezone,
          person_id, origin, sync_state)
       values ($1,$2,$3,$4,$5,$6,$7, coalesce($8,false),
               coalesce($9, (select timezone from households where id=$1)), $10, 'manual', $11)
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
        target ? 'pending_push' : 'local_only',
      ]
    )
    const event = ins.rows[0]
    await replaceParticipants(client, tenant.householdId, event.id, personIds)
    await client.query('commit')
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

const PARTICIPANTS_SUBQUERY = `
  coalesce((
    select json_agg(json_build_object(
             'id', pp.id, 'name', pp.name, 'colorHex', pp.color_hex, 'avatarEmoji', pp.avatar_emoji)
           order by pp.sort_order, pp.created_at)
      from event_participants ep
      join persons pp on pp.id = ep.person_id and pp.deleted_at is null
     where ep.event_id = e.id and ep.deleted_at is null
  ), '[]'::json) as participants`

const SELECT_WITH_PERSON = `
  select e.id, e.title, e.description, e.location, e.starts_at, e.ends_at, e.all_day, e.person_id,
         p.name as person_name, p.color_hex as person_color, p.avatar_emoji as person_emoji,
         ${PARTICIPANTS_SUBQUERY}
    from events e
    join households h on h.id = e.household_id
    left join persons p on p.id = e.person_id and p.deleted_at is null
   where e.household_id = $1 and e.deleted_at is null`

export async function todayEvents(householdId: string, date: string): Promise<EventRow[]> {
  const { rows } = await query<EventRow>(
    `${SELECT_WITH_PERSON}
       and (e.starts_at at time zone h.timezone)::date = $2::date
     order by e.all_day, e.starts_at`,
    [householdId, date]
  )
  return rows
}

export async function rangeEvents(householdId: string, from: string, to: string): Promise<EventRow[]> {
  const { rows } = await query<EventRow>(
    `${SELECT_WITH_PERSON}
       and (e.starts_at at time zone h.timezone)::date between $2::date and $3::date
     order by e.starts_at`,
    [householdId, from, to]
  )
  return rows
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
    // Mirror the edit to Google only when a Google-owned field changed — person/
    // participants are Nook-owned (Google has no such field), so don't push for them.
    const touchedGoogle = GOOGLE_OWNED_FIELDS.some((f) => f in patch)
    if (event.calendar_id && touchedGoogle) await pushEventNow(householdId, id)
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
    personName: e.person_name ?? null,
    personColor: e.person_color ?? null,
    personEmoji: e.person_emoji ?? null,
    participants: e.participants ?? [],
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

  api.patch('/api/events/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'event not found' })
    const patch = (req.body ?? {}) as Record<string, unknown>
    if (typeof patch.startsAt === 'string' && Number.isNaN(Date.parse(patch.startsAt))) {
      return res.status(400).json({ error: 'BadRequest', message: 'startsAt must be a valid timestamp' })
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

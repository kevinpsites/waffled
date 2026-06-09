// Calendar — Nook-native events (part 1, no Google). Single events created here
// and read for the agenda / Calendar screen. "Today" buckets by the household's
// timezone so a kiosk shows the right local day.
import createAPI, { type Request, type Response } from 'lambda-api'
import type { QueryResultRow } from 'pg'
import { query } from './db'
import { requireTenant, type Tenant } from './households'

type Api = ReturnType<typeof createAPI>

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// camelCase API field → events column. Anything not here can't be patched.
const UPDATABLE: Record<string, string> = {
  title: 'title',
  description: 'description',
  location: 'location',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
  allDay: 'all_day',
  personId: 'person_id',
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
}

export interface CreateEventInput {
  title: string
  startsAt: string
  endsAt?: string | null
  allDay?: boolean
  location?: string | null
  description?: string | null
  personId?: string | null
  timezone?: string | null
}

export async function createEvent(tenant: Tenant, input: CreateEventInput): Promise<EventRow> {
  const { rows } = await query<EventRow>(
    `insert into events
       (household_id, title, description, location, starts_at, ends_at, all_day, timezone, person_id, origin)
     values ($1,$2,$3,$4,$5,$6, coalesce($7,false),
             coalesce($8, (select timezone from households where id=$1)), $9, 'manual')
     returning *`,
    [
      tenant.householdId,
      input.title,
      input.description ?? null,
      input.location ?? null,
      input.startsAt,
      input.endsAt ?? null,
      input.allDay ?? false,
      input.timezone ?? null,
      input.personId ?? null,
    ]
  )
  return rows[0]
}

const SELECT_WITH_PERSON = `
  select e.id, e.title, e.description, e.location, e.starts_at, e.ends_at, e.all_day, e.person_id,
         p.name as person_name, p.color_hex as person_color, p.avatar_emoji as person_emoji
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
  const sets: string[] = []
  const values: unknown[] = []
  let i = 1
  for (const [field, column] of Object.entries(UPDATABLE)) {
    if (field in patch && patch[field] !== undefined) {
      sets.push(`${column} = $${i++}`)
      values.push(patch[field])
    }
  }
  values.push(householdId, id)
  const { rows } = await query<EventRow>(
    `update events set ${sets.join(', ')}
       where household_id = $${i++} and id = $${i} and deleted_at is null
       returning *`,
    values
  )
  return rows[0] ?? null
}

export async function softDeleteEvent(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `update events set deleted_at = now() where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
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
    if (!Object.keys(UPDATABLE).some((field) => field in patch)) {
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

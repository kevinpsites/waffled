// Countdowns — "N days until X" to build anticipation. A core Calendar feature (not a
// gated module). Three sources merged into one sorted list: standalone countdown items
// (this table), calendar events flagged is_countdown, and each member's next birthday
// (derived from persons.birthday). Read-only surfaces: a Today card + a calendar badge.
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { tenantRoute } from '../../platform/route-guards'
import type { Tenant } from '../households/households'

type Api = ReturnType<typeof createAPI>
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export type CountdownSource = 'standalone' | 'event' | 'birthday'
export interface Countdown {
  id: string
  title: string
  date: string // YYYY-MM-DD
  daysLeft: number
  source: CountdownSource
  emoji: string | null
  color: string | null
  personId: string | null
}

// Whole days from `today` (YYYY-MM-DD) to `date` (YYYY-MM-DD); 0 = today, negative = past.
function daysBetween(today: string, date: string): number {
  const a = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10))
  const b = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10))
  return Math.round((b - a) / 86_400_000)
}

// The next occurrence (this year or next) of a birthday's month/day, as YYYY-MM-DD.
function nextBirthday(birthday: string, today: string): string {
  const mmdd = birthday.slice(5) // MM-DD
  const thisYear = `${today.slice(0, 4)}-${mmdd}`
  return daysBetween(today, thisYear) >= 0 ? thisYear : `${+today.slice(0, 4) + 1}-${mmdd}`
}

// Household "today" in its own timezone (countdowns are date-only, so tz matters).
async function householdToday(householdId: string): Promise<string> {
  const { rows } = await query<{ today: string }>(
    `select (now() at time zone timezone)::date::text as today from households where id = $1`,
    [householdId]
  )
  return rows[0]?.today ?? new Date().toISOString().slice(0, 10)
}

async function readSleeps(householdId: string): Promise<boolean> {
  const { rows } = await query<{ sleeps: string | null }>(
    `select settings->'countdowns'->>'sleeps' as sleeps from households where id = $1`,
    [householdId]
  )
  return rows[0]?.sleeps === 'true'
}

// How far ahead a birthday is allowed to surface on the list (days). Past this it's just
// noise (a whole family's birthdays a year out), and — since nextBirthday() rolls a
// passed birthday to next year — this also hides a just-passed birthday until it's close.
// Default ~6 months.
export const DEFAULT_BIRTHDAY_HORIZON_DAYS = 183

async function readBirthdayHorizonDays(householdId: string): Promise<number> {
  const { rows } = await query<{ horizon: string | null }>(
    `select settings->'countdowns'->>'birthdayHorizonDays' as horizon from households where id = $1`,
    [householdId]
  )
  const n = Number(rows[0]?.horizon)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_BIRTHDAY_HORIZON_DAYS
}

// Everything to count down to, soonest first.
async function listCountdowns(householdId: string, viewerPersonId: string | null): Promise<Countdown[]> {
  const today = await householdToday(householdId)
  const horizonDays = await readBirthdayHorizonDays(householdId)
  const out: Countdown[] = []

  const standalone = await query<{ id: string; title: string; date: string; emoji: string | null; color: string | null }>(
    `select id, title, date::text as date, emoji, color from countdowns
       where household_id = $1 and deleted_at is null and date >= $2::date`,
    [householdId, today]
  )
  for (const r of standalone.rows) {
    out.push({ id: r.id, title: r.title, date: r.date, daysLeft: daysBetween(today, r.date), source: 'standalone', emoji: r.emoji, color: r.color, personId: null })
  }

  // Flagged calendar events (their date in the household tz). Recurring masters use the
  // series' start; countdowns are almost always one-off, so that's fine for now.
  const events = await query<{ id: string; title: string; date: string }>(
    `select e.id, e.title, (e.starts_at at time zone h.timezone)::date::text as date
       from events e join households h on h.id = e.household_id
      where e.household_id = $1 and e.deleted_at is null and e.is_countdown = true
        and (e.visibility = 'family' or e.owner_person_id = $3)
        and (e.starts_at at time zone h.timezone)::date >= $2::date`,
    [householdId, today, viewerPersonId]
  )
  for (const r of events.rows) {
    out.push({ id: r.id, title: r.title, date: r.date, daysLeft: daysBetween(today, r.date), source: 'event', emoji: null, color: null, personId: null })
  }

  // Each member's next birthday.
  const people = await query<{ id: string; name: string; birthday: string }>(
    `select id, name, birthday::text as birthday from persons
       where household_id = $1 and deleted_at is null and birthday is not null`,
    [householdId]
  )
  for (const p of people.rows) {
    const date = nextBirthday(p.birthday, today)
    // Only surface birthdays inside the horizon — keeps far-off (and just-passed,
    // now-far-off) birthdays off the list.
    if (daysBetween(today, date) > horizonDays) continue
    out.push({ id: `birthday:${p.id}`, title: `${p.name}'s birthday`, date, daysLeft: daysBetween(today, date), source: 'birthday', emoji: '🎂', color: null, personId: p.id })
  }

  out.sort((a, b) => a.daysLeft - b.daysLeft || a.title.localeCompare(b.title))
  return out
}

export function registerCountdownRoutes(api: Api): void {
  // Merged list (standalone + flagged events + birthdays) + display prefs.
  api.get('/api/countdowns', tenantRoute(async (tenant: Tenant) => {
    const [countdowns, sleeps, birthdayHorizonDays] = await Promise.all([
      listCountdowns(tenant.householdId, tenant.personId ?? null),
      readSleeps(tenant.householdId),
      readBirthdayHorizonDays(tenant.householdId),
    ])
    return { countdowns, sleeps, birthdayHorizonDays }
  }))

  // Create a standalone countdown (any member — collaborative).
  api.post('/api/countdowns', tenantRoute(async (tenant: Tenant, req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    const date = typeof b.date === 'string' ? b.date.trim() : ''
    if (!title) return res.status(400).json({ error: 'BadRequest', message: 'title is required' })
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'BadRequest', message: 'date must be YYYY-MM-DD' })
    const emoji = typeof b.emoji === 'string' && b.emoji.trim() ? b.emoji.trim().slice(0, 8) : null
    const color = typeof b.color === 'string' && b.color.trim() ? b.color.trim().slice(0, 16) : null
    const { rows } = await query<{ id: string }>(
      `insert into countdowns (household_id, title, date, emoji, color, created_by)
         values ($1, $2, $3, $4, $5, $6) returning id`,
      [tenant.householdId, title, date, emoji, color, tenant.personId ?? null]
    )
    return res.status(201).json({ id: rows[0].id })
  }))

  // Edit a standalone countdown.
  api.patch('/api/countdowns/:id', tenantRoute(async (tenant: Tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'countdown not found' })
    const b = (req.body ?? {}) as Record<string, unknown>
    const cols: string[] = []
    const vals: unknown[] = []
    let i = 1
    const set = (c: string, v: unknown) => { cols.push(`${c} = $${i++}`); vals.push(v) }
    if (typeof b.title === 'string') { if (!b.title.trim()) return res.status(400).json({ error: 'BadRequest', message: 'title cannot be empty' }); set('title', b.title.trim()) }
    if ('date' in b) { if (!DATE_RE.test(String(b.date))) return res.status(400).json({ error: 'BadRequest', message: 'date must be YYYY-MM-DD' }); set('date', String(b.date)) }
    if ('emoji' in b) set('emoji', b.emoji != null && String(b.emoji).trim() ? String(b.emoji).trim().slice(0, 8) : null)
    if ('color' in b) set('color', b.color != null && String(b.color).trim() ? String(b.color).trim().slice(0, 16) : null)
    if (!cols.length) return res.status(400).json({ error: 'BadRequest', message: 'no updatable fields provided' })
    cols.push('updated_at = now()')
    vals.push(tenant.householdId, id)
    const { rowCount } = await query(
      `update countdowns set ${cols.join(', ')} where household_id = $${i++} and id = $${i} and deleted_at is null`,
      vals
    )
    if (!rowCount) return res.status(404).json({ error: 'NotFound', message: 'countdown not found' })
    return { ok: true }
  }))

  // Delete a standalone countdown.
  api.delete('/api/countdowns/:id', tenantRoute(async (tenant: Tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'countdown not found' })
    const { rowCount } = await query(
      `update countdowns set deleted_at = now() where household_id = $1 and id = $2 and deleted_at is null`,
      [tenant.householdId, id]
    )
    if (!rowCount) return res.status(404).json({ error: 'NotFound', message: 'countdown not found' })
    return res.status(204).send('')
  }))

  // Household-wide countdown display prefs: "N sleeps" vs "N days", and how far ahead
  // birthdays surface. Either field may be sent; each is validated and merged in.
  api.put('/api/countdowns/config', tenantRoute(async (tenant: Tenant, req: Request, res: Response) => {
    const b = (req.body ?? {}) as { sleeps?: unknown; birthdayHorizonDays?: unknown }
    const patch: { sleeps?: boolean; birthdayHorizonDays?: number } = {}
    if ('sleeps' in b) {
      if (typeof b.sleeps !== 'boolean') return res.status(400).json({ error: 'BadRequest', message: 'sleeps must be a boolean' })
      patch.sleeps = b.sleeps
    }
    if ('birthdayHorizonDays' in b) {
      const n = Number(b.birthdayHorizonDays)
      if (!Number.isFinite(n) || n < 1 || n > 366) return res.status(400).json({ error: 'BadRequest', message: 'birthdayHorizonDays must be 1–366' })
      patch.birthdayHorizonDays = Math.round(n)
    }
    if (!('sleeps' in patch) && !('birthdayHorizonDays' in patch)) {
      return res.status(400).json({ error: 'BadRequest', message: 'sleeps (boolean) or birthdayHorizonDays (number) is required' })
    }
    await query(
      `update households
          set settings = coalesce(settings, '{}'::jsonb)
               || jsonb_build_object('countdowns', coalesce(settings->'countdowns', '{}'::jsonb) || $2::jsonb)
        where id = $1`,
      [tenant.householdId, JSON.stringify(patch)]
    )
    return patch
  }))
}

// Family Night — a recurring family gathering with a small, customizable agenda of
// "parts" (roles) that auto-rotate among members and can be overridden per week.
// Config lives in households.settings.familyNight; family_night_occurrences +
// family_night_assignments record each actual gathering and who did what.
import { getPool, query } from '../../platform/db'
import { createEvent, softDeleteEvent } from '../events/events'
import type { Tenant } from '../households/households'

export interface FamilyNightPart {
  id: string // stable slug (matches family_night_assignments.part_id)
  label: string
  emoji: string
  // Auto-rotate this part among members. Off ⇒ it's shown but never auto-assigned
  // (e.g. a fixed host); a person can still be set manually.
  rotates: boolean
}

export interface FamilyNightConfig {
  parts: FamilyNightPart[]
  dayOfWeek: number // 0=Sunday … 6=Saturday
  time: string // 'HH:MM' local — used only when a calendar event is linked
  // Explicit rotation order (personIds). null ⇒ all members in their sort order.
  rotationOrder: string[] | null
  // Linked recurring calendar event (so Family Night shows on the calendar). null
  // ⇒ not on the calendar.
  eventId: string | null
  // Show the Family Night card on the Today dashboard (independent of the module
  // being enabled). Defaults to true.
  showOnToday: boolean
}

export const DEFAULT_PARTS: FamilyNightPart[] = [
  { id: 'activity', label: 'Activity', emoji: '🎲', rotates: true },
  { id: 'treat', label: 'Treat', emoji: '🍪', rotates: true },
  { id: 'checkin', label: 'Check-in', emoji: '💬', rotates: true },
]

const DEFAULT_CONFIG: FamilyNightConfig = {
  parts: DEFAULT_PARTS,
  dayOfWeek: 1, // Monday
  time: '19:00',
  rotationOrder: null,
  eventId: null,
  showOnToday: true,
}

export interface Member {
  id: string
  name: string
  color: string | null
  emoji: string | null
}

export interface ResolvedAssignment {
  partId: string
  label: string
  emoji: string
  personId: string | null
  personName: string | null
  // true ⇒ auto-suggested by rotation (not yet saved); false ⇒ persisted/overridden.
  suggested: boolean
}

export interface FamilyNightView {
  config: FamilyNightConfig
  members: Member[]
  next: {
    date: string
    occurrenceId: string | null
    theme: string | null
    notes: string | null
    status: string
    assignments: ResolvedAssignment[]
  }
}

// Read the resolved config, filling defaults. Sanitizes stored parts so a bad
// write can't strip required fields.
export async function getConfig(householdId: string): Promise<FamilyNightConfig> {
  const { rows } = await query<{ settings: { familyNight?: Partial<FamilyNightConfig> } | null }>(
    `select settings from households where id = $1`,
    [householdId]
  )
  const c = rows[0]?.settings?.familyNight ?? {}
  const parts = Array.isArray(c.parts) && c.parts.length ? c.parts.map(cleanPart) : DEFAULT_PARTS
  return {
    parts,
    dayOfWeek: typeof c.dayOfWeek === 'number' ? clampDow(c.dayOfWeek) : DEFAULT_CONFIG.dayOfWeek,
    time: typeof c.time === 'string' && /^\d{2}:\d{2}$/.test(c.time) ? c.time : DEFAULT_CONFIG.time,
    rotationOrder: Array.isArray(c.rotationOrder) ? c.rotationOrder.filter((x) => typeof x === 'string') : null,
    eventId: typeof c.eventId === 'string' ? c.eventId : null,
    showOnToday: typeof c.showOnToday === 'boolean' ? c.showOnToday : DEFAULT_CONFIG.showOnToday,
  }
}

function cleanPart(p: Partial<FamilyNightPart>, i: number): FamilyNightPart {
  return {
    id: typeof p.id === 'string' && p.id ? p.id : `part${i + 1}`,
    label: typeof p.label === 'string' && p.label ? p.label : `Part ${i + 1}`,
    emoji: typeof p.emoji === 'string' && p.emoji ? p.emoji : '⭐',
    rotates: p.rotates !== false,
  }
}

const clampDow = (n: number) => ((Math.trunc(n) % 7) + 7) % 7

// Merge a patch into households.settings.familyNight (other settings keys preserved).
export async function setConfig(householdId: string, patch: Partial<FamilyNightConfig>): Promise<FamilyNightConfig> {
  await query(
    `update households
        set settings = coalesce(settings, '{}'::jsonb)
                       || jsonb_build_object('familyNight', coalesce(settings->'familyNight', '{}'::jsonb) || $2::jsonb)
      where id = $1`,
    [householdId, JSON.stringify(patch)]
  )
  return getConfig(householdId)
}

export async function listMembers(householdId: string): Promise<Member[]> {
  const { rows } = await query<{ id: string; name: string; color_hex: string | null; avatar_emoji: string | null }>(
    `select id, name, color_hex, avatar_emoji from persons where household_id = $1 and deleted_at is null order by sort_order, created_at`,
    [householdId]
  )
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color_hex, emoji: r.avatar_emoji }))
}

// Household "today" in its own timezone.
async function householdToday(householdId: string): Promise<string> {
  const { rows } = await query<{ today: string }>(
    `select to_char((now() at time zone coalesce(timezone,'UTC'))::date, 'YYYY-MM-DD') as today from households where id = $1`,
    [householdId]
  )
  return rows[0]?.today ?? new Date().toISOString().slice(0, 10)
}

// The next Family Night date on/after `today` (today itself counts if it's the day).
export function nextFamilyNightDate(today: string, dayOfWeek: number): string {
  const [y, m, d] = today.split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1, d))
  const delta = ((dayOfWeek - base.getUTCDay()) % 7 + 7) % 7
  base.setUTCDate(base.getUTCDate() + delta)
  return base.toISOString().slice(0, 10)
}

// How many gatherings have happened before `date` — used to stagger rotation so a
// new person takes each part the following week.
async function rotationIndex(householdId: string, date: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `select count(*)::text as n from family_night_occurrences where household_id = $1 and deleted_at is null and date < $2`,
    [householdId, date]
  )
  return Number(rows[0]?.n ?? 0)
}

// Compute the rotation-suggested person for each part.
function suggest(config: FamilyNightConfig, members: Member[], idx: number): Map<string, string | null> {
  const order = (config.rotationOrder && config.rotationOrder.length
    ? config.rotationOrder.filter((id) => members.some((m) => m.id === id))
    : members.map((m) => m.id))
  const out = new Map<string, string | null>()
  let rot = 0
  for (const part of config.parts) {
    if (part.rotates && order.length) {
      out.set(part.id, order[(idx + rot) % order.length])
      rot++
    } else {
      out.set(part.id, null)
    }
  }
  return out
}

interface OccRow {
  id: string
  date: string
  theme: string | null
  notes: string | null
  status: string
}

async function getOccurrence(householdId: string, date: string): Promise<{ occ: OccRow; assignments: Map<string, string | null> } | null> {
  const { rows } = await query<OccRow>(
    `select id, to_char(date,'YYYY-MM-DD') as date, theme, notes, status
       from family_night_occurrences where household_id = $1 and date = $2 and deleted_at is null`,
    [householdId, date]
  )
  const occ = rows[0]
  if (!occ) return null
  const a = await query<{ part_id: string; person_id: string | null }>(
    `select part_id, person_id from family_night_assignments where occurrence_id = $1`,
    [occ.id]
  )
  const assignments = new Map<string, string | null>()
  for (const r of a.rows) assignments.set(r.part_id, r.person_id)
  return { occ, assignments }
}

// Merge stored assignments (if any) over rotation suggestions for one date.
function resolveAssignments(
  config: FamilyNightConfig,
  members: Member[],
  suggested: Map<string, string | null>,
  stored: Map<string, string | null> | null
): ResolvedAssignment[] {
  const nameOf = (id: string | null) => (id ? members.find((m) => m.id === id)?.name ?? null : null)
  return config.parts.map((part) => {
    const has = stored && stored.has(part.id)
    const personId = has ? stored!.get(part.id)! : suggested.get(part.id) ?? null
    return {
      partId: part.id,
      label: part.label,
      emoji: part.emoji,
      personId,
      personName: nameOf(personId),
      suggested: !has,
    }
  })
}

export async function getView(householdId: string): Promise<FamilyNightView> {
  const [config, members, today] = await Promise.all([
    getConfig(householdId),
    listMembers(householdId),
    householdToday(householdId),
  ])
  const date = nextFamilyNightDate(today, config.dayOfWeek)
  const idx = await rotationIndex(householdId, date)
  const suggested = suggest(config, members, idx)
  const existing = await getOccurrence(householdId, date)
  return {
    config,
    members,
    next: {
      date,
      occurrenceId: existing?.occ.id ?? null,
      theme: existing?.occ.theme ?? null,
      notes: existing?.occ.notes ?? null,
      status: existing?.occ.status ?? 'planned',
      assignments: resolveAssignments(config, members, suggested, existing?.assignments ?? null),
    },
  }
}

export interface UpsertOccurrenceInput {
  date: string
  theme?: string | null
  notes?: string | null
  status?: string
  // Partial overrides: only the parts present are written; the rest stay on rotation.
  assignments?: { partId: string; personId: string | null }[]
}

const VALID_STATUS = new Set(['planned', 'done', 'skipped'])

// Create or update the gathering for a date and persist any provided assignments.
export async function upsertOccurrence(tenant: Tenant, input: UpsertOccurrenceInput): Promise<{ id: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw Object.assign(new Error('bad date'), { statusCode: 400 })
  if (input.status && !VALID_STATUS.has(input.status)) throw Object.assign(new Error('bad status'), { statusCode: 400 })
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const occ = await client.query<{ id: string }>(
      `insert into family_night_occurrences (household_id, date, theme, notes, status)
         values ($1, $2, $3, $4, coalesce($5, 'planned'))
       on conflict (household_id, date) where deleted_at is null
         do update set theme = coalesce(excluded.theme, family_night_occurrences.theme),
                       notes = coalesce(excluded.notes, family_night_occurrences.notes),
                       status = coalesce($5, family_night_occurrences.status),
                       updated_at = now()
       returning id`,
      [tenant.householdId, input.date, input.theme ?? null, input.notes ?? null, input.status ?? null]
    )
    const occurrenceId = occ.rows[0].id
    for (const a of input.assignments ?? []) {
      await client.query(
        `insert into family_night_assignments (household_id, occurrence_id, part_id, person_id)
           values ($1, $2, $3, $4)
         on conflict (occurrence_id, part_id)
           do update set person_id = excluded.person_id, updated_at = now()`,
        [tenant.householdId, occurrenceId, a.partId, a.personId]
      )
    }
    await client.query('commit')
    return { id: occurrenceId }
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Create/refresh the linked recurring calendar event from the current day/time.
// Replaces any previously-linked event so day/time edits take effect.
export async function scheduleEvent(tenant: Tenant): Promise<string> {
  const config = await getConfig(tenant.householdId)
  if (config.eventId) await softDeleteEvent(tenant.householdId, config.eventId).catch(() => {})
  const today = await householdToday(tenant.householdId)
  const date = nextFamilyNightDate(today, config.dayOfWeek)
  const DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][config.dayOfWeek]
  const { rows } = await query<{ timezone: string }>(`select timezone from households where id = $1`, [tenant.householdId])
  const tz = rows[0]?.timezone || 'UTC'
  const event = await createEvent(tenant, {
    title: '🏡 Family Night',
    startsAt: `${date}T${config.time}:00`,
    timezone: tz,
    // Omit calendarId → auto-route to the household owner's ★ default calendar, so a
    // recurring family event lands on Google (and everyone's phones) when connected,
    // and stays Nook-local otherwise.
    rrule: `FREQ=WEEKLY;BYDAY=${DAY}`,
  })
  await setConfig(tenant.householdId, { eventId: event.id })
  return event.id
}

export async function unscheduleEvent(tenant: Tenant): Promise<void> {
  const config = await getConfig(tenant.householdId)
  if (config.eventId) await softDeleteEvent(tenant.householdId, config.eventId).catch(() => {})
  await setConfig(tenant.householdId, { eventId: null })
}

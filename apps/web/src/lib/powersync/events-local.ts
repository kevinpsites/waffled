// Offline-first agenda reads: format/query the events straight from the local
// PowerSync DB, mirroring what the server computes for /api/events (timezone day
// bucketing, person color/owner, participant list). Pure helpers here are unit-
// tested; watchAgendaRows streams live rows. Falls back gracefully (no DB → no-op).
import type { AgendaEvent, Participant } from '../api/events'
import { getPowerSyncDb } from './db'

// ── Delete tombstones ────────────────────────────────────────────────────────
// A locally-deleted event can briefly reappear: PowerSync acks the CRUD upload
// (clearing the pending local delete) before the server's soft-delete replicates
// back into the sync bucket, so the stale row resurfaces in the watch until
// replication catches up. We tombstone a deleted id and filter it out of every
// read until the window passes — persisted to localStorage so it also survives a
// reload inside that window. (Event ids are UUIDs, so a tombstone never hides a
// future event.)
const TOMBSTONE_KEY = 'nook.deletedEvents'
const TOMBSTONE_MS = 5 * 60_000

function loadTombstones(): Map<string, number> {
  const m = new Map<string, number>()
  try {
    const raw = JSON.parse(localStorage.getItem(TOMBSTONE_KEY) || '{}') as Record<string, number>
    const now = Date.now()
    for (const [id, exp] of Object.entries(raw)) if (exp > now) m.set(id, exp)
  } catch {
    /* no localStorage (SSR/tests) or bad JSON → empty */
  }
  return m
}
const tombstones = loadTombstones()
function saveTombstones(): void {
  try {
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(Object.fromEntries(tombstones)))
  } catch {
    /* ignore */
  }
}
function pruneTombstones(): void {
  const now = Date.now()
  let changed = false
  for (const [id, exp] of tombstones) if (exp <= now) { tombstones.delete(id); changed = true }
  if (changed) saveTombstones()
}
export function tombstoneEvent(id: string): void {
  tombstones.set(id, Date.now() + TOMBSTONE_MS)
  saveTombstones()
}
// Filter out tombstoned rows/events (local or REST) — keeps a just-deleted event
// hidden across the replication window.
export function dropTombstoned<T extends { id: string }>(items: T[]): T[] {
  pruneTombstones()
  return tombstones.size ? items.filter((it) => !tombstones.has(it.id)) : items
}
export function isEventTombstoned(id: string): boolean {
  pruneTombstones()
  return tombstones.has(id)
}

// One row from AGENDA_SQL — events joined to their owner, with participants as JSON.
export interface LocalEventRow {
  id: string
  series_id?: string
  occurrence_start?: string | null
  title: string
  description: string | null
  location: string | null
  starts_at: string
  ends_at: string | null
  all_day: number // SQLite has no bool; 0/1
  person_id: string | null
  goal_id?: string | null
  goal_step_id?: string | null
  origin: string | null
  origin_ref_id: string | null
  person_name: string | null
  person_color: string | null
  person_emoji: string | null
  participants_json: string | null
}

// Intl gives us tz-correct local dates without a tz library; cache per zone.
const fmtCache = new Map<string, Intl.DateTimeFormat>()
function dayFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    // en-CA renders YYYY-MM-DD; falls back to UTC if the zone is invalid.
    try {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    } catch {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
    }
    fmtCache.set(tz, f)
  }
  return f
}

// Parse a timestamp from either source format: locally-written rows are JS ISO
// ('…T…Z'); server-replicated rows are Postgres text ('YYYY-MM-DD HH:MM:SS+00').
// new Date handles the former everywhere and the latter in Chromium; the replace
// is a fallback so every engine (and the unit tests) agree.
function parseInstant(s: string): Date {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? new Date(s.replace(' ', 'T')) : d
}

// The local calendar date (YYYY-MM-DD, in tz) an instant falls on.
export function localDate(iso: string, tz: string): string {
  return dayFormatter(tz).format(parseInstant(iso))
}

export function rowToAgenda(r: LocalEventRow): AgendaEvent {
  let participants: Participant[] = []
  if (r.participants_json) {
    try {
      participants = JSON.parse(r.participants_json) as Participant[]
    } catch {
      participants = []
    }
  }
  return {
    id: r.id,
    title: r.title,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    allDay: !!r.all_day,
    location: r.location,
    description: r.description,
    personId: r.person_id,
    goalId: r.goal_id ?? null,
    goalStepId: r.goal_step_id ?? null,
    origin: r.origin,
    originRefId: r.origin_ref_id,
    personName: r.person_name,
    personColor: r.person_color,
    personEmoji: r.person_emoji,
    participants,
    seriesId: r.series_id ?? r.id,
    occurrenceStart: r.occurrence_start ?? null,
  }
}

// Compare by parsed instant, not raw string — the two source formats don't sort
// lexicographically against each other (a space sorts before 'T').
const byStart = (a: AgendaEvent, b: AgendaEvent) => parseInstant(a.startsAt).getTime() - parseInstant(b.startsAt).getTime()

// Today's agenda — same order as the server: timed before all-day, then by start.
export function eventsForDay(rows: LocalEventRow[], tz: string, day: string): AgendaEvent[] {
  return rows
    .filter((r) => localDate(r.starts_at, tz) === day)
    .map(rowToAgenda)
    .sort((a, b) => (a.allDay === b.allDay ? byStart(a, b) : a.allDay ? 1 : -1))
}

// A date range (Calendar screen) — ordered by start, like the server.
export function eventsForRange(rows: LocalEventRow[], tz: string, from: string, to: string): AgendaEvent[] {
  return rows
    .filter((r) => {
      const d = localDate(r.starts_at, tz)
      return d >= from && d <= to
    })
    .map(rowToAgenda)
    .sort(byStart)
}

// Pull every (non-deleted — the local DB only holds those) renderable row with
// owner + participants. UNION of single/Google events (rrule null) and recurring
// occurrences joined to their master — mirroring the server's read model. We
// filter/bucket by date in JS since SQLite tz support is weak.
const participantsJson = (idExpr: string) => `
  (select json_group_array(json_object(
            'id', pp.id, 'name', pp.name, 'colorHex', pp.color_hex, 'avatarEmoji', pp.avatar_emoji)
            order by pp.sort_order, pp.created_at)
     from event_participants ep
     join persons pp on pp.id = ep.person_id
    where ep.event_id = ${idExpr}) as participants_json`

// Single events (and Google-expanded instances). Also the detail-by-id source.
const SINGLE_SELECT = `
  select e.id as id, e.id as series_id, null as occurrence_start,
         e.title, e.description, e.location, e.starts_at, e.ends_at, e.all_day, e.person_id, e.goal_id, e.goal_step_id,
         e.origin, e.origin_ref_id,
         p.name as person_name, p.color_hex as person_color, p.avatar_emoji as person_emoji,
         ${participantsJson('e.id')}
    from events e
    left join persons p on p.id = e.person_id`

// Materialized occurrences of a recurring master (m) — inherits the master's
// participants/goal; o carries the (possibly overridden) time/title/location/owner.
const OCC_SELECT = `
  select o.id as id, m.id as series_id, o.original_start as occurrence_start,
         coalesce(o.title, m.title) as title, m.description, coalesce(o.location, m.location) as location,
         o.starts_at, o.ends_at, o.all_day, o.person_id, m.goal_id, m.goal_step_id,
         m.origin, m.origin_ref_id,
         p.name as person_name, p.color_hex as person_color, p.avatar_emoji as person_emoji,
         ${participantsJson('m.id')}
    from event_occurrences o
    join events m on m.id = o.event_id
    left join persons p on p.id = o.person_id`

const AGENDA_SQL = `${SINGLE_SELECT} where e.rrule is null union all ${OCC_SELECT}`

// A single event by id from the local DB (the detail screen's instant/offline
// paint). Resolves a master/single by id (a recurring occurrence's detail uses its
// series id). Returns null when PowerSync isn't running or the row isn't local yet —
// the caller then leans on REST. tz is accepted for signature symmetry.
export async function getLocalEvent(id: string, _tz: string): Promise<AgendaEvent | null> {
  if (isEventTombstoned(id)) return null
  const db = getPowerSyncDb()
  if (!db) return null
  try {
    const row = await db.getOptional<LocalEventRow>(`${SINGLE_SELECT} where e.id = ?`, [id])
    return row ? rowToAgenda(row) : null
  } catch {
    return null
  }
}

// The household timezone the kiosk should bucket by (synced households row), with
// the device zone as a fallback before the first sync.
export async function getHouseholdTz(): Promise<string> {
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const db = getPowerSyncDb()
  if (!db) return deviceTz
  try {
    const row = await db.getOptional<{ timezone: string | null }>('select timezone from households limit 1')
    return row?.timezone || deviceTz
  } catch {
    return deviceTz
  }
}

// ── Local writes (offline-first) ───────────────────────────────────────────────
// Write straight to the local DB; PowerSync queues + uploads to /api/powersync/crud.
// The local-first reads pick these up instantly (optimistic, works offline). Each
// returns false when PowerSync isn't running, so callers fall back to REST.

export interface EventDraft {
  title: string
  startsAt: string
  endsAt: string | null
  allDay: boolean
  location: string | null
  personIds: string[]
  goalId?: string | null // calendar→goal link; null = not linked
  goalStepId?: string | null // for a checklist goal, which step this event completes
  calendarId?: string | null // create only; null = let the server auto-route
}

async function householdRowId(): Promise<string | null> {
  const db = getPowerSyncDb()
  if (!db) return null
  const row = await db.getOptional<{ id: string }>('select id from households limit 1')
  return row?.id ?? null
}

export async function createEventLocal(draft: EventDraft): Promise<boolean> {
  const db = getPowerSyncDb()
  if (!db) return false
  const hh = await householdRowId()
  const tz = await getHouseholdTz()
  const id = crypto.randomUUID()
  // Only columns present in the client schema (schema.ts) — sync_state/status are
  // server-owned and not replicated, so they must not appear here.
  await db.execute(
    `insert into events
       (id, household_id, title, description, location, starts_at, ends_at, all_day, timezone,
        person_id, goal_id, goal_step_id, calendar_id, origin)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
    [id, hh, draft.title, null, draft.location, draft.startsAt, draft.endsAt, draft.allDay ? 1 : 0, tz, draft.personIds[0] ?? null, draft.goalId ?? null, draft.goalStepId ?? null, draft.calendarId ?? null]
  )
  for (const pid of [...new Set(draft.personIds)]) {
    await db.execute(`insert into event_participants (id, household_id, event_id, person_id) values (?, ?, ?, ?)`, [
      crypto.randomUUID(),
      hh,
      id,
      pid,
    ])
  }
  return true
}

export async function updateEventLocal(id: string, draft: EventDraft): Promise<boolean> {
  const db = getPowerSyncDb()
  if (!db) return false
  const hh = await householdRowId()
  const res = await db.execute(
    `update events set title = ?, location = ?, starts_at = ?, ends_at = ?, all_day = ?, person_id = ?, goal_id = ?, goal_step_id = ? where id = ?`,
    [draft.title, draft.location, draft.startsAt, draft.endsAt, draft.allDay ? 1 : 0, draft.personIds[0] ?? null, draft.goalId ?? null, draft.goalStepId ?? null, id]
  )
  // Row not in the local DB yet (PowerSync hasn't synced it) → the update matched
  // nothing and would never upload. Bail so the caller saves via REST instead.
  if ((res.rowsAffected ?? 0) === 0) return false
  await db.execute(`delete from event_participants where event_id = ?`, [id])
  for (const pid of [...new Set(draft.personIds)]) {
    await db.execute(`insert into event_participants (id, household_id, event_id, person_id) values (?, ?, ?, ?)`, [
      crypto.randomUUID(),
      hh,
      id,
      pid,
    ])
  }
  return true
}

export async function deleteEventLocal(id: string): Promise<boolean> {
  const db = getPowerSyncDb()
  if (!db) return false
  await db.execute(`delete from event_participants where event_id = ?`, [id])
  const res = await db.execute(`delete from events where id = ?`, [id])
  // Only a row that's actually in the local DB queues a CRUD op that uploads the
  // delete. If PowerSync hasn't synced this event yet (rowsAffected 0), the local
  // delete is a no-op that would NEVER reach the server — report failure so the
  // caller falls back to the REST delete instead of silently dropping it.
  if ((res.rowsAffected ?? 0) === 0) return false
  // Real local delete in flight (crud upload, retried by PowerSync) — tombstone so
  // it stays hidden across the replication window instead of briefly reappearing.
  tombstoneEvent(id)
  return true
}

// Stream agenda rows live from the local DB. Returns a disposer; a no-op disposer
// when PowerSync isn't running so callers can use it unconditionally.
export function watchAgendaRows(onRows: (rows: LocalEventRow[]) => void, onError?: (e: unknown) => void): () => void {
  const db = getPowerSyncDb()
  if (!db) return () => {}
  const controller = new AbortController()
  try {
    db.watch(
      AGENDA_SQL,
      [],
      {
        onResult: (result) => onRows(dropTombstoned((result.rows?._array ?? []) as LocalEventRow[])),
        onError: (e) => onError?.(e),
      },
      { signal: controller.signal, tables: ['events', 'event_participants', 'event_occurrences', 'persons'] }
    )
  } catch (e) {
    onError?.(e)
    return () => {}
  }
  return () => controller.abort()
}

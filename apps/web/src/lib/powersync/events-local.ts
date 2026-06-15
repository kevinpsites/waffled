// Offline-first agenda reads: format/query the events straight from the local
// PowerSync DB, mirroring what the server computes for /api/events (timezone day
// bucketing, person color/owner, participant list). Pure helpers here are unit-
// tested; watchAgendaRows streams live rows. Falls back gracefully (no DB → no-op).
import type { AgendaEvent, Participant } from '../api/events'
import { getPowerSyncDb } from './db'

// One row from AGENDA_SQL — events joined to their owner, with participants as JSON.
export interface LocalEventRow {
  id: string
  title: string
  description: string | null
  location: string | null
  starts_at: string
  ends_at: string | null
  all_day: number // SQLite has no bool; 0/1
  person_id: string | null
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
    personId: r.person_id,
    personName: r.person_name,
    personColor: r.person_color,
    personEmoji: r.person_emoji,
    participants,
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

// Pull every (non-deleted — the local DB only holds those) event with owner +
// participants. We filter/bucket by date in JS since SQLite tz support is weak.
const AGENDA_SQL = `
  select e.id, e.title, e.description, e.location, e.starts_at, e.ends_at, e.all_day, e.person_id,
         p.name as person_name, p.color_hex as person_color, p.avatar_emoji as person_emoji,
         (select json_group_array(json_object(
                   'id', pp.id, 'name', pp.name, 'colorHex', pp.color_hex, 'avatarEmoji', pp.avatar_emoji))
            from event_participants ep
            join persons pp on pp.id = ep.person_id
           where ep.event_id = e.id) as participants_json
    from events e
    left join persons p on p.id = e.person_id
`

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
        person_id, calendar_id, origin)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
    [id, hh, draft.title, null, draft.location, draft.startsAt, draft.endsAt, draft.allDay ? 1 : 0, tz, draft.personIds[0] ?? null, draft.calendarId ?? null]
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
  await db.execute(
    `update events set title = ?, location = ?, starts_at = ?, ends_at = ?, all_day = ?, person_id = ? where id = ?`,
    [draft.title, draft.location, draft.startsAt, draft.endsAt, draft.allDay ? 1 : 0, draft.personIds[0] ?? null, id]
  )
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
  await db.execute(`delete from events where id = ?`, [id])
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
        onResult: (result) => onRows(((result.rows?._array ?? []) as LocalEventRow[])),
        onError: (e) => onError?.(e),
      },
      { signal: controller.signal, tables: ['events', 'event_participants', 'persons'] }
    )
  } catch (e) {
    onError?.(e)
    return () => {}
  }
  return () => controller.abort()
}

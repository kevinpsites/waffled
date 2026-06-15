// Calendar — inbound Google sync (roadmap 5.3). Pulls events from each connected,
// selected calendar into the events table. On-demand via POST /api/calendar/sync;
// the same engine (syncHousehold) is what a scheduled poll will call later.
//
// Per calendar we keep an incremental cursor (calendars.sync_token): the first run
// pulls a bounded window, every run after that fetches only what changed. Recurring
// events are expanded server-side (singleEvents) so the agenda reads dated instances
// without an RRULE engine. Google owns the event content (title/time/status — sync
// overwrites); Nook owns person_id/origin (seeded from the calendar mapping on first
// import, never clobbered afterward).
import createAPI, { type Request, type Response } from 'lambda-api'
import type { PoolClient, QueryResultRow } from 'pg'
import { getPool, query } from './db'
import { requireTenant } from './households'
import { decryptSecret, encryptionAvailable } from './crypto'
import {
  googleConfigured,
  refreshAccessToken,
  listEventsPage,
  SyncTokenInvalidError,
  type GoogleEvent,
  type GoogleEventDateTime,
} from './google'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 86_400_000
// First-sync window: enough history for "recent" + a year out for planning. After
// that the sync token tracks changes; rolling the window forward is a full resync.
const PAST_DAYS = 30
const FUTURE_DAYS = 365
const MAX_PAGES = 50 // safety rail against a pathological pagination loop

interface SelectedCalendarRow extends QueryResultRow {
  id: string
  household_id: string
  account_id: string
  google_calendar_id: string
  summary: string | null
  timezone: string | null
  person_id: string | null
  sync_token: string | null
  refresh_token_encrypted: string
  household_timezone: string
}

export interface CalendarSyncResult {
  calendarId: string
  summary: string | null
  imported: number
  updated: number
  deleted: number
  fullResync: boolean
  error?: string
}

export interface HouseholdSyncResult {
  calendars: CalendarSyncResult[]
  imported: number
  updated: number
  deleted: number
}

// Selected, non-deleted calendars whose account is still connected, with the
// account's refresh token and the household tz (fallback for all-day anchoring).
async function selectedCalendars(householdId: string, onlyId?: string): Promise<SelectedCalendarRow[]> {
  const { rows } = await query<SelectedCalendarRow>(
    `select c.id, c.household_id, c.account_id, c.google_calendar_id, c.summary, c.timezone,
            c.person_id, c.sync_token, a.refresh_token_encrypted, h.timezone as household_timezone
       from calendars c
       join calendar_accounts a on a.id = c.account_id and a.deleted_at is null
       join households h on h.id = c.household_id
      where c.household_id = $1 and c.deleted_at is null and c.selected = true
        ${onlyId ? 'and c.id = $2' : ''}
      order by c.is_primary desc, c.summary`,
    onlyId ? [householdId, onlyId] : [householdId]
  )
  return rows
}

// Google gives start/end as either a date (all-day) or an offset-bearing dateTime.
// Returns the raw string to cast plus the resolved zone for all-day anchoring.
function resolveInstant(
  dt: GoogleEventDateTime | null,
  fallbackTz: string
): { raw: string | null; allDay: boolean; tz: string } {
  if (!dt) return { raw: null, allDay: false, tz: fallbackTz }
  if (dt.date) return { raw: `${dt.date} 00:00:00`, allDay: true, tz: dt.timeZone ?? fallbackTz }
  return { raw: dt.dateTime, allDay: false, tz: dt.timeZone ?? fallbackTz }
}

// Upsert one Google event into events, keyed by (calendar_id, google_event_id).
// Google-owned columns are overwritten; person_id is seeded from the calendar
// mapping but coalesced on update so a manual reassignment survives.
// Returns 'imported' | 'updated' | 'deleted'.
async function applyEvent(
  client: PoolClient,
  cal: SelectedCalendarRow,
  ev: GoogleEvent
): Promise<'imported' | 'updated' | 'deleted'> {
  // Tombstone: incremental sync returns cancelled instances for deletions.
  if (ev.status === 'cancelled') {
    await client.query(
      `update events set deleted_at = now(), status = 'cancelled', sync_state = 'synced'
        where calendar_id = $1 and google_event_id = $2 and deleted_at is null`,
      [cal.id, ev.id]
    )
    return 'deleted'
  }

  const fallbackTz = cal.timezone ?? cal.household_timezone
  const s = resolveInstant(ev.start, fallbackTz)
  const e = resolveInstant(ev.end, fallbackTz)
  const allDay = s.allDay

  const { rows } = await client.query<{ inserted: boolean }>(
    `insert into events (
       household_id, calendar_id, person_id, origin,
       title, description, location,
       starts_at, ends_at, all_day, timezone,
       status, google_event_id, ical_uid, etag, sequence, google_updated, sync_state
     ) values (
       $1, $2, $3, 'google',
       $4, $5, $6,
       case when $7 then ($8::text)::timestamp at time zone $9 else ($8::text)::timestamptz end,
       case when $10::text is null then null
            when $7 then ($10::text)::timestamp at time zone $9
            else ($10::text)::timestamptz end,
       $7, $9,
       coalesce($11, 'confirmed'), $12, $13, $14, $15, $16, 'synced'
     )
     on conflict (calendar_id, google_event_id) where google_event_id is not null
     do update set
       title = excluded.title,
       description = excluded.description,
       location = excluded.location,
       starts_at = excluded.starts_at,
       ends_at = excluded.ends_at,
       all_day = excluded.all_day,
       timezone = excluded.timezone,
       status = excluded.status,
       ical_uid = excluded.ical_uid,
       etag = excluded.etag,
       sequence = excluded.sequence,
       google_updated = excluded.google_updated,
       sync_state = 'synced',
       deleted_at = null,
       person_id = coalesce(events.person_id, excluded.person_id)
     returning (xmax = 0) as inserted`,
    [
      cal.household_id,
      cal.id,
      cal.person_id,
      ev.summary ?? '(untitled)',
      ev.description,
      ev.location,
      allDay,
      s.raw,
      s.tz,
      e.raw,
      ev.status,
      ev.id,
      ev.iCalUID,
      ev.etag,
      ev.sequence,
      ev.updated,
    ]
  )
  return rows[0]?.inserted ? 'imported' : 'updated'
}

// Page through one calendar, applying every event, and persist the new cursor.
// A 410 (stale token) drops the cursor and retries once as a full-window sync.
async function syncCalendar(
  cal: SelectedCalendarRow,
  accessToken: string,
  now: number
): Promise<CalendarSyncResult> {
  const res: CalendarSyncResult = {
    calendarId: cal.id,
    summary: cal.summary,
    imported: 0,
    updated: 0,
    deleted: 0,
    fullResync: !cal.sync_token,
  }

  const fullWindow = {
    timeMin: new Date(now - PAST_DAYS * DAY_MS).toISOString(),
    timeMax: new Date(now + FUTURE_DAYS * DAY_MS).toISOString(),
  }

  let syncToken = cal.sync_token
  let attemptedFull = !syncToken

  const client = await getPool().connect()
  try {
    runSync: for (;;) {
      let pageToken: string | null = null
      let nextSyncToken: string | null = null
      let pages = 0
      const counts = { imported: 0, updated: 0, deleted: 0 }

      try {
        for (;;) {
          if (++pages > MAX_PAGES) break
          const page = await listEventsPage(accessToken, cal.google_calendar_id, {
            syncToken: syncToken ?? undefined,
            timeMin: syncToken ? undefined : fullWindow.timeMin,
            timeMax: syncToken ? undefined : fullWindow.timeMax,
            pageToken: pageToken ?? undefined,
          })

          await client.query('begin')
          try {
            for (const ev of page.events) {
              const outcome = await applyEvent(client, cal, ev)
              counts[outcome]++
            }
            await client.query('commit')
          } catch (err) {
            await client.query('rollback')
            throw err
          }

          if (page.nextSyncToken) nextSyncToken = page.nextSyncToken
          if (!page.nextPageToken) break
          pageToken = page.nextPageToken
        }
      } catch (err) {
        if (err instanceof SyncTokenInvalidError && !attemptedFull) {
          // Stale cursor: clear it and restart the whole pull as a full resync.
          syncToken = null
          attemptedFull = true
          res.fullResync = true
          continue runSync
        }
        throw err
      }

      res.imported = counts.imported
      res.updated = counts.updated
      res.deleted = counts.deleted

      // Persist the new cursor + stamp. (Google only emits nextSyncToken on the
      // final page; if absent we keep the prior token rather than lose our place.)
      await client.query(
        `update calendars
            set sync_token = coalesce($1, sync_token), last_synced_at = now()
          where id = $2`,
        [nextSyncToken, cal.id]
      )
      return res
    }
  } finally {
    client.release()
  }
}

// Sync every selected calendar in the household (or one, if calendarId given).
// Calendars sharing an account share a single refreshed access token. A failure
// on one calendar/account is captured per-row and doesn't abort the others.
export async function syncHousehold(
  householdId: string,
  opts: { calendarId?: string; now?: number } = {}
): Promise<HouseholdSyncResult> {
  const cals = await selectedCalendars(householdId, opts.calendarId)
  const now = opts.now ?? Date.now()

  // One access token per account (decrypt refresh token + exchange once).
  const tokenByAccount = new Map<string, { accessToken?: string; error?: string }>()
  async function accessFor(cal: SelectedCalendarRow): Promise<{ accessToken?: string; error?: string }> {
    const cached = tokenByAccount.get(cal.account_id)
    if (cached) return cached
    let entry: { accessToken?: string; error?: string }
    try {
      const refresh = decryptSecret(cal.refresh_token_encrypted)
      const tok = await refreshAccessToken(refresh)
      entry = { accessToken: tok.accessToken }
    } catch (err) {
      entry = { error: err instanceof Error ? err.message : 'token refresh failed' }
    }
    tokenByAccount.set(cal.account_id, entry)
    return entry
  }

  const results: CalendarSyncResult[] = []
  for (const cal of cals) {
    const base: CalendarSyncResult = {
      calendarId: cal.id,
      summary: cal.summary,
      imported: 0,
      updated: 0,
      deleted: 0,
      fullResync: !cal.sync_token,
    }
    const tok = await accessFor(cal)
    if (!tok.accessToken) {
      results.push({ ...base, error: tok.error ?? 'no access token' })
      continue
    }
    try {
      results.push(await syncCalendar(cal, tok.accessToken, now))
    } catch (err) {
      results.push({ ...base, error: err instanceof Error ? err.message : 'sync failed' })
    }
  }

  return {
    calendars: results,
    imported: results.reduce((n, r) => n + r.imported, 0),
    updated: results.reduce((n, r) => n + r.updated, 0),
    deleted: results.reduce((n, r) => n + r.deleted, 0),
  }
}

export function registerCalendarSyncRoutes(api: Api): void {
  // Pull connected calendars now. Any household member can refresh; the work is
  // read-from-Google + mirror, gated only on the connection being configured.
  api.post('/api/calendar/sync', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    if (!googleConfigured() || !encryptionAvailable()) {
      return res.status(501).json({
        error: 'NotConfigured',
        message: 'Google OAuth / token encryption is not configured on the server',
      })
    }
    const calendarId =
      typeof (req.body as { calendarId?: unknown })?.calendarId === 'string'
        ? (req.body as { calendarId: string }).calendarId
        : undefined
    if (calendarId && !UUID_RE.test(calendarId)) {
      return res.status(400).json({ error: 'BadRequest', message: 'calendarId must be a uuid' })
    }
    const result = await syncHousehold(tenant.householdId, { calendarId })
    return result
  })
}

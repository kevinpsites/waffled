// Calendar — Google sync, both directions. Inbound (5.3) pulls events from each
// connected, selected calendar into the events table; outbound (5.4) pushes
// Nook-authored events back to Google. On-demand via POST /api/calendar/sync
// (push pending first, then pull); the same engines back a future scheduled poll.
//
// Inbound: per calendar we keep an incremental cursor (calendars.sync_token); the
// first run pulls a bounded window, later runs fetch only changes. Recurrences are
// expanded server-side (singleEvents). Google owns event content (title/time/status
// — sync overwrites); Nook owns person_id/origin (preserved).
//
// Outbound: an event authored in Nook for a person is routed to that person's
// write-target calendar (resolveWriteTarget) and created/updated/deleted on Google.
// sync_state tracks it: pending_push → synced, or push_failed (retried next sync).
import createAPI, { type Request, type Response } from 'lambda-api'
import type { PoolClient, QueryResultRow } from 'pg'
import { getPool, query } from '../../platform/db'
import { requireTenant } from '../households/households'
import { decryptSecret, encryptionAvailable } from '../../platform/crypto'
import {
  googleConfigured,
  refreshAccessToken,
  listEventsPage,
  insertEvent,
  patchEvent,
  deleteEvent,
  SyncTokenInvalidError,
  type GoogleEvent,
  type GoogleEventDateTime,
  type GoogleEventWrite,
  type GoogleWriteResult,
} from '../../integrations/google'

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

// ── Outbound (5.4): push Nook-authored events to Google ────────────────────────

export interface WriteTarget {
  calendarId: string
  googleCalendarId: string
  refreshTokenEncrypted: string
}

// Where a Nook event for this person should be written. Prefers the explicit
// write-target flag, then the person's primary, then any writable calendar — so a
// person with a single writable calendar needs no configuration. Read-only
// calendars (reader/freeBusyReader) are never write targets.
export async function resolveWriteTarget(householdId: string, personId: string | null): Promise<WriteTarget | null> {
  if (!personId) return null
  const { rows } = await query<{ calendar_id: string; google_calendar_id: string; refresh_token_encrypted: string }>(
    `select c.id as calendar_id, c.google_calendar_id, a.refresh_token_encrypted
       from calendars c
       join calendar_accounts a on a.id = c.account_id and a.deleted_at is null
      where c.household_id = $1 and c.person_id = $2 and c.deleted_at is null
        and c.access_role in ('owner','writer')
      order by c.is_write_target desc, c.is_primary desc, c.summary
      limit 1`,
    [householdId, personId]
  )
  const r = rows[0]
  return r
    ? { calendarId: r.calendar_id, googleCalendarId: r.google_calendar_id, refreshTokenEncrypted: r.refresh_token_encrypted }
    : null
}

// Resolve a specific calendar chosen for an event (the create-time picker). Only
// returns it if it's a writable, connected calendar in the household — otherwise
// null, so an invalid/stale choice falls back to a local-only event.
export async function resolveWriteTargetById(householdId: string, calendarId: string): Promise<WriteTarget | null> {
  const { rows } = await query<{ calendar_id: string; google_calendar_id: string; refresh_token_encrypted: string }>(
    `select c.id as calendar_id, c.google_calendar_id, a.refresh_token_encrypted
       from calendars c
       join calendar_accounts a on a.id = c.account_id and a.deleted_at is null
      where c.household_id = $1 and c.id = $2 and c.deleted_at is null
        and c.access_role in ('owner','writer')
      limit 1`,
    [householdId, calendarId]
  )
  const r = rows[0]
  return r
    ? { calendarId: r.calendar_id, googleCalendarId: r.google_calendar_id, refreshTokenEncrypted: r.refresh_token_encrypted }
    : null
}

interface PushRow extends QueryResultRow {
  id: string
  title: string
  description: string | null
  location: string | null
  all_day: boolean
  timezone: string
  starts_at: Date
  ends_at: Date | null
  start_date: string
  end_date: string | null
  google_event_id: string | null
  deleted_at: Date | null
  google_calendar_id: string
  refresh_token_encrypted: string
}

// Events joined to their (connected) write calendar + account. all-day dates are
// rendered in the event's own zone so Google gets the right calendar day.
const PUSH_SELECT = `
  select e.id, e.title, e.description, e.location, e.all_day, e.timezone,
         e.starts_at, e.ends_at, e.google_event_id, e.deleted_at,
         to_char(e.starts_at at time zone e.timezone, 'YYYY-MM-DD') as start_date,
         to_char(e.ends_at   at time zone e.timezone, 'YYYY-MM-DD') as end_date,
         c.google_calendar_id, a.refresh_token_encrypted
    from events e
    join calendars c on c.id = e.calendar_id and c.deleted_at is null
    join calendar_accounts a on a.id = c.account_id and a.deleted_at is null
   where e.household_id = $1`

function buildWriteBody(ev: PushRow): GoogleEventWrite {
  if (ev.all_day) {
    // Google all-day end is exclusive; default to the day after start.
    const end = ev.end_date ?? new Date(new Date(`${ev.start_date}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10)
    return {
      summary: ev.title,
      description: ev.description,
      location: ev.location,
      start: { date: ev.start_date },
      end: { date: end },
    }
  }
  const startIso = ev.starts_at.toISOString()
  const endIso = (ev.ends_at ?? new Date(ev.starts_at.getTime() + 60 * 60 * 1000)).toISOString()
  return {
    summary: ev.title,
    description: ev.description,
    location: ev.location,
    start: { dateTime: startIso, timeZone: ev.timezone },
    end: { dateTime: endIso, timeZone: ev.timezone },
  }
}

// Caches one refreshed access token per refresh-token (i.e. per account) so a
// batch push doesn't re-exchange for every event. Dedups concurrent callers.
function makeTokenCache(): (refreshEncrypted: string) => Promise<string> {
  const m = new Map<string, Promise<string>>()
  return (refreshEncrypted) => {
    let p = m.get(refreshEncrypted)
    if (!p) {
      p = refreshAccessToken(decryptSecret(refreshEncrypted)).then((t) => t.accessToken)
      m.set(refreshEncrypted, p)
    }
    return p
  }
}

async function storeWriteResult(eventId: string, r: GoogleWriteResult): Promise<void> {
  await query(
    `update events
        set google_event_id = $2, etag = $3, sequence = $4, google_updated = $5, sync_state = 'synced'
      where id = $1`,
    [eventId, r.id, r.etag, r.sequence, r.updated]
  )
}

type PushOutcome = 'created' | 'updated' | 'deleted' | 'skipped' | 'failed'

// Push one event: insert (new), patch (has google_event_id), or delete (soft-
// deleted). A local-only event (no connected calendar) is skipped. Failures are
// recorded as push_failed and swallowed so a mutation never fails on Google.
async function pushById(
  householdId: string,
  eventId: string,
  getToken: (refreshEncrypted: string) => Promise<string>
): Promise<PushOutcome> {
  const { rows } = await query<PushRow>(`${PUSH_SELECT} and e.id = $2`, [householdId, eventId])
  const ev = rows[0]
  if (!ev) return 'skipped'
  try {
    const accessToken = await getToken(ev.refresh_token_encrypted)
    if (ev.deleted_at) {
      if (ev.google_event_id) await deleteEvent(accessToken, ev.google_calendar_id, ev.google_event_id)
      await query(`update events set sync_state = 'synced' where id = $1`, [ev.id])
      return 'deleted'
    }
    const body = buildWriteBody(ev)
    if (ev.google_event_id) {
      await storeWriteResult(ev.id, await patchEvent(accessToken, ev.google_calendar_id, ev.google_event_id, body))
      return 'updated'
    }
    await storeWriteResult(ev.id, await insertEvent(accessToken, ev.google_calendar_id, body))
    return 'created'
  } catch (err) {
    console.error('calendar push failed', eventId, err)
    await query(`update events set sync_state = 'push_failed' where id = $1`, [eventId])
    return 'failed'
  }
}

// Push a single event immediately (called right after a Nook mutation). Safe to
// call for any event — local-only events resolve to 'skipped'.
export async function pushEventNow(householdId: string, eventId: string): Promise<PushOutcome> {
  return pushById(householdId, eventId, makeTokenCache())
}

export interface PushPendingResult {
  created: number
  updated: number
  deleted: number
  failed: number
}

// Retry the queue: every event still pending_push / push_failed (e.g. a mutation
// whose immediate push failed, or one made while offline). Runs before inbound.
export async function pushPending(householdId: string): Promise<PushPendingResult> {
  const getToken = makeTokenCache()
  const { rows } = await query<{ id: string }>(
    `select e.id
       from events e
       join calendars c on c.id = e.calendar_id and c.deleted_at is null
       join calendar_accounts a on a.id = c.account_id and a.deleted_at is null
      where e.household_id = $1 and e.calendar_id is not null
        and e.sync_state in ('pending_push', 'push_failed')
      order by e.updated_at`,
    [householdId]
  )
  const counts: PushPendingResult = { created: 0, updated: 0, deleted: 0, failed: 0 }
  for (const row of rows) {
    const outcome = await pushById(householdId, row.id, getToken)
    if (outcome !== 'skipped') counts[outcome]++
  }
  return counts
}

// ── Scheduled poll (hop 1) ─────────────────────────────────────────────────────

// Push pending + pull for every household with a connected account. This is the
// timer's unit of work; a failure on one household is logged and never aborts the
// rest. Returns how many households were processed (handy for the test/logs).
export async function syncAllHouseholds(): Promise<{ households: number }> {
  const { rows } = await query<{ household_id: string }>(
    `select distinct household_id from calendar_accounts where deleted_at is null`
  )
  for (const { household_id } of rows) {
    try {
      await pushPending(household_id)
      await syncHousehold(household_id)
    } catch (err) {
      console.error('scheduled calendar sync failed for household', household_id, err)
    }
  }
  return { households: rows.length }
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null

// Start the background poll (server.ts only — the lambda entrypoint never calls
// this). Interval is CALENDAR_SYNC_INTERVAL_MS (default 5 min); 0 disables it. A
// run-in-progress guard prevents overlap if a sync outlasts the interval.
export function startSyncScheduler(): void {
  if (schedulerTimer) return
  const intervalMs = parseInt(process.env.CALENDAR_SYNC_INTERVAL_MS ?? '300000', 10)
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return
  if (!googleConfigured() || !encryptionAvailable()) {
    console.log('calendar sync scheduler not started (Google/encryption not configured)')
    return
  }
  let running = false
  schedulerTimer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await syncAllHouseholds()
    } catch (err) {
      console.error('scheduled calendar sync error', err)
    } finally {
      running = false
    }
  }, intervalMs)
  // Don't keep the process alive for the timer alone.
  schedulerTimer.unref?.()
  console.log(`calendar sync scheduler started (every ${Math.round(intervalMs / 1000)}s)`)
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
    // Push local edits out before pulling, so a Nook change isn't clobbered by an
    // inbound overwrite of the same event in the same run.
    const pushed = await pushPending(tenant.householdId)
    const result = await syncHousehold(tenant.householdId, { calendarId })
    return { ...result, pushed }
  })
}

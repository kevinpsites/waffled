// Calendar — ICS feed subscriptions (fork P2). The third calendar source next to
// the Google/Microsoft OAuth providers: subscribe to any published ICS URL
// (school schedule, an Outlook "publish calendar" link, sports teams) and poll it
// on an interval. Read-only by nature — no OAuth, no write-back, no tokens — so
// feeds get their own small table (ics_feeds) instead of riding calendar_accounts.
//
// Events land in `events` with origin='ics', calendar_id NULL, origin_ref_id =
// the feed id, and google_event_id = the VEVENT UID (the established "provider
// external id" convention). Dedupe/idempotency rides the fork-owned partial
// unique index uq_events_ics_feed_uid on (origin_ref_id, google_event_id) WHERE
// origin='ics' — the upstream (calendar_id, google_event_id) index can't
// arbitrate NULL-calendar rows (Postgres treats NULLs as distinct).
//
// Recurring VEVENTs are stored as Waffled-native masters (events.rrule/exdate),
// so the existing expansion engine materializes their occurrences exactly like a
// manually-created recurring event; we call materializeMaster right after the
// upsert (mirroring events.ts) so they appear without waiting for the 6h tick.
// Known limitation: RECURRENCE-ID exception VEVENTs (a single moved/edited
// occurrence) are skipped — the base rule renders; per-occurrence edits from the
// feed aren't applied.
import createAPI, { type Request, type Response } from 'lambda-api'
import type { PoolClient, QueryResultRow } from 'pg'
import ICAL from 'ical.js'
import { DateTime, IANAZone } from 'luxon'
import { getPool, query } from '../../platform/db'
import { log } from '../../platform/logger'
import { runJob, registerJob } from '../../platform/jobs'
import { adminRoute, tenantRoute } from '../../platform/route-guards'
import { materializeMaster } from './expansion.service'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FETCH_TIMEOUT_MS = 30_000

// ── Feed rows ────────────────────────────────────────────────────────────────

interface FeedRow extends QueryResultRow {
  id: string
  household_id: string
  url: string
  name: string | null
  person_id: string | null
  person_name: string | null
  person_color: string | null
  visibility: string
  last_synced_at: Date | null
  last_error: string | null
  created_at: Date
  household_timezone: string
}

const FEED_SELECT = `
  select f.id, f.household_id, f.url, f.name, f.person_id, f.visibility,
         f.last_synced_at, f.last_error, f.created_at,
         p.name as person_name, p.color_hex as person_color,
         h.timezone as household_timezone
    from ics_feeds f
    join households h on h.id = f.household_id
    left join persons p on p.id = f.person_id and p.deleted_at is null
   where f.deleted_at is null`

export async function listIcsFeeds(householdId: string): Promise<FeedRow[]> {
  const { rows } = await query<FeedRow>(`${FEED_SELECT} and f.household_id = $1 order by f.created_at`, [householdId])
  return rows
}

async function getFeed(householdId: string, id: string): Promise<FeedRow | null> {
  const { rows } = await query<FeedRow>(`${FEED_SELECT} and f.household_id = $1 and f.id = $2`, [householdId, id])
  return rows[0] ?? null
}

export function presentIcsFeed(f: FeedRow) {
  return {
    id: f.id,
    url: f.url,
    name: f.name,
    personId: f.person_id,
    personName: f.person_name ?? null,
    personColor: f.person_color ?? null,
    visibility: f.visibility,
    lastSyncedAt: f.last_synced_at ?? null,
    lastError: f.last_error ?? null,
    createdAt: f.created_at,
  }
}

// ── ICS parsing ──────────────────────────────────────────────────────────────

// A start/end resolved to something the events insert can cast: for all-day the
// local date ('YYYY-MM-DD 00:00:00' anchored `at time zone tz`), for timed an
// absolute ISO instant (castable to timestamptz). Same contract as the Google
// sync's resolveInstant.
interface ResolvedInstant {
  raw: string
  allDay: boolean
  tz: string
}

const pad2 = (n: number) => String(n).padStart(2, '0')

// Convert an ICAL.Time to an absolute instant + zone. Zones come in four flavors:
//  - VTIMEZONE-resolved TZID (registered below): ical.js already computed the
//    right instant; keep the tzid when it's a real IANA name.
//  - UTC ('Z' times): trust ical.js; store the household zone as the display tz.
//  - Bare TZID with no VTIMEZONE (Google-published feeds do this): ical.js falls
//    back to floating, so re-localize the wall-clock fields ourselves via luxon.
//  - Truly floating: interpret in the household zone.
function resolveTime(t: ICAL.Time, fallbackTz: string): ResolvedInstant {
  if (t.isDate) {
    return { raw: `${t.year}-${pad2(t.month)}-${pad2(t.day)} 00:00:00`, allDay: true, tz: fallbackTz }
  }
  const zoneId = t.zone?.tzid
  if (zoneId && zoneId !== 'floating' && zoneId !== 'UTC') {
    const tz = IANAZone.isValidZone(zoneId) ? zoneId : fallbackTz
    return { raw: t.toJSDate().toISOString(), allDay: false, tz }
  }
  if (zoneId === 'UTC') {
    return { raw: t.toJSDate().toISOString(), allDay: false, tz: fallbackTz }
  }
  // floating — a raw TZID param survives on the time even when no VTIMEZONE
  // defined it (not in the public types, hence the cast).
  const rawTzid = (t as unknown as { timezone?: string }).timezone
  const tz = rawTzid && IANAZone.isValidZone(rawTzid) ? rawTzid : fallbackTz
  const dt = DateTime.fromObject(
    { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second },
    { zone: tz }
  )
  return { raw: dt.toUTC().toISO() ?? t.toJSDate().toISOString(), allDay: false, tz }
}

interface ParsedVevent {
  uid: string
  summary: string | null
  description: string | null
  location: string | null
  cancelled: boolean
  start: ResolvedInstant
  end: ResolvedInstant | null
  rrule: string | null
  exdates: string[] // absolute ISO instants (match the expansion's rule slots)
}

// Parse an ICS document into the events we can apply. Registers any embedded
// VTIMEZONEs with ical.js's global service (once per tzid) so TZID references
// resolve; skips VEVENTs without a UID (nothing to key on) and RECURRENCE-ID
// exceptions (see module header).
export function parseIcs(text: string, fallbackTz: string): ParsedVevent[] {
  const comp = new ICAL.Component(ICAL.parse(text))
  for (const vtz of comp.getAllSubcomponents('vtimezone')) {
    const tz = new ICAL.Timezone(vtz)
    if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz, tz.tzid)
  }

  const out: ParsedVevent[] = []
  for (const v of comp.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(v)
    if (!ev.uid) continue
    if (v.hasProperty('recurrence-id')) continue

    const start = ev.startDate ? resolveTime(ev.startDate, fallbackTz) : null
    if (!start) continue
    const end = ev.endDate ? resolveTime(ev.endDate, fallbackTz) : null

    const status = String(v.getFirstPropertyValue('status') ?? '').toUpperCase()
    const rrule = v.getFirstPropertyValue('rrule')
    const exdates: string[] = []
    for (const prop of v.getAllProperties('exdate')) {
      for (const val of prop.getValues() as ICAL.Time[]) {
        exdates.push(resolveTime(val, start.tz).raw)
      }
    }

    out.push({
      uid: ev.uid,
      summary: ev.summary ?? null,
      description: ev.description ?? null,
      location: ev.location ?? null,
      cancelled: status === 'CANCELLED',
      start,
      end,
      rrule: rrule ? String(rrule) : null,
      exdates,
    })
  }
  return out
}

// ── Sync engine ──────────────────────────────────────────────────────────────

export interface IcsFeedSyncResult {
  feedId: string
  name: string | null
  imported: number
  updated: number
  deleted: number
  error?: string
}

// Upsert one parsed VEVENT, keyed by (origin_ref_id = feed id, google_event_id =
// UID) via uq_events_ics_feed_uid. Feed-owned columns are overwritten on
// re-sync; person_id is seeded from the feed mapping but coalesced so a manual
// per-event reassignment survives (mirroring the Google sync). Returns the
// outcome plus the row id when the event is a recurring master that needs
// materializing.
async function applyVevent(
  client: PoolClient,
  feed: FeedRow,
  ev: ParsedVevent
): Promise<{ outcome: 'imported' | 'updated' | 'deleted'; deletedRows?: number; masterId?: string }> {
  if (ev.cancelled) {
    const res = await client.query(
      `update events set deleted_at = now(), status = 'cancelled', sync_state = 'synced'
        where origin = 'ics' and origin_ref_id = $1 and google_event_id = $2 and deleted_at is null`,
      [feed.id, ev.uid]
    )
    return { outcome: 'deleted', deletedRows: res.rowCount ?? 0 }
  }

  const { rows } = await client.query<{ id: string; rrule: string | null; inserted: boolean }>(
    `insert into events (
       household_id, calendar_id, person_id, origin, origin_ref_id,
       title, description, location,
       starts_at, ends_at, all_day, timezone,
       rrule, exdate,
       status, google_event_id, ical_uid, sync_state,
       visibility, owner_person_id
     ) values (
       $1, null, $2, 'ics', $3,
       $4, $5, $6,
       case when $7 then ($8::text)::timestamp at time zone $9 else ($8::text)::timestamptz end,
       case when $10::text is null then null
            when $7 then ($10::text)::timestamp at time zone $9
            else ($10::text)::timestamptz end,
       $7, $9,
       $11, $12::timestamptz[],
       'confirmed', $13, $13, 'synced',
       $14, $2
     )
     on conflict (origin_ref_id, google_event_id) where origin = 'ics' and google_event_id is not null
     do update set
       title = excluded.title,
       description = excluded.description,
       location = excluded.location,
       starts_at = excluded.starts_at,
       ends_at = excluded.ends_at,
       all_day = excluded.all_day,
       timezone = excluded.timezone,
       rrule = excluded.rrule,
       exdate = excluded.exdate,
       status = excluded.status,
       sync_state = 'synced',
       deleted_at = null,
       person_id = coalesce(events.person_id, excluded.person_id),
       -- visibility/owner follow the feed mapping, so always restamp on re-sync.
       visibility = excluded.visibility,
       owner_person_id = excluded.owner_person_id
     returning id, rrule, (xmax = 0) as inserted`,
    [
      feed.household_id,
      feed.person_id,
      feed.id,
      ev.summary ?? '(untitled)',
      ev.description,
      ev.location,
      ev.start.allDay,
      ev.start.raw,
      ev.start.tz,
      ev.end?.raw ?? null,
      ev.rrule,
      ev.exdates.length ? ev.exdates : null,
      ev.uid,
      feed.visibility,
    ]
  )
  const row = rows[0]
  return {
    outcome: row.inserted ? 'imported' : 'updated',
    masterId: row.rrule ? row.id : undefined,
  }
}

// Fetch + parse + apply one feed. Success stamps last_synced_at and clears
// last_error; any failure (HTTP error, unparsable ICS, DB hiccup) is captured
// into last_error and returned — never thrown, so one bad feed can't abort a
// scheduler pass over the others.
export async function syncIcsFeed(feed: FeedRow): Promise<IcsFeedSyncResult> {
  const res: IcsFeedSyncResult = { feedId: feed.id, name: feed.name, imported: 0, updated: 0, deleted: 0 }
  try {
    const httpRes = await fetch(feed.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'text/calendar, text/plain, */*' },
    })
    if (!httpRes.ok) throw new Error(`feed returned HTTP ${httpRes.status}`)
    const events = parseIcs(await httpRes.text(), feed.household_timezone)

    const masterIds: string[] = []
    const seenUids: string[] = []
    const client = await getPool().connect()
    try {
      await client.query('begin')
      for (const ev of events) {
        seenUids.push(ev.uid)
        const applied = await applyVevent(client, feed, ev)
        if (applied.outcome === 'deleted') res.deleted += applied.deletedRows ?? 0
        else res[applied.outcome]++
        if (applied.masterId) masterIds.push(applied.masterId)
      }
      // Events that vanished from the feed: soft-delete (they may reappear —
      // the upsert resurrects via deleted_at = null).
      const swept = await client.query<{ id: string; rrule: string | null }>(
        `update events set deleted_at = now(), sync_state = 'synced'
          where origin = 'ics' and origin_ref_id = $1 and deleted_at is null
            and not (google_event_id = any($2::text[]))
          returning id, rrule`,
        [feed.id, seenUids]
      )
      res.deleted += swept.rowCount ?? 0
      // Tombstone the materialized occurrences of any swept recurring master.
      const sweptMasters = swept.rows.filter((r) => r.rrule).map((r) => r.id)
      if (sweptMasters.length) {
        await client.query(
          `update event_occurrences set deleted_at = now()
            where event_id = any($1::uuid[]) and deleted_at is null`,
          [sweptMasters]
        )
      }
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }

    // Materialize recurring masters outside the transaction (mirrors events.ts):
    // occurrences appear immediately instead of waiting for the expansion tick.
    for (const id of masterIds) await materializeMaster(id)

    await query(
      `update ics_feeds set last_synced_at = now(), last_error = null where id = $1`,
      [feed.id]
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'sync failed'
    res.error = message
    await query(
      `update ics_feeds set last_error = $2 where id = $1`,
      [feed.id, message.slice(0, 500)]
    )
  }
  return res
}

// The scheduler's unit of work: every non-deleted feed across all households.
// syncIcsFeed never throws, so a failing feed records its error and the pass
// continues.
export async function syncAllIcsFeeds(): Promise<{ feeds: number; errors: number }> {
  const { rows } = await query<FeedRow>(`${FEED_SELECT} order by f.created_at`)
  let errors = 0
  for (const feed of rows) {
    const r = await syncIcsFeed(feed)
    if (r.error) errors++
  }
  return { feeds: rows.length, errors }
}

let icsTimer: ReturnType<typeof setInterval> | null = null

// Background poll (server.ts only). Unlike the OAuth calendar sync this needs no
// provider config or encryption key — a plain URL is the whole credential.
// ICS_SYNC_INTERVAL_MS default 15 min; 0 disables.
export function startIcsSyncScheduler(): void {
  if (icsTimer) return
  const intervalMs = parseInt(process.env.ICS_SYNC_INTERVAL_MS ?? '900000', 10)
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return
  registerJob('ics-sync')
  icsTimer = setInterval(() => {
    runJob('ics-sync', syncAllIcsFeeds).catch((err) => log.error('ics feed sync tick failed', { err }))
  }, intervalMs)
  icsTimer.unref?.()
  log.info('ics feed sync scheduler started', { intervalSec: Math.round(intervalMs / 1000) })
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Normalize + validate a feed URL. webcal:// (how Outlook/Apple hand out ICS
// links) is accepted and rewritten to https://; anything else must be http(s).
function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const candidate = raw.trim().replace(/^webcal:\/\//i, 'https://')
  try {
    const u = new URL(candidate)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

export function registerIcsFeedRoutes(api: Api): void {
  // Every member can see the feed list (the Calendars panel shows it); only
  // admins can change it.
  api.get('/api/calendar/feeds', tenantRoute(async (tenant) => {
    const feeds = await listIcsFeeds(tenant.householdId)
    return { feeds: feeds.map(presentIcsFeed) }
  }))

  api.post('/api/calendar/feeds', adminRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { url?: unknown; name?: unknown; personId?: unknown; visibility?: unknown }
    const url = normalizeUrl(body.url)
    if (!url) {
      return res.status(400).json({ error: 'BadRequest', message: 'url must be a valid http(s) URL' })
    }
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null
    const personId = typeof body.personId === 'string' && UUID_RE.test(body.personId) ? body.personId : null
    const visibility = body.visibility ?? 'family'
    if (visibility !== 'family' && visibility !== 'personal') {
      return res.status(400).json({ error: 'BadRequest', message: "visibility must be 'family' or 'personal'" })
    }
    const ins = await query<{ id: string }>(
      `insert into ics_feeds (household_id, url, name, person_id, visibility)
       values ($1,$2,$3,$4,$5) returning id`,
      [tenant.householdId, url, name, personId, visibility]
    )
    const feed = await getFeed(tenant.householdId, ins.rows[0].id)
    return res.status(201).json({ feed: feed ? presentIcsFeed(feed) : null })
  }))

  api.patch('/api/calendar/feeds/:id', adminRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'feed not found' })
    const body = (req.body ?? {}) as { url?: unknown; name?: unknown; personId?: unknown; visibility?: unknown }

    const sets: string[] = []
    const values: unknown[] = []
    let i = 1
    if ('url' in body) {
      const url = normalizeUrl(body.url)
      if (!url) return res.status(400).json({ error: 'BadRequest', message: 'url must be a valid http(s) URL' })
      sets.push(`url = $${i++}`)
      values.push(url)
    }
    if ('name' in body) {
      sets.push(`name = $${i++}`)
      values.push(typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null)
    }
    if ('personId' in body) {
      const personId = typeof body.personId === 'string' && UUID_RE.test(body.personId) ? body.personId : null
      sets.push(`person_id = $${i++}`)
      values.push(personId)
    }
    if ('visibility' in body) {
      if (body.visibility !== 'family' && body.visibility !== 'personal') {
        return res.status(400).json({ error: 'BadRequest', message: "visibility must be 'family' or 'personal'" })
      }
      sets.push(`visibility = $${i++}`)
      values.push(body.visibility)
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'url, name, personId, or visibility required' })
    }
    values.push(tenant.householdId, id)
    const { rowCount } = await query(
      `update ics_feeds set ${sets.join(', ')}
        where household_id = $${i++} and id = $${i} and deleted_at is null`,
      values
    )
    if (!rowCount) return res.status(404).json({ error: 'NotFound', message: 'feed not found' })

    const feed = await getFeed(tenant.householdId, id)
    // Re-stamp the denormalized visibility/owner onto the feed's events (and
    // their materialized occurrences) so the personal/family filter is correct
    // immediately, mirroring the calendar-mapping PATCH in calendars.ts.
    if (feed && ('visibility' in body || 'personId' in body)) {
      await query(
        `update events set visibility = $1, owner_person_id = $2
          where household_id = $3 and origin = 'ics' and origin_ref_id = $4 and deleted_at is null`,
        [feed.visibility, feed.person_id, tenant.householdId, id]
      )
      await query(
        `update event_occurrences o set visibility = $1, owner_person_id = $2
           from events e
          where o.event_id = e.id and e.origin = 'ics' and e.origin_ref_id = $3
            and o.household_id = $4 and o.deleted_at is null`,
        [feed.visibility, feed.person_id, id, tenant.householdId]
      )
    }
    return { feed: feed ? presentIcsFeed(feed) : null }
  }))

  // Remove a feed: soft-delete it AND its imported events (unlike disconnecting
  // an OAuth account, feed events have no life of their own — the feed is their
  // only source, so they go with it).
  api.delete('/api/calendar/feeds/:id', adminRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'feed not found' })
    const { rowCount } = await query(
      `update ics_feeds set deleted_at = now()
        where id = $1 and household_id = $2 and deleted_at is null`,
      [id, tenant.householdId]
    )
    if (!rowCount) return res.status(404).json({ error: 'NotFound', message: 'feed not found' })
    const swept = await query<{ id: string }>(
      `update events set deleted_at = now()
        where household_id = $1 and origin = 'ics' and origin_ref_id = $2 and deleted_at is null
        returning id`,
      [tenant.householdId, id]
    )
    if (swept.rows.length) {
      await query(
        `update event_occurrences set deleted_at = now()
          where event_id = any($1::uuid[]) and deleted_at is null`,
        [swept.rows.map((r) => r.id)]
      )
    }
    return res.status(204).send('')
  }))

  // Poll one feed right now (the panel's per-feed "Sync" action + the smoke test).
  api.post('/api/calendar/feeds/:id/sync', adminRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'feed not found' })
    const feed = await getFeed(tenant.householdId, id)
    if (!feed) return res.status(404).json({ error: 'NotFound', message: 'feed not found' })
    return syncIcsFeed(feed)
  }))
}

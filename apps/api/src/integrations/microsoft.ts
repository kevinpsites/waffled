// Microsoft OAuth + Graph calendar — thin fetch wrappers mirroring
// integrations/google.ts. Everything is normalized into the SAME shapes the
// Google wrappers return (GoogleTokens/GoogleEvent/EventsPage/…) so the sync
// engine stays provider-agnostic; see modules/calendar/providers/.
//
// Graph specifics worth knowing:
// - Refresh tokens ROTATE: every refresh may return a new refresh_token, which
//   the caller must persist (Google's never rotate).
// - Incremental sync is /calendarView/delta: instances are pre-expanded within
//   a window (like Google's singleEvents), deletions arrive as `@removed`
//   tombstones, paging via @odata.nextLink, and the cursor is the FULL
//   @odata.deltaLink URL (stored verbatim in calendars.sync_token). A stale
//   cursor is HTTP 410 — same contract as Google, mapped to SyncTokenInvalidError.
// - start/end come as zone-less wall time plus a timeZone field; we pin the
//   response zone to UTC via a Prefer header and emit `...Z` instants.
import { config } from '../platform/config'
import {
  SyncTokenInvalidError,
  type GoogleTokens,
  type GoogleUserinfo,
  type GoogleCalendarListEntry,
  type GoogleEvent,
  type GoogleEventWrite,
  type GoogleWriteResult,
  type EventsPage,
  type ListEventsParams,
} from './google'

const PAGE_SIZE = 50

export function microsoftConfigured(): boolean {
  const m = config.microsoft
  return !!(m.clientId && m.clientSecret && m.redirectUri)
}

export function buildAuthUrl(state: string): string {
  const m = config.microsoft
  const params = new URLSearchParams({
    client_id: m.clientId ?? '',
    redirect_uri: m.redirectUri ?? '',
    response_type: 'code',
    response_mode: 'query',
    scope: m.scopes,
    prompt: 'select_account',
    state,
  })
  return `${m.authUrl}?${params.toString()}`
}

async function postForm(url: string, form: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text().catch(() => '')}`)
  return res.json()
}

interface MsTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope: string
  id_token?: string
}

export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const m = config.microsoft
  const data = (await postForm(m.tokenUrl, {
    code,
    client_id: m.clientId ?? '',
    client_secret: m.clientSecret ?? '',
    redirect_uri: m.redirectUri ?? '',
    grant_type: 'authorization_code',
    scope: m.scopes,
  })) as MsTokenResponse
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scope: data.scope,
    idToken: data.id_token ?? null,
  }
}

// NOTE: unlike Google, the response usually carries a NEW refresh token — the
// caller must persist it (see the rotation handling in calendar-sync.service.ts).
export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  const m = config.microsoft
  const data = (await postForm(m.tokenUrl, {
    refresh_token: refreshToken,
    client_id: m.clientId ?? '',
    client_secret: m.clientSecret ?? '',
    grant_type: 'refresh_token',
    scope: m.scopes,
  })) as MsTokenResponse
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scope: data.scope,
    idToken: data.id_token ?? null,
  }
}

async function graphGet<T>(accessToken: string, url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, ...headers } })
  if (res.status === 410) throw new SyncTokenInvalidError('Graph delta token is no longer valid')
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${await res.text().catch(() => '')}`)
  return (await res.json()) as T
}

// /me — identity for the connected account. `id` plays Google's `sub` role.
export async function fetchUserinfo(accessToken: string): Promise<GoogleUserinfo> {
  const data = await graphGet<{ id: string; mail?: string | null; userPrincipalName?: string | null }>(
    accessToken,
    `${config.microsoft.graphBase}/me`
  )
  return { sub: data.id, email: data.mail ?? data.userPrincipalName ?? null }
}

export async function listCalendars(accessToken: string): Promise<GoogleCalendarListEntry[]> {
  const data = await graphGet<{ value?: Array<Record<string, unknown>> }>(
    accessToken,
    `${config.microsoft.graphBase}/me/calendars?$top=100`
  )
  return (data.value ?? []).map((c) => ({
    id: String(c.id),
    summary: (c.name as string | undefined) ?? null,
    description: null,
    timeZone: null, // Graph calendars don't carry a zone; events bring their own
    // Map into the Google role vocabulary the schema/write-target logic expects.
    accessRole: c.canEdit ? 'writer' : 'reader',
    backgroundColor: (c.hexColor as string | undefined) || null,
    primary: !!c.isDefaultCalendar,
  }))
}

// Graph wall-time + zone → the GoogleEventDateTime shape. With the Prefer
// header pinning responses to UTC, a timed instant becomes `${wallTime}Z`.
function toDateTime(v: { dateTime?: string; timeZone?: string } | undefined, allDay: boolean) {
  if (!v?.dateTime) return null
  if (allDay) return { date: v.dateTime.slice(0, 10), dateTime: null, timeZone: v.timeZone ?? null }
  const wall = v.dateTime.replace(/(\.\d+)?$/, '') // trim fractional seconds
  const zone = v.timeZone ?? 'UTC'
  return {
    date: null,
    dateTime: zone === 'UTC' ? `${wall}Z` : wall, // non-UTC shouldn't happen (Prefer header)
    timeZone: zone,
  }
}

function toEvent(e: Record<string, unknown>): GoogleEvent {
  // Deletion tombstone: `{ id, "@removed": { reason } }` with nothing else.
  if (e['@removed']) {
    return {
      id: String(e.id),
      status: 'cancelled',
      summary: null,
      description: null,
      location: null,
      start: null,
      end: null,
      iCalUID: null,
      etag: null,
      sequence: null,
      updated: null,
    }
  }
  const allDay = !!e.isAllDay
  const loc = e.location as { displayName?: string } | undefined
  return {
    id: String(e.id),
    status: e.isCancelled ? 'cancelled' : 'confirmed',
    summary: (e.subject as string | undefined) ?? null,
    description: (e.bodyPreview as string | undefined) || null,
    location: loc?.displayName || null,
    start: toDateTime(e.start as { dateTime?: string; timeZone?: string } | undefined, allDay),
    end: toDateTime(e.end as { dateTime?: string; timeZone?: string } | undefined, allDay),
    iCalUID: (e.iCalUId as string | undefined) ?? null,
    etag: (e.changeKey as string | undefined) ?? null,
    sequence: null, // Graph has no sequence counter
    updated: (e.lastModifiedDateTime as string | undefined) ?? null,
  }
}

// One page of a calendar's delta. First run builds the initial calendarView
// window; afterwards the stored deltaLink / nextLink are complete URLs.
export async function listEventsPage(
  accessToken: string,
  calendarId: string,
  params: ListEventsParams
): Promise<EventsPage> {
  let url: string
  if (params.pageToken) {
    url = params.pageToken
  } else if (params.syncToken) {
    url = params.syncToken
  } else {
    const qs = new URLSearchParams({
      startDateTime: params.timeMin ?? new Date().toISOString(),
      endDateTime: params.timeMax ?? new Date().toISOString(),
    })
    url = `${config.microsoft.graphBase}/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?${qs.toString()}`
  }
  const data = await graphGet<{
    value?: Array<Record<string, unknown>>
    '@odata.nextLink'?: string
    '@odata.deltaLink'?: string
  }>(accessToken, url, {
    prefer: `odata.maxpagesize=${PAGE_SIZE}, outlook.timezone="UTC"`,
  })
  return {
    events: (data.value ?? []).map(toEvent),
    nextPageToken: data['@odata.nextLink'] ?? null,
    nextSyncToken: data['@odata.deltaLink'] ?? null,
  }
}

// ── Event write-back ───────────────────────────────────────────────────────────

// GoogleEventWrite → the Graph event body. All-day events are midnight-to-
// midnight wall times with isAllDay (Graph's exclusive end matches Google's).
function toGraphBody(body: GoogleEventWrite): Record<string, unknown> {
  const allDay = !!body.start.date
  const start = allDay
    ? { dateTime: `${body.start.date}T00:00:00`, timeZone: body.start.timeZone ?? 'UTC' }
    : { dateTime: (body.start.dateTime ?? '').replace(/(\.\d+)?Z$/, ''), timeZone: 'UTC' }
  const end = allDay
    ? { dateTime: `${body.end.date}T00:00:00`, timeZone: body.end.timeZone ?? 'UTC' }
    : { dateTime: (body.end.dateTime ?? '').replace(/(\.\d+)?Z$/, ''), timeZone: 'UTC' }
  return {
    subject: body.summary,
    body: { contentType: 'text', content: body.description ?? '' },
    location: body.location ? { displayName: body.location } : null,
    start,
    end,
    isAllDay: allDay,
  }
}

function toWriteResult(data: Record<string, unknown>): GoogleWriteResult {
  return {
    id: String(data.id),
    etag: (data.changeKey as string | undefined) ?? null,
    sequence: null,
    updated: (data.lastModifiedDateTime as string | undefined) ?? null,
  }
}

async function writeJson(method: string, url: string, accessToken: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text().catch(() => '')}`)
  return (await res.json()) as Record<string, unknown>
}

export async function insertEvent(accessToken: string, calendarId: string, body: GoogleEventWrite): Promise<GoogleWriteResult> {
  const url = `${config.microsoft.graphBase}/me/calendars/${encodeURIComponent(calendarId)}/events`
  return toWriteResult(await writeJson('POST', url, accessToken, toGraphBody(body)))
}

export async function patchEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  body: GoogleEventWrite
): Promise<GoogleWriteResult> {
  const url = `${config.microsoft.graphBase}/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
  return toWriteResult(await writeJson('PATCH', url, accessToken, toGraphBody(body)))
}

// Delete tolerates 404/410 (already gone) as success — idempotent, like Google.
export async function deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  const url = `${config.microsoft.graphBase}/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
  const res = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${accessToken}` } })
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`DELETE ${url} -> ${res.status} ${await res.text().catch(() => '')}`)
  }
}

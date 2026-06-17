// Google OAuth + Calendar API — thin fetch wrappers (no googleapis dependency).
// Endpoint URLs come from config so tests can point them at an in-process stub.
// Used by the calendar connect flow (5.2) and, later, inbound/outbound sync (5.3/5.4).
import { config } from '../platform/config'

export interface GoogleTokens {
  accessToken: string
  refreshToken: string | null // only returned on first consent (we force it with prompt=consent)
  expiresIn: number
  scope: string
  idToken: string | null
}

export interface GoogleUserinfo {
  sub: string
  email: string | null
}

export interface GoogleCalendarListEntry {
  id: string
  summary: string | null
  description: string | null
  timeZone: string | null
  accessRole: string | null
  backgroundColor: string | null
  primary: boolean
}

// One end of a Google event. All-day events carry `date` (YYYY-MM-DD); timed
// events carry `dateTime` (RFC3339, usually with an offset) + an optional zone.
export interface GoogleEventDateTime {
  date: string | null
  dateTime: string | null
  timeZone: string | null
}

export interface GoogleEvent {
  id: string
  status: string | null // confirmed | tentative | cancelled
  summary: string | null
  description: string | null
  location: string | null
  start: GoogleEventDateTime | null
  end: GoogleEventDateTime | null
  iCalUID: string | null
  etag: string | null
  sequence: number | null
  updated: string | null // RFC3339, Google's last-modified
}

export interface EventsPage {
  events: GoogleEvent[]
  nextPageToken: string | null
  // Only present on the final page of a sync; the cursor for the next sync.
  nextSyncToken: string | null
}

// Thrown when Google rejects a stored sync token (HTTP 410). The caller must
// drop the token and do a fresh full-window sync.
export class SyncTokenInvalidError extends Error {
  constructor(message = 'Google sync token is no longer valid') {
    super(message)
    this.name = 'SyncTokenInvalidError'
  }
}

export interface ListEventsParams {
  // Incremental: pass the stored cursor and Google returns only what changed.
  syncToken?: string | null
  // Full sync window (ignored when syncToken is set).
  timeMin?: string | null
  timeMax?: string | null
  pageToken?: string | null
}

function toDateTime(v: Record<string, unknown> | null | undefined): GoogleEventDateTime | null {
  if (!v) return null
  return {
    date: (v.date as string | undefined) ?? null,
    dateTime: (v.dateTime as string | undefined) ?? null,
    timeZone: (v.timeZone as string | undefined) ?? null,
  }
}

// One page of a calendar's events. We always expand recurrences (singleEvents)
// and ask for deletions (showDeleted) so cancellations come back as tombstones;
// both must stay constant across an incremental series or Google 410s the token.
export async function listEventsPage(
  accessToken: string,
  calendarId: string,
  params: ListEventsParams
): Promise<EventsPage> {
  const qs = new URLSearchParams({
    singleEvents: 'true',
    showDeleted: 'true',
    maxResults: '250',
  })
  if (params.syncToken) {
    qs.set('syncToken', params.syncToken)
  } else {
    if (params.timeMin) qs.set('timeMin', params.timeMin)
    if (params.timeMax) qs.set('timeMax', params.timeMax)
  }
  if (params.pageToken) qs.set('pageToken', params.pageToken)

  const url = `${config.google.apiBase}/calendars/${encodeURIComponent(calendarId)}/events?${qs.toString()}`
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } })
  if (res.status === 410) throw new SyncTokenInvalidError()
  if (!res.ok) throw new Error(`events.list -> ${res.status} ${await res.text().catch(() => '')}`)
  const data = (await res.json()) as {
    items?: Array<Record<string, unknown>>
    nextPageToken?: string
    nextSyncToken?: string
  }
  return {
    events: (data.items ?? []).map((e) => ({
      id: String(e.id),
      status: (e.status as string | undefined) ?? null,
      summary: (e.summary as string | undefined) ?? null,
      description: (e.description as string | undefined) ?? null,
      location: (e.location as string | undefined) ?? null,
      start: toDateTime(e.start as Record<string, unknown> | undefined),
      end: toDateTime(e.end as Record<string, unknown> | undefined),
      iCalUID: (e.iCalUID as string | undefined) ?? null,
      etag: (e.etag as string | undefined) ?? null,
      sequence: typeof e.sequence === 'number' ? e.sequence : null,
      updated: (e.updated as string | undefined) ?? null,
    })),
    nextPageToken: data.nextPageToken ?? null,
    nextSyncToken: data.nextSyncToken ?? null,
  }
}

// True only when the OAuth client is fully configured. The connect route reports a
// clear 501 otherwise, rather than bouncing the user to a broken Google screen.
export function googleConfigured(): boolean {
  const g = config.google
  return !!(g.clientId && g.clientSecret && g.redirectUri)
}

// The consent URL the browser is sent to. access_type=offline + prompt=consent
// guarantee a refresh_token every time (Google otherwise omits it on re-grant).
export function buildAuthUrl(state: string): string {
  const g = config.google
  const params = new URLSearchParams({
    client_id: g.clientId ?? '',
    redirect_uri: g.redirectUri ?? '',
    response_type: 'code',
    scope: g.scopes,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  })
  return `${g.authUrl}?${params.toString()}`
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

export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const g = config.google
  const data = (await postForm(g.tokenUrl, {
    code,
    client_id: g.clientId ?? '',
    client_secret: g.clientSecret ?? '',
    redirect_uri: g.redirectUri ?? '',
    grant_type: 'authorization_code',
  })) as { access_token: string; refresh_token?: string; expires_in: number; scope: string; id_token?: string }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scope: data.scope,
    idToken: data.id_token ?? null,
  }
}

// Trade a stored refresh token for a fresh access token (used by 5.3/5.4 sync).
export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  const g = config.google
  const data = (await postForm(g.tokenUrl, {
    refresh_token: refreshToken,
    client_id: g.clientId ?? '',
    client_secret: g.clientSecret ?? '',
    grant_type: 'refresh_token',
  })) as { access_token: string; expires_in: number; scope: string; id_token?: string }
  return {
    accessToken: data.access_token,
    refreshToken: null,
    expiresIn: data.expires_in,
    scope: data.scope,
    idToken: data.id_token ?? null,
  }
}

export async function fetchUserinfo(accessToken: string): Promise<GoogleUserinfo> {
  const res = await fetch(config.google.userinfoUrl, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`userinfo -> ${res.status} ${await res.text().catch(() => '')}`)
  const data = (await res.json()) as { sub: string; email?: string }
  return { sub: data.sub, email: data.email ?? null }
}

export async function listCalendars(accessToken: string): Promise<GoogleCalendarListEntry[]> {
  const res = await fetch(`${config.google.apiBase}/users/me/calendarList`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`calendarList -> ${res.status} ${await res.text().catch(() => '')}`)
  const data = (await res.json()) as { items?: Array<Record<string, unknown>> }
  return (data.items ?? []).map((c) => ({
    id: String(c.id),
    summary: (c.summary as string | undefined) ?? null,
    description: (c.description as string | undefined) ?? null,
    timeZone: (c.timeZone as string | undefined) ?? null,
    accessRole: (c.accessRole as string | undefined) ?? null,
    backgroundColor: (c.backgroundColor as string | undefined) ?? null,
    primary: !!c.primary,
  }))
}

// ── Event write-back (5.4) ─────────────────────────────────────────────────────

// The Google event shape we send when creating/updating. Mirrors the read side:
// all-day events use { date }, timed events use { dateTime, timeZone }.
export interface GoogleEventWrite {
  summary: string
  description?: string | null
  location?: string | null
  start: { date?: string; dateTime?: string; timeZone?: string }
  end: { date?: string; dateTime?: string; timeZone?: string }
}

// What the API returns for a written event — enough to track + reconcile it.
export interface GoogleWriteResult {
  id: string
  etag: string | null
  sequence: number | null
  updated: string | null
}

function toWriteResult(data: Record<string, unknown>): GoogleWriteResult {
  return {
    id: String(data.id),
    etag: (data.etag as string | undefined) ?? null,
    sequence: typeof data.sequence === 'number' ? data.sequence : null,
    updated: (data.updated as string | undefined) ?? null,
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
  const url = `${config.google.apiBase}/calendars/${encodeURIComponent(calendarId)}/events`
  return toWriteResult(await writeJson('POST', url, accessToken, body))
}

export async function patchEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  body: GoogleEventWrite
): Promise<GoogleWriteResult> {
  const url = `${config.google.apiBase}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
  return toWriteResult(await writeJson('PATCH', url, accessToken, body))
}

// Delete tolerates 404/410 (already gone on Google) as success — idempotent.
export async function deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  const url = `${config.google.apiBase}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
  const res = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${accessToken}` } })
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`DELETE ${url} -> ${res.status} ${await res.text().catch(() => '')}`)
  }
}

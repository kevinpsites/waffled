// Google OAuth + Calendar API — thin fetch wrappers (no googleapis dependency).
// Endpoint URLs come from config so tests can point them at an in-process stub.
// Used by the calendar connect flow (5.2) and, later, inbound/outbound sync (5.3/5.4).
import { config } from './config'

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

// Calendar provider abstraction (fork). The sync engine and connect flow talk
// to this interface; google.provider.ts / microsoft.provider.ts wrap the thin
// fetch modules in integrations/. The shapes are the ones integrations/google.ts
// already defined — they were provider-neutral in all but name, so Microsoft
// normalizes into them rather than duplicating a parallel type family.
import type {
  GoogleTokens,
  GoogleUserinfo,
  GoogleCalendarListEntry,
  GoogleEventWrite,
  GoogleWriteResult,
  EventsPage,
  ListEventsParams,
} from '../../../integrations/google'
export { SyncTokenInvalidError } from '../../../integrations/google'

export type CalendarProviderName = 'google' | 'microsoft'

export interface CalendarProviderAdapter {
  name: CalendarProviderName
  /** events.origin value stamped on rows imported from this provider. */
  origin: string
  /** Whether refresh tokens rotate on every refresh (Microsoft) — when true the
   *  sync engine re-encrypts and persists the replacement token. */
  rotatingRefreshTokens: boolean
  configured(): boolean
  buildAuthUrl(state: string): string
  exchangeCode(code: string): Promise<GoogleTokens>
  refreshAccessToken(refreshToken: string): Promise<GoogleTokens>
  fetchUserinfo(accessToken: string): Promise<GoogleUserinfo>
  listCalendars(accessToken: string): Promise<GoogleCalendarListEntry[]>
  listEventsPage(accessToken: string, calendarId: string, params: ListEventsParams): Promise<EventsPage>
  insertEvent(accessToken: string, calendarId: string, body: GoogleEventWrite): Promise<GoogleWriteResult>
  patchEvent(accessToken: string, calendarId: string, eventId: string, body: GoogleEventWrite): Promise<GoogleWriteResult>
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>
}

import { googleProvider } from './google.provider'
import { microsoftProvider } from './microsoft.provider'

const REGISTRY: Record<CalendarProviderName, CalendarProviderAdapter> = {
  google: googleProvider,
  microsoft: microsoftProvider,
}

/** Adapter for a stored provider name; unknown values fall back to Google so
 *  pre-migration rows (all Google) keep working even if the column is odd. */
export function providerFor(name: string | null | undefined): CalendarProviderAdapter {
  return REGISTRY[(name as CalendarProviderName) ?? 'google'] ?? REGISTRY.google
}

export function isProviderName(v: string): v is CalendarProviderName {
  return v === 'google' || v === 'microsoft'
}

/** True when at least one calendar provider has OAuth credentials configured. */
export function anyProviderConfigured(): boolean {
  return Object.values(REGISTRY).some((p) => p.configured())
}

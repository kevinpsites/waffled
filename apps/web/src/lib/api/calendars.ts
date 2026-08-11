// Google Calendar connect + inbound sync — client slice for the Settings UI.
// Wraps the M5.2 connect/status/map endpoints and the M5.3 on-demand sync.
import { apiGet, apiSend, apiDelete } from './client'

export interface CalendarAccount {
  id: string
  email: string | null
  googleSub: string
  provider: 'google' | 'microsoft'
  scope: string | null
  connectedAt: string
  lastSyncError: string | null
  lastSyncErrorAt: string | null
}

export interface CalendarLink {
  id: string
  accountId: string
  googleCalendarId: string
  summary: string | null
  timezone: string | null
  accessRole: string | null
  colorHex: string | null
  isPrimary: boolean
  selected: boolean
  isWriteTarget: boolean
  visibility: string // 'family' (shows on the shared kiosk) | 'personal' (owner-only)
  personId: string | null
  personName: string | null
  personColor: string | null
  lastSyncedAt: string | null
}

// A read-only ICS feed subscription: any published .ics URL polled on an
// interval — the no-OAuth calendar source.
export interface IcsFeed {
  id: string
  url: string
  name: string | null
  personId: string | null
  personName: string | null
  personColor: string | null
  visibility: string // 'family' | 'personal'
  lastSyncedAt: string | null
  lastError: string | null
  createdAt: string
}

export interface IcsFeedSyncResult {
  feedId: string
  name: string | null
  imported: number
  updated: number
  deleted: number
  error?: string
}

export interface CalendarStatus {
  configured: boolean
  /** Whether Microsoft OAuth is configured server-side (drives the Outlook button). */
  microsoftConfigured?: boolean
  connected: boolean
  accounts: CalendarAccount[]
  calendars: CalendarLink[]
  feeds?: IcsFeed[]
}

export interface CalendarSyncCalendarResult {
  calendarId: string
  summary: string | null
  imported: number
  updated: number
  deleted: number
  fullResync: boolean
  error?: string
}

export interface CalendarSyncResult {
  calendars: CalendarSyncCalendarResult[]
  imported: number
  updated: number
  deleted: number
}

export const calendarsApi = {
  calendarStatus: () => apiGet<CalendarStatus>('/api/calendar/google/status'),
  // Returns the Google consent URL; pass where Google should send the browser back
  // to (the api callback redirects there after storing the connection).
  connectCalendar: (redirectTo?: string) =>
    apiSend<{ url: string }>('POST', '/api/calendar/google/connect', redirectTo ? { redirectTo } : {}),
  // Same flow for an Outlook / Microsoft 365 account.
  connectMicrosoftCalendar: (redirectTo?: string) =>
    apiSend<{ url: string }>('POST', '/api/calendar/microsoft/connect', redirectTo ? { redirectTo } : {}),
  updateCalendar: (id: string, patch: { personId?: string | null; selected?: boolean; isWriteTarget?: boolean; visibility?: 'family' | 'personal' }) =>
    apiSend<{ calendar: CalendarLink }>('PATCH', `/api/calendar/google/calendars/${id}`, patch),
  disconnectAccount: (accountId: string) => apiDelete(`/api/calendar/google/accounts/${accountId}`),
  syncCalendars: (calendarId?: string) =>
    apiSend<CalendarSyncResult>('POST', '/api/calendar/sync', calendarId ? { calendarId } : {}),
  // ICS feed subscriptions (admins manage; any member may list).
  listFeeds: () => apiGet<{ feeds: IcsFeed[] }>('/api/calendar/feeds'),
  addFeed: (input: { url: string; name?: string; personId?: string | null; visibility?: 'family' | 'personal' }) =>
    apiSend<{ feed: IcsFeed }>('POST', '/api/calendar/feeds', input),
  updateFeed: (id: string, patch: { url?: string; name?: string | null; personId?: string | null; visibility?: 'family' | 'personal' }) =>
    apiSend<{ feed: IcsFeed }>('PATCH', `/api/calendar/feeds/${id}`, patch),
  removeFeed: (id: string) => apiDelete(`/api/calendar/feeds/${id}`),
  syncFeed: (id: string) => apiSend<IcsFeedSyncResult>('POST', `/api/calendar/feeds/${id}/sync`, {}),
}

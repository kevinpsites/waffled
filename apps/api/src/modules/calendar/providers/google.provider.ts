// Google adapter — a pass-through over integrations/google.ts (kept untouched
// to minimize upstream drift; see provider.ts for the interface).
import * as g from '../../../integrations/google'
import type { CalendarProviderAdapter } from './provider'

export const googleProvider: CalendarProviderAdapter = {
  name: 'google',
  origin: 'google',
  rotatingRefreshTokens: false,
  configured: g.googleConfigured,
  buildAuthUrl: g.buildAuthUrl,
  exchangeCode: g.exchangeCode,
  refreshAccessToken: g.refreshAccessToken,
  fetchUserinfo: g.fetchUserinfo,
  listCalendars: g.listCalendars,
  listEventsPage: g.listEventsPage,
  insertEvent: g.insertEvent,
  patchEvent: g.patchEvent,
  deleteEvent: g.deleteEvent,
}

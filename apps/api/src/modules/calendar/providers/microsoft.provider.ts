// Microsoft (Outlook / Graph) adapter — wraps integrations/microsoft.ts.
// Rows imported from Graph get origin='outlook'; refresh tokens rotate.
import * as m from '../../../integrations/microsoft'
import type { CalendarProviderAdapter } from './provider'

export const microsoftProvider: CalendarProviderAdapter = {
  name: 'microsoft',
  origin: 'outlook',
  rotatingRefreshTokens: true,
  configured: m.microsoftConfigured,
  buildAuthUrl: m.buildAuthUrl,
  exchangeCode: m.exchangeCode,
  refreshAccessToken: m.refreshAccessToken,
  fetchUserinfo: m.fetchUserinfo,
  listCalendars: m.listCalendars,
  listEventsPage: m.listEventsPage,
  insertEvent: m.insertEvent,
  patchEvent: m.patchEvent,
  deleteEvent: m.deleteEvent,
}

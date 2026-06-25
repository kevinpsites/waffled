// Calendar — Google sync routes (/api/calendar/sync). Sync engines live in
// calendar-sync.service.ts; types in calendar-sync.types.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { tenantRoute } from '../../platform/route-guards'
import { encryptionAvailable } from '../../platform/crypto'
import { googleConfigured } from '../../integrations/google'
import { pushPending, syncHousehold } from './calendar-sync.service'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerCalendarSyncRoutes(api: Api): void {
  // Pull connected calendars now. Any household member can refresh; the work is
  // read-from-Google + mirror, gated only on the connection being configured.
  api.post('/api/calendar/sync', tenantRoute(async (tenant, req: Request, res: Response) => {
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
  }))
}

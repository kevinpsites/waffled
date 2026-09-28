import type createAPI from 'lambda-api'
import { moduleRoutes } from '../../../platform/route-guards'

type Api = ReturnType<typeof createAPI>

// Step 2 · Calendar — DELIBERATELY REGISTERS NOTHING. The step frames the week the session is
// planning, and the week is the real calendar: it reads `GET /api/events?from&to` and adds
// through the app's own event modal. A `/api/weekly-planning/calendar` mirror of those would be
// a second door onto the same rows, and the two would drift.
//
// This registrar stays so that if the step ever does need a read of its own, it lands here
// rather than in weeklyPlanning.routes.ts — gated with these guards, behind the module toggle.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { tenantRoute, adminRoute } = moduleRoutes('weeklyPlanning')

export function registerCalendarStepRoutes(_api: Api): void {
  // Nothing — see above.
}

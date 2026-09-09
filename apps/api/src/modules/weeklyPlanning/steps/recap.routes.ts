import type createAPI from 'lambda-api'
import type { Request } from 'lambda-api'
import { moduleRoutes } from '../../../platform/route-guards'
import { resolveWeekStart, getSessionById } from '../weeklyPlanning'
import { getRecap } from './recap'

type Api = ReturnType<typeof createAPI>

// Step 10 · Recap — ONE read, and it writes nothing at all. Saving the week is the SHELL's
// `POST /session/:id/complete`, and every line the recap shows is already live in the module
// that owns it; a write here would be a second copy of somebody else's decision.
//
// GATED ONCE, like step 9: `recap` has no `requiresModule` because it reads ACROSS the modules,
// so the routes carry the weeklyPlanning gate only and the service contributes no group for a
// module that is off.
//
// WHICH WEEK: when a session is named, its OWN `week_start` decides — not the query string and
// not the default — or the last screen of the session would read back a week nobody planned.
// `?weekStart=` still resolves the sessionless read, through `resolveWeekStart`.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null)

export function registerRecapStepRoutes(api: Api): void {
  api.get('/api/weekly-planning/recap', tenantRoute(async (tenant, req: Request) => {
    const sessionId = uuidOrNull(req.query?.sessionId)
    // Household-scoped: a session id from somewhere else must resolve to no session at all
    // rather than to another family's week.
    const session = sessionId ? await getSessionById(tenant.householdId, sessionId) : null
    const weekStart = session?.weekStart ?? (await resolveWeekStart(tenant.householdId, req.query?.weekStart))
    return getRecap(tenant, weekStart, session)
  }))
}

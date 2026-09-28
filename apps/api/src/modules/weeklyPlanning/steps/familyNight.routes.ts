import type createAPI from 'lambda-api'
import type { Request } from 'lambda-api'
import { moduleRoutes, requireModule } from '../../../platform/route-guards'
import { resolveWeekStart } from '../weeklyPlanning'
import { getFamilyNightBoard } from './familyNight'

type Api = ReturnType<typeof createAPI>

// Step 4 · Family night — read-only on purpose. Pinning a face, naming the theme and
// calling the week off all go to POST /api/family-night/occurrence, which the module
// already ships; a second write path would be a second place for "who's on the treat"
// to be true.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

export function registerFamilyNightStepRoutes(api: Api): void {
  // The board: the gathering inside the week being planned, its theme and status, and
  // each part's suggested-or-pinned person.
  //
  // requiresModule 'familyNight' in the catalog only decides whether the session SHOWS the
  // step — it doesn't guard the endpoint, so assert the module here too. `?weekStart=` goes
  // through the shell's resolveWeekStart so the week boundary stays server-owned.
  api.get('/api/weekly-planning/familyNight', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'familyNight')
    const weekStart = await resolveWeekStart(tenant.householdId, req.query?.weekStart)
    return getFamilyNightBoard(tenant.householdId, weekStart)
  }))
}
